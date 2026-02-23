import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import type { DbStatements } from "../db.js";
import { contentHash, embedText } from "../embed.js";
import { embeddingToBuffer } from "../similarity.js";
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
		execute: async (_toolCallId, params) => {
			const now = new Date().toISOString();
			const hash = await contentHash(params.content);

			// Check for verbatim duplicate via unique index
			const existing = opts.stmts.getActiveChunksByAgent
				.all(opts.agentId, "memory")
				.find((c) => (c as Chunk).content_hash === hash) as Chunk | undefined;

			if (existing) {
				// Strengthen existing memory
				opts.stmts.reinforceChunk.run({
					id: existing.id,
					last_accessed_at: now,
					running_intensity: existing.running_intensity,
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
			const embedding = await embedText(params.content, opts.embed);

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

			const result: AgentToolResult<{ action: "stored" }> = {
				content: [{ text: `Stored memory: "${params.content.slice(0, 80)}..."`, type: "text" }],
				details: { action: "stored" },
			};
			return result;
		},
		label: "Store Memory",
		name: "store_memory",
		parameters: Params,
	};
}
