import type { Database } from "better-sqlite3";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS hippo_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
    id                TEXT PRIMARY KEY,
    agent_id          TEXT NOT NULL,
    scope             TEXT NOT NULL DEFAULT '',
    content           TEXT NOT NULL,
    content_hash      TEXT,
    embedding         BLOB NOT NULL,
    metadata          TEXT,
    kind              TEXT NOT NULL CHECK(kind IN ('fact', 'memory')),
    running_intensity REAL NOT NULL DEFAULT 0.5,
    encounter_count   INTEGER NOT NULL DEFAULT 1,
    access_count      INTEGER NOT NULL DEFAULT 0,
    last_accessed_at  TEXT NOT NULL,
    superseded_by     TEXT,
    created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_blocks (
    agent_id    TEXT NOT NULL,
    scope       TEXT NOT NULL DEFAULT '',
    key         TEXT NOT NULL,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (agent_id, scope, key)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_memory_dedup
    ON chunks(agent_id, content_hash) WHERE kind = 'memory';

CREATE INDEX IF NOT EXISTS idx_chunks_agent_kind
    ON chunks(agent_id, kind);

CREATE INDEX IF NOT EXISTS idx_chunks_last_accessed
    ON chunks(agent_id, last_accessed_at);

CREATE INDEX IF NOT EXISTS idx_chunks_superseded
    ON chunks(superseded_by) WHERE superseded_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_chunks_created_at
    ON chunks(agent_id, created_at);
`;

/** Returns true when a table already has the requested column. */
function hasColumn(db: Database, table: string, column: string): boolean {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<
		{ name?: string } | Record<string, unknown>
	>;
	for (const row of rows) {
		if ((row as { name?: string }).name === column) {
			return true;
		}
	}
	return false;
}

/** Adds the chunks.scope column when upgrading from pre-scope schema. */
function migrateChunksScope(db: Database): void {
	if (!hasColumn(db, "chunks", "scope")) {
		db.exec("ALTER TABLE chunks ADD COLUMN scope TEXT NOT NULL DEFAULT ''");
	}
	db.exec("UPDATE chunks SET scope = '' WHERE scope IS NULL");
}

/** Rebuilds memory_blocks with (agent_id, scope, key) primary key. */
function migrateMemoryBlocksScope(db: Database): void {
	if (!hasColumn(db, "memory_blocks", "scope")) {
		db.transaction(() => {
			db.exec(`
				CREATE TABLE memory_blocks_v2 (
					agent_id    TEXT NOT NULL,
					scope       TEXT NOT NULL DEFAULT '',
					key         TEXT NOT NULL,
					value       TEXT NOT NULL,
					updated_at  TEXT NOT NULL,
					PRIMARY KEY (agent_id, scope, key)
				)
			`);
			db.exec(`
				INSERT INTO memory_blocks_v2 (agent_id, scope, key, value, updated_at)
				SELECT agent_id, '', key, value, updated_at FROM memory_blocks
			`);
			db.exec("DROP TABLE memory_blocks");
			db.exec("ALTER TABLE memory_blocks_v2 RENAME TO memory_blocks");
		})();
	}
	db.exec("UPDATE memory_blocks SET scope = '' WHERE scope IS NULL");
}

/** Ensures scope-specific indexes exist after schema/migrations run. */
function ensureScopeIndexes(db: Database): void {
	db.exec("DROP INDEX IF EXISTS idx_chunks_memory_dedup");
	db.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_memory_dedup
		ON chunks(agent_id, scope, content_hash) WHERE kind = 'memory'
	`);
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_chunks_scope
		ON chunks(agent_id, scope)
	`);
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memory_blocks_scope
		ON memory_blocks(agent_id, scope, updated_at)
	`);
}

/**
 * Apply WAL mode, busy timeout, and create tables/indexes.
 *
 * @param db - better-sqlite3 Database handle
 */
export function initSchema(db: Database): void {
	db.pragma("journal_mode=WAL");
	db.pragma("busy_timeout=5000");
	db.exec(SCHEMA_SQL);
	migrateChunksScope(db);
	migrateMemoryBlocksScope(db);
	ensureScopeIndexes(db);
}

/**
 * Verify or record the embedding model for this database.
 *
 * On first call, stores the model name. On subsequent calls, verifies
 * the configured model matches what's stored. Throws if there's a
 * mismatch — mixing embedding models produces incompatible vectors.
 *
 * @param db - better-sqlite3 Database handle
 * @param model - Embedding model identifier (e.g. "text-embedding-3-small")
 * @throws Error if model doesn't match the one already stored
 */
export function verifyEmbeddingModel(db: Database, model: string): void {
	const row = db.prepare("SELECT value FROM hippo_meta WHERE key = 'embedding_model'").get() as
		| { value: string }
		| undefined;

	if (!row) {
		db.prepare("INSERT INTO hippo_meta (key, value) VALUES ('embedding_model', ?)").run(model);
		return;
	}

	if (row.value !== model) {
		throw new Error(
			`Embedding model mismatch: database was created with "${row.value}" but server is configured with "${model}". ` +
				"Mixing models produces incompatible vectors. Re-embed the database or change the config.",
		);
	}
}
