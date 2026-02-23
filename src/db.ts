import type { Database, Statement } from "better-sqlite3";
import type { Chunk } from "./types.js";

/** Prepared statement cache, lazily built per database handle. */
export interface DbStatements {
	readonly deleteChunk: Statement;
	readonly getActiveChunksByAgent: Statement;
	readonly getBlockByKey: Statement;
	readonly insertChunk: Statement;
	readonly reinforceChunk: Statement;
	readonly supersedeChunk: Statement;
	readonly touchChunk: Statement;
	readonly upsertBlock: Statement;
}

/**
 * Build all prepared statements for hippo operations.
 *
 * @param db - better-sqlite3 Database handle
 * @returns Prepared statement cache
 */
export function prepareStatements(db: Database): DbStatements {
	return {
		deleteChunk: db.prepare("DELETE FROM chunks WHERE id = ?"),

		getActiveChunksByAgent: db.prepare(`
			SELECT * FROM chunks
			WHERE agent_id = ? AND kind = ? AND superseded_by IS NULL
			ORDER BY last_accessed_at DESC
		`),

		getBlockByKey: db.prepare("SELECT * FROM memory_blocks WHERE agent_id = ? AND key = ?"),

		insertChunk: db.prepare(`
			INSERT INTO chunks (id, agent_id, content, content_hash, embedding, metadata,
				kind, running_intensity, encounter_count, access_count, last_accessed_at, created_at)
			VALUES (@id, @agent_id, @content, @content_hash, @embedding, @metadata,
				@kind, @running_intensity, @encounter_count, @access_count, @last_accessed_at, @created_at)
		`),

		reinforceChunk: db.prepare(`
			UPDATE chunks
			SET running_intensity = @running_intensity,
				encounter_count = encounter_count + 1,
				access_count = access_count + 1,
				last_accessed_at = @last_accessed_at
			WHERE id = @id
		`),

		supersedeChunk: db.prepare("UPDATE chunks SET superseded_by = ? WHERE id = ?"),

		touchChunk: db.prepare(`
			UPDATE chunks
			SET access_count = access_count + 1,
				running_intensity = @running_intensity,
				last_accessed_at = @last_accessed_at
			WHERE id = @id
		`),

		upsertBlock: db.prepare(`
			INSERT INTO memory_blocks (agent_id, key, value, updated_at)
			VALUES (@agent_id, @key, @value, @updated_at)
			ON CONFLICT(agent_id, key) DO UPDATE
			SET value = @value, updated_at = @updated_at
		`),
	};
}

/**
 * Get all active (non-superseded) chunks for an agent by kind.
 *
 * @param stmts - Prepared statements
 * @param agentId - Agent namespace
 * @param kind - Chunk kind ('fact' or 'memory')
 * @returns Array of chunks
 */
export function getActiveChunks(
	stmts: DbStatements,
	agentId: string,
	kind: "fact" | "memory",
): Chunk[] {
	return stmts.getActiveChunksByAgent.all(agentId, kind) as Chunk[];
}
