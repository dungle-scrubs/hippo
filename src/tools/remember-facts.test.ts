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
		// Different embeddings so they're distinct from each other
		let callCount = 0;
		const embed: EmbedFn = vi.fn(async () => {
			callCount++;
			return callCount === 1 ? FIXED_EMBED : DIFFERENT_EMBED;
		});
		const tool = createRememberFactsTool({
			agentId: AGENT_ID,
			embed,
			llm,
			stmts,
		});

		const result = await tool.execute("tc1", {
			text: "I NEVER want to use Redux again. Oh and I tried that café on Sukhumvit.",
		});

		expect(result.details.facts).toHaveLength(2);
		// Both should be inserted as new (orthogonal embeddings)
		expect(result.details.facts[0]?.action).toBe("inserted");
		expect(result.details.facts[1]?.action).toBe("inserted");

		const chunks = db.prepare("SELECT * FROM chunks WHERE agent_id = ?").all(AGENT_ID) as Chunk[];
		expect(chunks).toHaveLength(2);
	});

	it("detects duplicate between facts extracted in the same batch", async () => {
		// Both facts get the same embedding — the second should see the first
		// and be auto-classified as DUPLICATE (similarity 1.0 > 0.93)
		const llm = mockLlm(
			'[{"fact": "User hates Redux", "intensity": 0.85}, {"fact": "User dislikes Redux", "intensity": 0.7}]',
		);
		const embed: EmbedFn = vi.fn(async () => FIXED_EMBED);
		const tool = createRememberFactsTool({
			agentId: AGENT_ID,
			embed,
			llm,
			stmts,
		});

		const result = await tool.execute("tc1", { text: "I hate Redux. I dislike Redux." });

		expect(result.details.facts).toHaveLength(2);
		expect(result.details.facts[0]?.action).toBe("inserted");
		// Second fact should be reinforced against the first (same embedding = sim 1.0)
		expect(result.details.facts[1]?.action).toBe("reinforced");

		// Only one chunk in DB — the second was deduplicated
		const chunks = db.prepare("SELECT * FROM chunks WHERE agent_id = ?").all(AGENT_ID) as Chunk[];
		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.encounter_count).toBe(2);
	});

	it("uses LLM classification in ambiguous band and handles DISTINCT", async () => {
		// Same setup as SUPERSEDES test — similarity in ambiguous band
		const existingEmbed = new Float32Array([0.9, 0.4, 0.1, 0]);
		insertFact(stmts, "User likes TypeScript", existingEmbed);

		const llm = mockLlm('[{"fact": "User likes Rust", "intensity": 0.5}]', "DISTINCT");

		const queryEmbed = new Float32Array([0.6, 0.7, 0.3, 0.1]);
		const embed: EmbedFn = vi.fn(async () => queryEmbed);
		const tool = createRememberFactsTool({
			agentId: AGENT_ID,
			embed,
			llm,
			stmts,
		});

		const result = await tool.execute("tc1", { text: "I like Rust too" });

		expect(result.details.facts[0]?.action).toBe("inserted");
		// 2 LLM calls: extraction + classification
		expect(llm.complete).toHaveBeenCalledTimes(2);

		// Both chunks exist — DISTINCT means both are valid simultaneously
		const chunks = db
			.prepare("SELECT * FROM chunks WHERE agent_id = ? AND superseded_by IS NULL")
			.all(AGENT_ID) as Chunk[];
		expect(chunks).toHaveLength(2);
	});

	it("uses LLM classification in ambiguous band and handles DUPLICATE", async () => {
		// Similarity in the ambiguous 0.78–0.93 band, LLM returns DUPLICATE
		const existingEmbed = new Float32Array([0.9, 0.4, 0.1, 0]);
		insertFact(stmts, "User dislikes Redux", existingEmbed);

		const llm = mockLlm('[{"fact": "User hates Redux", "intensity": 0.9}]', "DUPLICATE");

		const queryEmbed = new Float32Array([0.6, 0.7, 0.3, 0.1]);
		const embed: EmbedFn = vi.fn(async () => queryEmbed);
		const tool = createRememberFactsTool({
			agentId: AGENT_ID,
			embed,
			llm,
			stmts,
		});

		const result = await tool.execute("tc1", { text: "I hate Redux" });

		expect(result.details.facts[0]?.action).toBe("reinforced");
		// 2 LLM calls: extraction + classification
		expect(llm.complete).toHaveBeenCalledTimes(2);

		// Only one chunk — reinforced, not duplicated
		const chunks = db.prepare("SELECT * FROM chunks WHERE agent_id = ?").all(AGENT_ID) as Chunk[];
		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.encounter_count).toBe(2);
	});

	it("ignores facts from other agents during conflict resolution", async () => {
		// Insert a fact for a different agent with the same embedding
		const otherAgentId = "other-agent";
		const now = new Date().toISOString();
		stmts.insertChunk.run({
			access_count: 0,
			agent_id: otherAgentId,
			content: "Other agent's fact",
			content_hash: null,
			created_at: now,
			embedding: embeddingToBuffer(FIXED_EMBED),
			encounter_count: 1,
			id: ulid(),
			kind: "fact",
			last_accessed_at: now,
			metadata: null,
			running_intensity: 0.5,
		});

		const llm = mockLlm('[{"fact": "My fact", "intensity": 0.5}]');
		const embed: EmbedFn = vi.fn(async () => FIXED_EMBED);
		const tool = createRememberFactsTool({
			agentId: AGENT_ID,
			embed,
			llm,
			stmts,
		});

		const result = await tool.execute("tc1", { text: "My fact" });

		// Should be inserted as new — other agent's fact is invisible
		expect(result.details.facts[0]?.action).toBe("inserted");

		// Our agent has 1 chunk, other agent still has 1
		const ours = db.prepare("SELECT * FROM chunks WHERE agent_id = ?").all(AGENT_ID) as Chunk[];
		expect(ours).toHaveLength(1);
		const theirs = db
			.prepare("SELECT * FROM chunks WHERE agent_id = ?")
			.all(otherAgentId) as Chunk[];
		expect(theirs).toHaveLength(1);
	});

	it("propagates LLM extraction errors", async () => {
		const llm: LlmClient = {
			complete: vi.fn().mockRejectedValue(new Error("API quota exceeded")),
		};
		const embed: EmbedFn = vi.fn(async () => FIXED_EMBED);
		const tool = createRememberFactsTool({
			agentId: AGENT_ID,
			embed,
			llm,
			stmts,
		});

		await expect(tool.execute("tc1", { text: "test" })).rejects.toThrow("API quota exceeded");

		// No chunks should have been inserted
		const chunks = db.prepare("SELECT * FROM chunks WHERE agent_id = ?").all(AGENT_ID);
		expect(chunks).toHaveLength(0);
	});

	it("respects maxSearchFacts cap during conflict resolution", async () => {
		// Insert 3 existing facts with same embedding — would normally be duplicates
		for (let i = 0; i < 3; i++) {
			insertFact(stmts, `Existing fact ${i}`, FIXED_EMBED);
		}

		const llm = mockLlm('[{"fact": "Same direction fact", "intensity": 0.5}]');
		const embed: EmbedFn = vi.fn(async () => FIXED_EMBED);

		// Cap to 0 — no existing facts loaded for comparison
		const tool = createRememberFactsTool({
			agentId: AGENT_ID,
			embed,
			llm,
			maxSearchFacts: 0,
			stmts,
		});

		const result = await tool.execute("tc1", { text: "test" });

		// Inserted as new because no existing facts were visible for comparison
		expect(result.details.facts[0]?.action).toBe("inserted");

		const chunks = db.prepare("SELECT * FROM chunks WHERE agent_id = ?").all(AGENT_ID) as Chunk[];
		expect(chunks).toHaveLength(4); // 3 existing + 1 new
	});

	it("propagates embed errors — no partial inserts", async () => {
		const llm = mockLlm('[{"fact": "User likes cats", "intensity": 0.5}]');
		const embed: EmbedFn = vi.fn().mockRejectedValue(new Error("Embedding service down"));
		const tool = createRememberFactsTool({
			agentId: AGENT_ID,
			embed,
			llm,
			stmts,
		});

		await expect(tool.execute("tc1", { text: "I like cats" })).rejects.toThrow(
			"Embedding service down",
		);

		const chunks = db.prepare("SELECT * FROM chunks WHERE agent_id = ?").all(AGENT_ID);
		expect(chunks).toHaveLength(0);
	});

	it("partial failure in multi-fact batch leaves first fact inserted", async () => {
		// First fact embeds fine, second fails
		let embedCallCount = 0;
		const embed: EmbedFn = vi.fn(async () => {
			embedCallCount++;
			if (embedCallCount === 2) {
				throw new Error("Transient embed failure");
			}
			return FIXED_EMBED;
		});

		const llm = mockLlm(
			'[{"fact": "Fact one", "intensity": 0.5}, {"fact": "Fact two", "intensity": 0.5}]',
		);
		const tool = createRememberFactsTool({
			agentId: AGENT_ID,
			embed,
			llm,
			stmts,
		});

		// The tool should throw on the second fact
		await expect(tool.execute("tc1", { text: "test" })).rejects.toThrow("Transient embed failure");

		// First fact was already inserted before the error
		const chunks = db.prepare("SELECT * FROM chunks WHERE agent_id = ?").all(AGENT_ID);
		expect(chunks).toHaveLength(1);
	});
});
