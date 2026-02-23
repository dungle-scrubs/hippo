import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbStatements } from "../db.js";
import { prepareStatements } from "../db.js";
import { initSchema } from "../schema.js";
import { embeddingToBuffer } from "../similarity.js";
import type { Chunk, EmbedFn, LlmClient } from "../types.js";
import { ulid } from "../ulid.js";
import { createRememberFactsTool } from "./remember-facts.js";

const AGENT_ID = "test-agent";

/** Fixed embedding for testing — all results will have similarity 1.0 with each other. */
const FIXED_EMBED = new Float32Array([1, 0, 0, 0]);

/** Different embedding — orthogonal, similarity 0.0 with FIXED_EMBED. */
const DIFFERENT_EMBED = new Float32Array([0, 1, 0, 0]);

/**
 * Mock LLM that extracts facts from a canned extraction response.
 *
 * @param extractionResponse - JSON response for fact extraction
 * @param classificationResponse - Response for conflict classification
 */
function mockLlm(extractionResponse: string, classificationResponse = "DISTINCT"): LlmClient {
	let callCount = 0;
	return {
		complete: vi.fn(async () => {
			callCount++;
			// First call is extraction, subsequent are classification
			return callCount === 1 ? extractionResponse : classificationResponse;
		}),
	};
}

/** Insert a fact chunk directly for setup. */
function insertFact(stmts: DbStatements, content: string, embedding: Float32Array): string {
	const id = ulid();
	const now = new Date().toISOString();
	stmts.insertChunk.run({
		access_count: 0,
		agent_id: AGENT_ID,
		content,
		content_hash: null,
		created_at: now,
		embedding: embeddingToBuffer(embedding),
		encounter_count: 1,
		id,
		kind: "fact",
		last_accessed_at: now,
		metadata: null,
		running_intensity: 0.5,
	});
	return id;
}

describe("remember_facts", () => {
	let db: Database.Database;
	let stmts: DbStatements;

	beforeEach(() => {
		db = new Database(":memory:");
		initSchema(db);
		stmts = prepareStatements(db);
	});

	afterEach(() => {
		db.close();
	});

	it("extracts and stores new facts", async () => {
		const llm = mockLlm('[{"fact": "User likes TypeScript", "intensity": 0.6}]');
		const embed: EmbedFn = vi.fn(async () => FIXED_EMBED);
		const tool = createRememberFactsTool({
			agentId: AGENT_ID,
			embed,
			llm,
			stmts,
		});

		const result = await tool.execute("tc1", { text: "I like TypeScript" });

		expect(result.details.facts).toHaveLength(1);
		expect(result.details.facts[0]?.action).toBe("inserted");

		const chunks = db.prepare("SELECT * FROM chunks WHERE agent_id = ?").all(AGENT_ID) as Chunk[];
		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.content).toBe("User likes TypeScript");
		expect(chunks[0]?.running_intensity).toBeCloseTo(0.6, 2);
	});

	it("returns empty when no facts extracted", async () => {
		const llm = mockLlm("[]");
		const embed: EmbedFn = vi.fn(async () => FIXED_EMBED);
		const tool = createRememberFactsTool({
			agentId: AGENT_ID,
			embed,
			llm,
			stmts,
		});

		const result = await tool.execute("tc1", { text: "How's the weather?" });

		expect(result.details.facts).toHaveLength(0);
		expect(embed).not.toHaveBeenCalled();
	});

	it("auto-classifies as DUPLICATE when similarity > 0.93", async () => {
		// Insert existing fact with same embedding direction
		insertFact(stmts, "User likes TS", FIXED_EMBED);

		const llm = mockLlm('[{"fact": "User likes TypeScript", "intensity": 0.7}]');
		// Return same embedding — cosine similarity will be 1.0 > 0.93
		const embed: EmbedFn = vi.fn(async () => FIXED_EMBED);
		const tool = createRememberFactsTool({
			agentId: AGENT_ID,
			embed,
			llm,
			stmts,
		});

		const result = await tool.execute("tc1", { text: "I like TypeScript" });

		expect(result.details.facts[0]?.action).toBe("reinforced");
		// Only 1 LLM call (extraction), no classification needed
		expect(llm.complete).toHaveBeenCalledOnce();

		const chunks = db.prepare("SELECT * FROM chunks WHERE agent_id = ?").all(AGENT_ID) as Chunk[];
		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.encounter_count).toBe(2);
	});

	it("auto-classifies as NEW when similarity < 0.78", async () => {
		// Insert existing fact with orthogonal embedding
		insertFact(stmts, "User likes cats", DIFFERENT_EMBED);

		const llm = mockLlm('[{"fact": "User lives in Bangkok", "intensity": 0.3}]');
		const embed: EmbedFn = vi.fn(async () => FIXED_EMBED);
		const tool = createRememberFactsTool({
			agentId: AGENT_ID,
			embed,
			llm,
			stmts,
		});

		const result = await tool.execute("tc1", {
			text: "I live in Bangkok",
		});

		expect(result.details.facts[0]?.action).toBe("inserted");
		// Only 1 LLM call (extraction), no classification
		expect(llm.complete).toHaveBeenCalledOnce();

		const chunks = db.prepare("SELECT * FROM chunks WHERE agent_id = ?").all(AGENT_ID) as Chunk[];
		expect(chunks).toHaveLength(2);
	});

	it("uses LLM classification in ambiguous band and handles SUPERSEDES", async () => {
		// We need similarity between 0.78 and 0.93 (~0.88)
		const existingEmbed = new Float32Array([0.9, 0.4, 0.1, 0]);
		insertFact(stmts, "User lives in Berlin", existingEmbed);

		const llm = mockLlm('[{"fact": "User lives in Bangkok", "intensity": 0.5}]', "SUPERSEDES");

		const queryEmbed = new Float32Array([0.6, 0.7, 0.3, 0.1]);
		const embed: EmbedFn = vi.fn(async () => queryEmbed);
		const tool = createRememberFactsTool({
			agentId: AGENT_ID,
			embed,
			llm,
			stmts,
		});

		const result = await tool.execute("tc1", { text: "I live in Bangkok" });

		expect(result.details.facts[0]?.action).toBe("superseded");
		// 2 LLM calls: extraction + classification
		expect(llm.complete).toHaveBeenCalledTimes(2);

		const chunks = db
			.prepare("SELECT * FROM chunks WHERE agent_id = ? AND superseded_by IS NULL")
			.all(AGENT_ID) as Chunk[];
		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.content).toBe("User lives in Bangkok");

		// Old chunk has superseded_by set
		const superseded = db
			.prepare("SELECT * FROM chunks WHERE agent_id = ? AND superseded_by IS NOT NULL")
			.all(AGENT_ID) as Chunk[];
		expect(superseded).toHaveLength(1);
		expect(superseded[0]?.content).toBe("User lives in Berlin");
	});

	it("handles multiple extracted facts in one call", async () => {
		const llm = mockLlm(
			'[{"fact": "User dislikes Redux", "intensity": 0.85}, {"fact": "User tried café on Sukhumvit", "intensity": 0.15}]',
		);
		const embed: EmbedFn = vi.fn(async () => FIXED_EMBED);
		const tool = createRememberFactsTool({
			agentId: AGENT_ID,
			embed,
			llm,
			stmts,
		});

		const result = await tool.execute("tc1", {
			text: "I NEVER want to use Redux again. Oh and I tried that café on Sukhumvit.",
		});

		// First fact inserts, second one will be auto-classified as DUPLICATE of first
		// (same embedding) and reinforced — but let's just check we got 2 actions
		expect(result.details.facts).toHaveLength(2);
	});
});
