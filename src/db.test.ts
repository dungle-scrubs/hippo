import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getActiveChunks, getAllActiveChunks, prepareStatements } from "./db.js";
import { contentHash } from "./hash.js";
import { initSchema } from "./schema.js";
import { embeddingToBuffer } from "./similarity.js";
import type { Chunk } from "./types.js";
import { ulid } from "./ulid.js";

const AGENT_ID = "agent";

/**
 * Insert a chunk with a specific scope for db query tests.
 *
 * @param db - SQLite handle
 * @param scope - Scope value to store
 * @param content - Chunk content
 * @param kind - Chunk kind
 */
function insertChunk(
	db: Database.Database,
	scope: string,
	content: string,
	kind: "fact" | "memory",
): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO chunks (
			id, agent_id, scope, content, content_hash, embedding, metadata, kind,
			running_intensity, encounter_count, access_count, last_accessed_at, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		ulid(),
		AGENT_ID,
		scope,
		content,
		kind === "memory" ? contentHash(content) : null,
		embeddingToBuffer(new Float32Array([1, 0, 0, 0])),
		null,
		kind,
		0.5,
		1,
		0,
		now,
		now,
	);
}

describe("db scope filters", () => {
	let db: Database.Database;

	beforeEach(() => {
		db = new Database(":memory:");
		initSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	it("returns all scopes when filter is undefined", () => {
		insertChunk(db, "project-a", "A", "fact");
		insertChunk(db, "project-b", "B", "fact");
		const stmts = prepareStatements(db);

		const chunks = getActiveChunks(stmts, AGENT_ID, "fact");
		expect(chunks).toHaveLength(2);
	});

	it("filters by a single scope string", () => {
		insertChunk(db, "project-a", "A", "fact");
		insertChunk(db, "project-b", "B", "fact");
		const stmts = prepareStatements(db);

		const chunks = getActiveChunks(stmts, AGENT_ID, "fact", -1, "project-b");
		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.scope).toBe("project-b");
	});

	it("filters by multiple scopes", () => {
		insertChunk(db, "project-a", "A", "fact");
		insertChunk(db, "project-b", "B", "fact");
		insertChunk(db, "project-c", "C", "memory");
		const stmts = prepareStatements(db);

		const chunks = getAllActiveChunks(stmts, AGENT_ID, -1, ["project-a", "project-c"]);
		const scopes = chunks.map((chunk: Chunk) => chunk.scope).sort();
		expect(scopes).toEqual(["project-a", "project-c"]);
	});

	it("returns no chunks when scope filter is an empty list", () => {
		insertChunk(db, "project-a", "A", "fact");
		const stmts = prepareStatements(db);

		const chunks = getAllActiveChunks(stmts, AGENT_ID, -1, []);
		expect(chunks).toEqual([]);
	});
});
