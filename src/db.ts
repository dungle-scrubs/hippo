import type { Database, Statement } from "better-sqlite3";
import type { Chunk, ScopeFilter } from "./types.js";

/** Prepared statement cache, lazily built per database handle. */
export interface DbStatements {
	readonly db: Database;
	readonly clearSupersededBy: Statement;
	readonly clearSupersededByScoped: Statement;
	readonly deleteChunk: Statement;
	readonly getAllActiveChunksByAgent: Statement;
	readonly getAllActiveChunksByAgentAndScope: Statement;
	readonly getActiveChunksByAgent: Statement;
	readonly getActiveChunksByAgentAndScope: Statement;
	readonly getBlockByKey: Statement;
	readonly getBlockByKeyAndScope: Statement;
	readonly getMemoryByHash: Statement;
	readonly getMemoryByHashAndScope: Statement;
	readonly insertChunk: Statement;
	readonly reinforceChunk: Statement;
	readonly supersedeChunk: Statement;
	readonly touchChunk: Statement;
	readonly upsertBlock: Statement;
}

/** Normalizes optional scope values to persisted form (empty string = global). */
export function normalizeScope(scope?: string): string {
	return scope?.trim() ?? "";
}

/** Normalizes optional scope filters to a de-duplicated list. */
function normalizeScopeFilter(filter?: ScopeFilter): readonly string[] | undefined {
	if (filter === undefined) {
		return undefined;
	}
	const raw = Array.isArray(filter) ? filter : [filter];
	const normalized = raw.map((entry) => normalizeScope(entry));
	return [...new Set(normalized)];
}

/**
 * Build all prepared statements for hippo operations.
 *
 * @param db - better-sqlite3 Database handle
 * @returns Prepared statement cache
 */
export function prepareStatements(db: Database): DbStatements {
	return {
		db,
		clearSupersededBy: db.prepare(
			"UPDATE chunks SET superseded_by = NULL WHERE superseded_by = ? AND agent_id = ?",
		),
		clearSupersededByScoped: db.prepare(
			"UPDATE chunks SET superseded_by = NULL WHERE superseded_by = ? AND agent_id = ? AND scope = ?",
		),
		deleteChunk: db.prepare("DELETE FROM chunks WHERE id = ?"),
		getAllActiveChunksByAgent: db.prepare(`
			SELECT * FROM chunks
			WHERE agent_id = ? AND superseded_by IS NULL
			ORDER BY last_accessed_at DESC
			LIMIT ?
		`),
		getAllActiveChunksByAgentAndScope: db.prepare(`
			SELECT * FROM chunks
			WHERE agent_id = ? AND scope = ? AND superseded_by IS NULL
			ORDER BY last_accessed_at DESC
			LIMIT ?
		`),
		getActiveChunksByAgent: db.prepare(`
			SELECT * FROM chunks
			WHERE agent_id = ? AND kind = ? AND superseded_by IS NULL
			ORDER BY last_accessed_at DESC
			LIMIT ?
		`),
		getActiveChunksByAgentAndScope: db.prepare(`
			SELECT * FROM chunks
			WHERE agent_id = ? AND kind = ? AND scope = ? AND superseded_by IS NULL
			ORDER BY last_accessed_at DESC
			LIMIT ?
		`),
		getBlockByKey: db.prepare(
			"SELECT * FROM memory_blocks WHERE agent_id = ? AND scope = '' AND key = ?",
		),
		getBlockByKeyAndScope: db.prepare(
			"SELECT * FROM memory_blocks WHERE agent_id = ? AND scope = ? AND key = ?",
		),
		getMemoryByHash: db.prepare(
			"SELECT * FROM chunks WHERE agent_id = ? AND content_hash = ? AND kind = 'memory' AND superseded_by IS NULL",
		),
		getMemoryByHashAndScope: db.prepare(
			"SELECT * FROM chunks WHERE agent_id = ? AND scope = ? AND content_hash = ? AND kind = 'memory' AND superseded_by IS NULL",
		),
		insertChunk: db.prepare(`
			INSERT INTO chunks (id, agent_id, scope, content, content_hash, embedding, metadata,
				kind, running_intensity, encounter_count, access_count, last_accessed_at, created_at)
			VALUES (@id, @agent_id, @scope, @content, @content_hash, @embedding, @metadata,
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
			INSERT INTO memory_blocks (agent_id, scope, key, value, updated_at)
			VALUES (@agent_id, @scope, @key, @value, @updated_at)
			ON CONFLICT(agent_id, scope, key) DO UPDATE
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
 * @param limit - Max rows to return (-1 for unlimited, default -1)
 * @param scope - Optional scope filter (single scope or list)
 * @returns Array of chunks
 */
export function getActiveChunks(
	stmts: DbStatements,
	agentId: string,
	kind: "fact" | "memory",
	limit = -1,
	scope?: ScopeFilter,
): Chunk[] {
	const scopes = normalizeScopeFilter(scope);
	if (!scopes) {
		return stmts.getActiveChunksByAgent.all(agentId, kind, limit) as Chunk[];
	}
	if (scopes.length === 1) {
		return stmts.getActiveChunksByAgentAndScope.all(agentId, kind, scopes[0], limit) as Chunk[];
	}
	const placeholders = scopes.map(() => "?").join(", ");
	const sql = `
		SELECT * FROM chunks
		WHERE agent_id = ? AND kind = ? AND scope IN (${placeholders}) AND superseded_by IS NULL
		ORDER BY last_accessed_at DESC
		LIMIT ?
	`;
	return stmts.db.prepare(sql).all(agentId, kind, ...scopes, limit) as Chunk[];
}

/**
 * Get all active (non-superseded) chunks for an agent regardless of kind.
 *
 * Single query instead of two separate kind-filtered queries.
 *
 * @param stmts - Prepared statements
 * @param agentId - Agent namespace
 * @param limit - Max rows to return (-1 for unlimited, default -1)
 * @param scope - Optional scope filter (single scope or list)
 * @returns Array of chunks (facts and memories combined)
 */
export function getAllActiveChunks(
	stmts: DbStatements,
	agentId: string,
	limit = -1,
	scope?: ScopeFilter,
): Chunk[] {
	const scopes = normalizeScopeFilter(scope);
	if (!scopes) {
		return stmts.getAllActiveChunksByAgent.all(agentId, limit) as Chunk[];
	}
	if (scopes.length === 1) {
		return stmts.getAllActiveChunksByAgentAndScope.all(agentId, scopes[0], limit) as Chunk[];
	}
	const placeholders = scopes.map(() => "?").join(", ");
	const sql = `
		SELECT * FROM chunks
		WHERE agent_id = ? AND scope IN (${placeholders}) AND superseded_by IS NULL
		ORDER BY last_accessed_at DESC
		LIMIT ?
	`;
	return stmts.db.prepare(sql).all(agentId, ...scopes, limit) as Chunk[];
}
