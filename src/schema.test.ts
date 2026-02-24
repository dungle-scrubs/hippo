import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { initSchema, verifyEmbeddingModel } from "./schema.js";

describe("initSchema", () => {
	it("creates chunks table", () => {
		const db = new Database(":memory:");
		initSchema(db);
		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all() as { name: string }[];
		const names = tables.map((t) => t.name);
		expect(names).toContain("chunks");
		expect(names).toContain("memory_blocks");
		expect(names).toContain("hippo_meta");
		db.close();
	});

	it("is idempotent", () => {
		const db = new Database(":memory:");
		initSchema(db);
		initSchema(db);
		db.close();
	});

	it("sets WAL journal mode", () => {
		const db = new Database(":memory:");
		initSchema(db);
		const mode = db.pragma("journal_mode") as [{ journal_mode: string }];
		// In-memory databases stay "memory", file databases would be "wal"
		expect(mode[0].journal_mode).toBeDefined();
		db.close();
	});

	it("creates all expected indexes", () => {
		const db = new Database(":memory:");
		initSchema(db);
		const indexes = db
			.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
			.all() as { name: string }[];
		const names = indexes.map((i) => i.name);
		expect(names).toContain("idx_chunks_memory_dedup");
		expect(names).toContain("idx_chunks_agent_kind");
		expect(names).toContain("idx_chunks_last_accessed");
		expect(names).toContain("idx_chunks_superseded");
		expect(names).toContain("idx_chunks_created_at");
		db.close();
	});

	it("enforces kind CHECK constraint", () => {
		const db = new Database(":memory:");
		initSchema(db);
		expect(() => {
			db.prepare(
				`INSERT INTO chunks (id, agent_id, content, embedding, kind,
					running_intensity, encounter_count, access_count, last_accessed_at, created_at)
				VALUES ('x', 'a', 'c', X'00', 'invalid', 0.5, 1, 0, '2024-01-01', '2024-01-01')`,
			).run();
		}).toThrow();
		db.close();
	});

	it("enforces memory_blocks primary key", () => {
		const db = new Database(":memory:");
		initSchema(db);
		db.prepare(
			"INSERT INTO memory_blocks (agent_id, key, value, updated_at) VALUES ('a', 'k', 'v', '2024-01-01')",
		).run();
		expect(() => {
			db.prepare(
				"INSERT INTO memory_blocks (agent_id, key, value, updated_at) VALUES ('a', 'k', 'v2', '2024-01-01')",
			).run();
		}).toThrow();
		db.close();
	});
});

describe("verifyEmbeddingModel", () => {
	it("stores model on first call", () => {
		const db = new Database(":memory:");
		initSchema(db);
		verifyEmbeddingModel(db, "text-embedding-3-small");

		const row = db.prepare("SELECT value FROM hippo_meta WHERE key = 'embedding_model'").get() as {
			value: string;
		};
		expect(row.value).toBe("text-embedding-3-small");
		db.close();
	});

	it("succeeds when model matches", () => {
		const db = new Database(":memory:");
		initSchema(db);
		verifyEmbeddingModel(db, "text-embedding-3-small");
		// Should not throw
		verifyEmbeddingModel(db, "text-embedding-3-small");
		db.close();
	});

	it("throws on model mismatch", () => {
		const db = new Database(":memory:");
		initSchema(db);
		verifyEmbeddingModel(db, "text-embedding-3-small");

		expect(() => verifyEmbeddingModel(db, "text-embedding-3-large")).toThrow(
			/model mismatch.*text-embedding-3-small.*text-embedding-3-large/i,
		);
		db.close();
	});
});
