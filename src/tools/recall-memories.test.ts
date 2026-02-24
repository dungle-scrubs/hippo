import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbStatements } from "../db.js";
import { prepareStatements } from "../db.js";
import { initSchema } from "../schema.js";
import { embeddingToBuffer } from "../similarity.js";
import type { Chunk, EmbedFn, SearchResult } from "../types.js";
import { ulid } from "../ulid.js";
import { createRecallMemoriesTool } from "./recall-memories.js";

const AGENT_ID = "test-agent";

/** Returns an embedding that points mostly in the given dimension. */
function directionalEmbed(dim: number): Float32Array {
	const v = new Float32Array(4).fill(0);
	v[dim] = 1.0;
	return v;
}

/** Insert a chunk directly for testing. */
function insertChunk(
	stmts: DbStatements,
	overrides: Partial<Chunk> & { content: string; kind: "fact" | "memory" },
): string {
	const id = overrides.id ?? ulid();
	const now = new Date().toISOString();
	stmts.insertChunk.run({
		access_count: overrides.access_count ?? 0,
		agent_id: AGENT_ID,
		content: overrides.content,
		content_hash: overrides.content_hash ?? null,
		created_at: overrides.created_at ?? now,
		embedding: overrides.embedding ?? embeddingToBuffer(directionalEmbed(0)),
		encounter_count: overrides.encounter_count ?? 1,
		id,
		kind: overrides.kind,
		last_accessed_at: overrides.last_accessed_at ?? now,
		metadata: overrides.metadata ?? null,
		running_intensity: overrides.running_intensity ?? 0.5,
	});
	return id;
}

describe("recall_memories", () => {
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

	it("returns empty results when no chunks exist", async () => {
		const embed: EmbedFn = vi.fn(async () => directionalEmbed(0));
		const tool = createRecallMemoriesTool({ agentId: AGENT_ID, embed, stmts });

		const result = await tool.execute("tc1", { query: "anything" });

		expect(result.content[0]).toMatchObject({ text: "No memories found." });
		expect(result.details.results).toEqual([]);
	});

	it("returns matching chunks ranked by score", async () => {
		// Insert two chunks with different embeddings
		insertChunk(stmts, {
			content: "User likes TypeScript",
			embedding: embeddingToBuffer(directionalEmbed(0)),
			kind: "fact",
		});
		insertChunk(stmts, {
			content: "User likes Rust",
			embedding: embeddingToBuffer(directionalEmbed(1)),
			kind: "fact",
		});

		// Query embedding aligns with dim 0 (TypeScript chunk)
		const embed: EmbedFn = vi.fn(async () => directionalEmbed(0));
		const tool = createRecallMemoriesTool({ agentId: AGENT_ID, embed, stmts });

		const result = await tool.execute("tc1", { query: "TypeScript" });

		expect(result.details.results.length).toBeGreaterThan(0);
		expect(result.details.results[0]?.chunk.content).toBe("User likes TypeScript");
	});

	it("respects limit parameter", async () => {
		for (let i = 0; i < 5; i++) {
			insertChunk(stmts, {
				content: `Memory ${i}`,
				embedding: embeddingToBuffer(directionalEmbed(0)),
				kind: "memory",
			});
		}

		const embed: EmbedFn = vi.fn(async () => directionalEmbed(0));
		const tool = createRecallMemoriesTool({ agentId: AGENT_ID, embed, stmts });

		const result = await tool.execute("tc1", { limit: 2, query: "test" });

		expect(result.details.results).toHaveLength(2);
	});

	it("excludes superseded chunks", async () => {
		const oldId = insertChunk(stmts, {
			content: "User lives in Berlin",
			embedding: embeddingToBuffer(directionalEmbed(0)),
			kind: "fact",
		});
		const newId = insertChunk(stmts, {
			content: "User lives in Bangkok",
			embedding: embeddingToBuffer(directionalEmbed(0)),
			kind: "fact",
		});

		// Mark old as superseded
		stmts.supersedeChunk.run(newId, oldId);

		const embed: EmbedFn = vi.fn(async () => directionalEmbed(0));
		const tool = createRecallMemoriesTool({ agentId: AGENT_ID, embed, stmts });

		const result = await tool.execute("tc1", { query: "where does user live" });

		const contents = result.details.results.map((r: SearchResult) => r.chunk.content);
		expect(contents).toContain("User lives in Bangkok");
		expect(contents).not.toContain("User lives in Berlin");
	});

	it("applies retrieval boost to accessed chunks", async () => {
		const id = insertChunk(stmts, {
			content: "Boosted memory",
			embedding: embeddingToBuffer(directionalEmbed(0)),
			kind: "memory",
			running_intensity: 0.5,
		});

		const embed: EmbedFn = vi.fn(async () => directionalEmbed(0));
		const tool = createRecallMemoriesTool({ agentId: AGENT_ID, embed, stmts });

		await tool.execute("tc1", { query: "test" });

		const chunk = db.prepare("SELECT * FROM chunks WHERE id = ?").get(id) as Chunk;
		expect(chunk.running_intensity).toBeCloseTo(0.52, 2);
		expect(chunk.access_count).toBe(1);
	});

	it("searches both facts and memories", async () => {
		insertChunk(stmts, {
			content: "A fact",
			embedding: embeddingToBuffer(directionalEmbed(0)),
			kind: "fact",
		});
		insertChunk(stmts, {
			content: "A memory",
			embedding: embeddingToBuffer(directionalEmbed(0)),
			kind: "memory",
		});

		const embed: EmbedFn = vi.fn(async () => directionalEmbed(0));
		const tool = createRecallMemoriesTool({ agentId: AGENT_ID, embed, stmts });

		const result = await tool.execute("tc1", { query: "test" });

		const kinds = result.details.results.map((r: SearchResult) => r.chunk.kind);
		expect(kinds).toContain("fact");
		expect(kinds).toContain("memory");
	});

	it("excludes chunks below STRENGTH_FLOOR", async () => {
		// Insert a chunk with very low intensity that has been idle for a long time
		// so effective_strength drops below 0.05
		const longAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
		insertChunk(stmts, {
			content: "Ancient faded memory",
			embedding: embeddingToBuffer(directionalEmbed(0)),
			kind: "memory",
			last_accessed_at: longAgo,
			running_intensity: 0.05,
		});

		// Insert a healthy chunk
		insertChunk(stmts, {
			content: "Fresh memory",
			embedding: embeddingToBuffer(directionalEmbed(0)),
			kind: "memory",
			running_intensity: 0.8,
		});

		const embed: EmbedFn = vi.fn(async () => directionalEmbed(0));
		const tool = createRecallMemoriesTool({ agentId: AGENT_ID, embed, stmts });

		const result = await tool.execute("tc1", { query: "test" });

		const contents = result.details.results.map((r: SearchResult) => r.chunk.content);
		expect(contents).toContain("Fresh memory");
		expect(contents).not.toContain("Ancient faded memory");
	});

	it("excludes anti-correlated chunks below similarity floor", async () => {
		// Insert chunk pointing in +x direction
		insertChunk(stmts, {
			content: "Positive direction",
			embedding: embeddingToBuffer(directionalEmbed(0)),
			kind: "fact",
		});

		// Query in -x direction (opposite) — cosine similarity = -1.0, below floor
		const opposite = new Float32Array([-1, 0, 0, 0]);
		const embed: EmbedFn = vi.fn(async () => opposite);
		const tool = createRecallMemoriesTool({ agentId: AGENT_ID, embed, stmts });

		const result = await tool.execute("tc1", { query: "opposite" });

		expect(result.details.results).toHaveLength(0);
	});

	it("excludes orthogonal chunks below similarity floor", async () => {
		// Insert chunk in dim 0, query dim 1 — cosine similarity = 0.0, below floor
		insertChunk(stmts, {
			content: "Orthogonal memory",
			embedding: embeddingToBuffer(directionalEmbed(0)),
			kind: "fact",
		});

		const embed: EmbedFn = vi.fn(async () => directionalEmbed(1));
		const tool = createRecallMemoriesTool({ agentId: AGENT_ID, embed, stmts });

		const result = await tool.execute("tc1", { query: "unrelated" });

		expect(result.details.results).toHaveLength(0);
	});

	it("respects custom minSimilarity", async () => {
		// Chunk in a partially-aligned direction — similarity ~0.8 with dim 0
		const partial = new Float32Array([0.8, 0.6, 0, 0]);
		insertChunk(stmts, {
			content: "Partial match",
			embedding: embeddingToBuffer(partial),
			kind: "fact",
		});

		const embed: EmbedFn = vi.fn(async () => directionalEmbed(0));

		// Strict threshold (0.9) — similarity ~0.8 is below it
		const strict = createRecallMemoriesTool({
			agentId: AGENT_ID,
			embed,
			minSimilarity: 0.9,
			stmts,
		});
		const r1 = await strict.execute("tc1", { query: "test" });
		expect(r1.details.results).toHaveLength(0);

		// Lenient threshold (0.5) — similarity ~0.8 passes
		const lenient = createRecallMemoriesTool({
			agentId: AGENT_ID,
			embed,
			minSimilarity: 0.5,
			stmts,
		});
		const r2 = await lenient.execute("tc2", { query: "test" });
		expect(r2.details.results).toHaveLength(1);
	});

	it("respects maxSearchChunks cap", async () => {
		// Insert 5 chunks, but cap search to 3
		for (let i = 0; i < 5; i++) {
			insertChunk(stmts, {
				content: `Memory ${i}`,
				embedding: embeddingToBuffer(directionalEmbed(0)),
				kind: "memory",
			});
		}

		const embed: EmbedFn = vi.fn(async () => directionalEmbed(0));
		const tool = createRecallMemoriesTool({
			agentId: AGENT_ID,
			embed,
			maxSearchChunks: 3,
			stmts,
		});

		const result = await tool.execute("tc1", { query: "test" });

		// Only 3 chunks were loaded, so at most 3 results
		expect(result.details.results.length).toBeLessThanOrEqual(3);
	});

	it("propagates embed errors", async () => {
		const embed: EmbedFn = vi.fn().mockRejectedValue(new Error("Embed timeout"));
		const tool = createRecallMemoriesTool({ agentId: AGENT_ID, embed, stmts });

		await expect(tool.execute("tc1", { query: "test" })).rejects.toThrow("Embed timeout");
	});

	it("swallows SQLITE_BUSY during retrieval boost", async () => {
		insertChunk(stmts, {
			content: "Busy-safe memory",
			embedding: embeddingToBuffer(directionalEmbed(0)),
			kind: "memory",
			running_intensity: 0.5,
		});

		const embed: EmbedFn = vi.fn(async () => directionalEmbed(0));
		const tool = createRecallMemoriesTool({ agentId: AGENT_ID, embed, stmts });

		// Sabotage touchChunk to throw SQLITE_BUSY
		let callCount = 0;
		vi.spyOn(stmts.touchChunk, "run").mockImplementation(() => {
			callCount++;
			const err = new Error("database is locked");
			(err as Error & { code: string }).code = "SQLITE_BUSY";
			throw err;
		});

		// Should still return results despite boost failure
		const result = await tool.execute("tc1", { query: "test" });
		expect(result.details.results.length).toBeGreaterThan(0);
		expect(callCount).toBe(1);
	});

	it("re-throws non-transient errors during retrieval boost", async () => {
		insertChunk(stmts, {
			content: "Corrupt memory",
			embedding: embeddingToBuffer(directionalEmbed(0)),
			kind: "memory",
			running_intensity: 0.5,
		});

		const embed: EmbedFn = vi.fn(async () => directionalEmbed(0));
		const tool = createRecallMemoriesTool({ agentId: AGENT_ID, embed, stmts });

		// Sabotage touchChunk to throw a non-transient error (corruption/OOM)
		vi.spyOn(stmts.touchChunk, "run").mockImplementation(() => {
			throw new Error("disk I/O error");
		});

		await expect(tool.execute("tc1", { query: "test" })).rejects.toThrow("disk I/O error");
	});
});
