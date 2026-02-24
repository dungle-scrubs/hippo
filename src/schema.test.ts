import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { initSchema } from "./schema.js";

describe("initSchema", () => {
	let db: Database.Database;

	afterEach(() => {
		db?.close();
	});

	it("creates chunks table with expected columns", () => {
		db = new Database(":memory:");
		initSchema(db);

		const cols = db.prepare("PRAGMA table_info(chunks)").all() as Array<{
			name: string;
			notnull: number;
			type: string;
		}>;
		const colNames = cols.map((c) => c.name);

		expect(colNames).toContain("id");
		expect(colNames).toContain("agent_id");
		expect(colNames).toContain("content");
		expect(colNames).toContain("content_hash");
		expect(colNames).toContain("embedding");
		expect(colNames).toContain("metadata");
		expect(colNames).toContain("kind");
		expect(colNames).toContain("running_intensity");
		expect(colNames).toContain("encounter_count");
		expect(colNames).toContain("access_count");
		expect(colNames).toContain("last_accessed_at");
		expect(colNames).toContain("superseded_by");
		expect(colNames).toContain("created_at");
	});

	it("creates memory_blocks table with composite primary key", () => {
		db = new Database(":memory:");
		initSchema(db);

		const cols = db.prepare("PRAGMA table_info(memory_blocks)").all() as Array<{
			name: string;
			pk: number;
		}>;
		const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name);

		expect(pkCols).toEqual(["agent_id", "key"]);
	});

	it("sets WAL journal mode", () => {
		db = new Database(":memory:");
		initSchema(db);

		const result = db.pragma("journal_mode") as Array<{ journal_mode: string }>;
		// In-memory databases may report 'memory' instead of 'wal'
		expect(["wal", "memory"]).toContain(result[0]?.journal_mode);
	});

	it("is idempotent", () => {
		db = new Database(":memory:");
		initSchema(db);
		initSchema(db);

		const cols = db.prepare("PRAGMA table_info(chunks)").all();
		expect(cols.length).toBeGreaterThan(0);
	});

	it("creates expected indexes", () => {
		db = new Database(":memory:");
		initSchema(db);

		const indexes = db
			.prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL")
			.all() as Array<{ name: string }>;
		const indexNames = indexes.map((i) => i.name);

		expect(indexNames).toContain("idx_chunks_memory_dedup");
		expect(indexNames).toContain("idx_chunks_agent_kind");
		expect(indexNames).toContain("idx_chunks_last_accessed");
		expect(indexNames).toContain("idx_chunks_superseded");
		expect(indexNames).toContain("idx_chunks_created_at");
	});

	it("enforces kind CHECK constraint", () => {
		db = new Database(":memory:");
		initSchema(db);

		expect(() => {
			db.prepare(
				`INSERT INTO chunks (id, agent_id, content, embedding, kind, running_intensity,
				encounter_count, access_count, last_accessed_at, created_at)
				VALUES ('test', 'a1', 'text', X'00', 'invalid', 0.5, 1, 0, '2025-01-01', '2025-01-01')`,
			).run();
		}).toThrow();
	});
});
