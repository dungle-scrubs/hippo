import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteChunk, updateChunk } from "./chunk-mutations.js";
import type { DbStatements } from "./db.js";
import { prepareStatements } from "./db.js";
import { contentHash } from "./hash.js";
import { initSchema } from "./schema.js";
import { bufferToEmbedding, embeddingToBuffer } from "./similarity.js";
import type { Chunk, EmbedFn } from "./types.js";
import { ulid } from "./ulid.js";

const AGENT_ID = "test-agent";

/**
 * Insert a chunk row for mutation tests.
 *
 * @param stmts - Prepared statement cache
 * @param chunk - Required chunk fields
 * @returns The inserted chunk ID
 */
function insertChunk(
	stmts: DbStatements,
	chunk: {
		readonly content: string;
		readonly embedding: Float32Array;
		readonly kind: "fact" | "memory";
		readonly scope?: string;
	},
): string {
	const id = ulid();
	const now = new Date().toISOString();
	stmts.insertChunk.run({
		access_count: 0,
		agent_id: AGENT_ID,
		scope: chunk.scope ?? "",
		content: chunk.content,
		content_hash: chunk.kind === "memory" ? contentHash(chunk.content) : null,
		created_at: now,
		embedding: embeddingToBuffer(chunk.embedding),
		encounter_count: 1,
		id,
		kind: chunk.kind,
		last_accessed_at: now,
		metadata: null,
		running_intensity: 0.5,
	});
	return id;
}

describe("chunk mutations", () => {
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

	it("updateChunk updates memory content, hash, embedding, and timestamps", async () => {
		const id = insertChunk(stmts, {
			content: "old memory",
			embedding: new Float32Array([1, 0, 0, 0]),
			kind: "memory",
		});
		const before = db.prepare("SELECT * FROM chunks WHERE id = ?").get(id) as Chunk;

		const embed: EmbedFn = vi.fn(async () => new Float32Array([0, 1, 0, 0]));
		const updated = await updateChunk(db, embed, id, "new memory");

		expect(embed).toHaveBeenCalledWith("new memory");
		expect(updated.content).toBe("new memory");
		expect(updated.content_hash).toBe(contentHash("new memory"));
		expect(bufferToEmbedding(updated.embedding)).toEqual(new Float32Array([0, 1, 0, 0]));
		expect(updated.created_at).not.toBe(before.created_at);
		expect(updated.last_accessed_at).not.toBe(before.last_accessed_at);
	});

	it("updateChunk keeps fact content_hash null", async () => {
		const id = insertChunk(stmts, {
			content: "old fact",
			embedding: new Float32Array([1, 0, 0, 0]),
			kind: "fact",
		});

		const embed: EmbedFn = vi.fn(async () => new Float32Array([0, 1, 0, 0]));
		const updated = await updateChunk(db, embed, id, "new fact");

		expect(updated.content).toBe("new fact");
		expect(updated.content_hash).toBeNull();
	});

	it("updateChunk throws when the chunk does not exist", async () => {
		const embed: EmbedFn = vi.fn(async () => new Float32Array([0, 1, 0, 0]));

		await expect(updateChunk(db, embed, "missing", "new content")).rejects.toThrow(
			"Chunk not found: missing",
		);
		expect(embed).not.toHaveBeenCalled();
	});

	it("updateChunk is atomic on UNIQUE violations", async () => {
		insertChunk(stmts, {
			content: "memory one",
			embedding: new Float32Array([1, 0, 0, 0]),
			kind: "memory",
		});
		const secondId = insertChunk(stmts, {
			content: "memory two",
			embedding: new Float32Array([0, 1, 0, 0]),
			kind: "memory",
		});
		const before = db.prepare("SELECT * FROM chunks WHERE id = ?").get(secondId) as Chunk;

		const embed: EmbedFn = vi.fn(async () => new Float32Array([0, 0, 1, 0]));
		await expect(updateChunk(db, embed, secondId, "memory one")).rejects.toThrow(
			/UNIQUE constraint failed/,
		);

		const after = db.prepare("SELECT * FROM chunks WHERE id = ?").get(secondId) as Chunk;
		expect(after.content).toBe(before.content);
		expect(after.content_hash).toBe(before.content_hash);
		expect(after.created_at).toBe(before.created_at);
		expect(after.last_accessed_at).toBe(before.last_accessed_at);
	});

	it("deleteChunk returns false when the chunk does not exist", () => {
		expect(deleteChunk(db, "missing")).toBe(false);
	});

	it("deleteChunk hard-deletes a chunk and clears superseded_by references", () => {
		const embedding = new Float32Array([1, 0, 0, 0]);
		const oldFactId = insertChunk(stmts, {
			content: "User lives in Berlin",
			embedding,
			kind: "fact",
		});
		const newFactId = insertChunk(stmts, {
			content: "User lives in Bangkok",
			embedding,
			kind: "fact",
		});
		stmts.supersedeChunk.run(newFactId, oldFactId);

		const deleted = deleteChunk(db, newFactId);
		expect(deleted).toBe(true);

		const deletedRow = db.prepare("SELECT * FROM chunks WHERE id = ?").get(newFactId);
		expect(deletedRow).toBeUndefined();

		const resurrected = db.prepare("SELECT * FROM chunks WHERE id = ?").get(oldFactId) as Chunk;
		expect(resurrected.superseded_by).toBeNull();
	});
});
