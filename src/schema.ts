import type { Database } from "better-sqlite3";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS hippo_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
    id                TEXT PRIMARY KEY,
    agent_id          TEXT NOT NULL,
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
    key         TEXT NOT NULL,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (agent_id, key)
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

/**
 * Apply WAL mode, busy timeout, and create tables/indexes.
 *
 * @param db - better-sqlite3 Database handle
 */
export function initSchema(db: Database): void {
	db.pragma("journal_mode=WAL");
	db.pragma("busy_timeout=5000");
	db.exec(SCHEMA_SQL);
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
