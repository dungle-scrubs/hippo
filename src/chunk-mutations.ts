import type { Database } from "better-sqlite3";
import { contentHash } from "./hash.js";
import { embeddingToBuffer } from "./similarity.js";
import type { Chunk, EmbedFn } from "./types.js";

interface UpdateChunkParams {
	readonly content: string;
	readonly content_hash: string | null;
	readonly created_at: string;
	readonly embedding: Buffer;
	readonly id: string;
	readonly last_accessed_at: string;
}

/**
 * Load a chunk row by ID.
 *
 * @param db - SQLite handle
 * @param chunkId - Chunk identifier
 * @returns The chunk row if found, otherwise undefined
 */
function getChunkById(db: Database, chunkId: string): Chunk | undefined {
	return db.prepare("SELECT * FROM chunks WHERE id = ?").get(chunkId) as Chunk | undefined;
}

/**
 * Update a chunk's content and embedding.
 *
 * Recomputes embedding and content hash, then applies all chunk updates in
 * a single SQLite transaction.
 *
 * @param db - SQLite handle
 * @param embed - Embedding function used to generate the new vector
 * @param chunkId - Chunk ID to update
 * @param newContent - New chunk content
 * @returns The updated chunk row
 * @throws Error when the chunk does not exist
 */
export async function updateChunk(
	db: Database,
	embed: EmbedFn,
	chunkId: string,
	newContent: string,
): Promise<Chunk> {
	const existing = getChunkById(db, chunkId);
	if (!existing) {
		throw new Error(`Chunk not found: ${chunkId}`);
	}

	const now = new Date().toISOString();
	const nextEmbedding = await embed(newContent);
	const params: UpdateChunkParams = {
		content: newContent,
		content_hash: existing.kind === "memory" ? contentHash(newContent) : null,
		created_at: now,
		embedding: embeddingToBuffer(nextEmbedding),
		id: chunkId,
		last_accessed_at: now,
	};

	const runUpdate = db.transaction((txParams: UpdateChunkParams): Chunk => {
		const result = db
			.prepare(
				`UPDATE chunks
				 SET content = @content,
				 	 content_hash = @content_hash,
				 	 created_at = @created_at,
				 	 embedding = @embedding,
				 	 last_accessed_at = @last_accessed_at
				 WHERE id = @id`,
			)
			.run(txParams);

		if (result.changes === 0) {
			throw new Error(`Chunk not found: ${txParams.id}`);
		}

		const updated = getChunkById(db, txParams.id);
		if (!updated) {
			throw new Error(`Chunk disappeared during update: ${txParams.id}`);
		}
		return updated;
	});

	return runUpdate(params);
}

/**
 * Hard-delete a chunk by ID.
 *
 * Clears any `superseded_by` references that point at the deleted chunk so
 * older superseded chunks become active again.
 *
 * @param db - SQLite handle
 * @param chunkId - Chunk ID to delete
 * @returns True when a chunk was deleted, otherwise false
 */
export function deleteChunk(db: Database, chunkId: string): boolean {
	const runDelete = db.transaction((id: string): boolean => {
		const result = db.prepare("DELETE FROM chunks WHERE id = ?").run(id);
		if (result.changes === 0) {
			return false;
		}

		db.prepare("UPDATE chunks SET superseded_by = NULL WHERE superseded_by = ?").run(id);
		return true;
	});

	return runDelete(chunkId);
}
