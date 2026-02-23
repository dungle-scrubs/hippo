import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbStatements } from "../db.js";
import { prepareStatements } from "../db.js";
import { initSchema } from "../schema.js";
import { embeddingToBuffer } from "../similarity.js";
import type { Chunk, EmbedFn } from "../types.js";
import { ulid } from "../ulid.js";
import { createForgetMemoryTool } from "./forget-memory.js";

const AGENT_ID = "test-agent";

/** Insert a chunk directly for testing. */
function insertChunk(
	stmts: DbStatements,
	content: string,
	kind: "fact" | "memory",
	embedding: Float32Array,
): string {
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
		kind,
		last_accessed_at: now,
		metadata: null,
		running_intensity: 0.5,
	});
	return id;
}

describe("forget_memory", () => {
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

	it("deletes matching chunks", async () => {
		const target = new Float32Array([1, 0, 0, 0]);
		insertChunk(stmts, "User likes Redux", "fact", target);

		// Query embedding matches target
		const embed: EmbedFn = vi.fn(async () => target);
		const tool = createForgetMemoryTool({ agentId: AGENT_ID, embed, stmts });

		const result = await tool.execute("tc1", { description: "that I like Redux" });

		expect(result.details.deleted).toBe(1);

		const remaining = db
			.prepare("SELECT * FROM chunks WHERE agent_id = ?")
			.all(AGENT_ID) as Chunk[];
		expect(remaining).toHaveLength(0);
	});

	it("returns zero when no matches found", async () => {
		const existing = new Float32Array([1, 0, 0, 0]);
		insertChunk(stmts, "User likes cats", "fact", existing);

		// Orthogonal embedding — no match
		const embed: EmbedFn = vi.fn(async () => new Float32Array([0, 1, 0, 0]));
		const tool = createForgetMemoryTool({ agentId: AGENT_ID, embed, stmts });

		const result = await tool.execute("tc1", { description: "something unrelated" });

		expect(result.details.deleted).toBe(0);

		const remaining = db
			.prepare("SELECT * FROM chunks WHERE agent_id = ?")
			.all(AGENT_ID) as Chunk[];
		expect(remaining).toHaveLength(1);
	});

	it("deletes both facts and memories", async () => {
		const target = new Float32Array([1, 0, 0, 0]);
		insertChunk(stmts, "User likes Redux", "fact", target);
		insertChunk(stmts, "We used Redux for the project", "memory", target);

		const embed: EmbedFn = vi.fn(async () => target);
		const tool = createForgetMemoryTool({ agentId: AGENT_ID, embed, stmts });

		const result = await tool.execute("tc1", { description: "Redux" });

		expect(result.details.deleted).toBe(2);
	});

	it("only deletes chunks above similarity threshold", async () => {
		const target = new Float32Array([1, 0, 0, 0]);
		const partial = new Float32Array([0.6, 0.8, 0, 0]); // similarity ~0.6 with target
		insertChunk(stmts, "User likes Redux", "fact", target);
		insertChunk(stmts, "User is from Germany", "fact", partial);

		const embed: EmbedFn = vi.fn(async () => target);
		const tool = createForgetMemoryTool({ agentId: AGENT_ID, embed, stmts });

		const result = await tool.execute("tc1", { description: "Redux" });

		expect(result.details.deleted).toBe(1);

		const remaining = db
			.prepare("SELECT * FROM chunks WHERE agent_id = ?")
			.all(AGENT_ID) as Chunk[];
		expect(remaining).toHaveLength(1);
		expect(remaining[0]?.content).toBe("User is from Germany");
	});

	it("is a hard delete — no trace remains", async () => {
		const target = new Float32Array([1, 0, 0, 0]);
		const id = insertChunk(stmts, "Sensitive data", "memory", target);

		const embed: EmbedFn = vi.fn(async () => target);
		const tool = createForgetMemoryTool({ agentId: AGENT_ID, embed, stmts });

		await tool.execute("tc1", { description: "sensitive data" });

		const row = db.prepare("SELECT * FROM chunks WHERE id = ?").get(id);
		expect(row).toBeUndefined();
	});
});
