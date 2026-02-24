import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import type { DbStatements } from "../db.js";
import { contentHash } from "../hash.js";
import { embeddingToBuffer } from "../similarity.js";
import { updatedIntensity } from "../strength.js";
import type { Chunk, EmbedFn } from "../types.js";
import { ulid } from "../ulid.js";

const Params = Type.Object({
	content: Type.String({ description: "Content to store as a memory" }),
	metadata: Type.Optional(
		Type.String({
			description: 'Optional JSON metadata (e.g. {"source": "pdf", "tags": ["auth"]})',
		}),
	),
});

/** Options for creating the store_memory tool. */
export interface StoreMemoryToolOptions {
	readonly agentId: string;
	readonly embed: EmbedFn;
	readonly stmts: DbStatements;
}

/**
 * Check if an error is a SQLite UNIQUE constraint violation.
 *
 * @param err - Unknown error value
 * @returns True if this is a UNIQUE constraint error
 */
function isSqliteConstraintUnique(err: unknown): boolean {
	return (
		err instanceof Error &&
		"code" in err &&
		(err as Error & { code: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
	);
}

/**
 * Create the store_memory tool.
 *
 * Embeds content, deduplicates by content hash, and inserts or strengthens.
 * Verbatim duplicates are strengthened (encounter_count + 1), not re-inserted.
 *
 * @param opts - Tool options
 * @returns AgentTool instance
 */
export function createStoreMemoryTool(opts: StoreMemoryToolOptions): AgentTool<typeof Params> {
	return {
		description:
			"Store a raw memory (document chunk, experience, decision). Deduplicates by content hash — identical content strengthens the existing memory.",
		execute: async (_toolCallId, params, signal) => {
			if (params.metadata !== undefined) {
				try {
					JSON.parse(params.metadata);
				} catch {
					throw new Error(`Invalid JSON in metadata parameter: ${params.metadata.slice(0, 100)}`);
				}
			}

			const now = new Date().toISOString();
			const hash = contentHash(params.content);

			// Check for verbatim duplicate using the content_hash index
			const existing = opts.stmts.getMemoryByHash.get(opts.agentId, hash) as Chunk | undefined;

			if (existing) {
				// Strengthen existing memory — treat re-encounter at default intensity (0.5)
				const newIntensity = updatedIntensity(
					existing.running_intensity,
					existing.encounter_count,
					0.5,
				);
				opts.stmts.reinforceChunk.run({
					id: existing.id,
					last_accessed_at: now,
					running_intensity: newIntensity,
				});

				const result: AgentToolResult<{ action: "strengthened" }> = {
					content: [
						{
							text: `Memory already exists (strengthened, encounters: ${existing.encounter_count + 1})`,
							type: "text",
						},
					],
					details: { action: "strengthened" },
				};
				return result;
			}

			// New memory — embed and insert
			const embedding = await opts.embed(params.content, signal);

			try {
				opts.stmts.insertChunk.run({
					access_count: 0,
					agent_id: opts.agentId,
					content: params.content,
					content_hash: hash,
					created_at: now,
					embedding: embeddingToBuffer(embedding),
					encounter_count: 1,
					id: ulid(),
					kind: "memory",
					last_accessed_at: now,
					metadata: params.metadata ?? null,
					running_intensity: 0.5,
				});
			} catch (err: unknown) {
				// TOCTOU: another call inserted the same content between our hash check
				// and this insert (the await embed() yields the event loop). Fall back to strengthen.
				if (isSqliteConstraintUnique(err)) {
					const race = opts.stmts.getMemoryByHash.get(opts.agentId, hash) as Chunk | undefined;
					if (race) {
						const newIntensity = updatedIntensity(
							race.running_intensity,
							race.encounter_count,
							0.5,
						);
						opts.stmts.reinforceChunk.run({
							id: race.id,
							last_accessed_at: now,
							running_intensity: newIntensity,
						});
						const result: AgentToolResult<{ action: "strengthened" }> = {
							content: [
								{
									text: `Memory already exists (strengthened, encounters: ${race.encounter_count + 1})`,
									type: "text",
								},
							],
							details: { action: "strengthened" },
						};
						return result;
					}
				}
				throw err;
			}

			const preview =
				params.content.length > 80 ? `${params.content.slice(0, 80)}...` : params.content;
			const result: AgentToolResult<{ action: "stored" }> = {
				content: [{ text: `Stored memory: "${preview}"`, type: "text" }],
				details: { action: "stored" },
			};
			return result;
		},
		label: "Store Memory",
		name: "store_memory",
		parameters: Params,
	};
}
