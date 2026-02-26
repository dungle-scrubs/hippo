import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import type { Database } from "better-sqlite3";
import { type DbStatements, getAllActiveChunks } from "../db.js";
import { chunkEmbedding, cosineSimilarity } from "../similarity.js";
import type { Chunk, EmbedFn, ScopeFilter } from "../types.js";

/** Default minimum similarity threshold for a chunk to be considered a match for deletion. */
const DEFAULT_FORGET_THRESHOLD = 0.7;

/** Default maximum chunks to load for brute-force semantic search. */
const DEFAULT_MAX_SEARCH_CHUNKS = 10_000;

const Params = Type.Object({
	description: Type.String({
		description: "Description of what to forget (e.g. 'that I like Redux')",
	}),
});

/** Options for creating the forget_memory tool. */
export interface ForgetMemoryToolOptions {
	readonly agentId: string;
	readonly db: Database;
	readonly embed: EmbedFn;
	/** Minimum cosine similarity to consider a match for deletion (default: 0.7). */
	readonly forgetThreshold?: number;
	/** Max chunks to load for brute-force search (default: 10,000). */
	readonly maxSearchChunks?: number;
	/** Optional scope filter used while finding deletable chunks. */
	readonly scope?: ScopeFilter;
	readonly stmts: DbStatements;
}

/**
 * Create the forget_memory tool.
 *
 * Hard deletes matching chunks from the database. No audit trail.
 * Deletes are wrapped in a transaction so either all matched chunks
 * are forgotten or none are.
 *
 * @param opts - Tool options
 * @returns AgentTool instance
 */
export function createForgetMemoryTool(opts: ForgetMemoryToolOptions): AgentTool<typeof Params> {
	// Wrap deletes in a transaction for atomicity. clearSupersededBy resurrects
	// any chunk whose superseded_by points at a deleted chunk. This handles
	// single-hop chains correctly (A superseded by B → forget B → A active).
	// Multi-hop chains (A→B→C) work because superseded_by is always single-hop:
	// only the directly superseded chunk references the superseder.
	const deleteMatches = opts.db.transaction((matches: Array<{ chunk: Chunk }>) => {
		for (const { chunk } of matches) {
			opts.stmts.clearSupersededByScoped.run(chunk.id, opts.agentId, chunk.scope);
			opts.stmts.deleteChunk.run(chunk.id);
		}
	});

	return {
		description:
			"Forget specific memories or facts. Performs semantic match and hard deletes matching entries. No record of the forget request is stored.",
		execute: async (_toolCallId, params, signal) => {
			const queryEmbedding = await opts.embed(params.description, signal);

			const maxChunks = opts.maxSearchChunks ?? DEFAULT_MAX_SEARCH_CHUNKS;
			const threshold = opts.forgetThreshold ?? DEFAULT_FORGET_THRESHOLD;
			const allChunks = getAllActiveChunks(opts.stmts, opts.agentId, maxChunks, opts.scope);

			// Find matching chunks above threshold
			const matches: Array<{ chunk: Chunk; similarity: number }> = [];
			for (const chunk of allChunks) {
				const similarity = cosineSimilarity(queryEmbedding, chunkEmbedding(chunk));
				if (similarity >= threshold) {
					matches.push({ chunk, similarity });
				}
			}

			if (matches.length === 0) {
				const result: AgentToolResult<{ deleted: number }> = {
					content: [{ text: "No matching memories found to forget.", type: "text" }],
					details: { deleted: 0 },
				};
				return result;
			}

			// Hard delete in a transaction — all-or-nothing.
			// Also resurrects any chunks that were superseded by deleted ones.
			deleteMatches(matches);

			const deleted = matches.map((m) => m.chunk.content);
			const result: AgentToolResult<{ deleted: number; items: readonly string[] }> = {
				content: [
					{
						text: `Forgot ${matches.length} memories:\n${deleted.map((d) => `- ${d}`).join("\n")}`,
						type: "text",
					},
				],
				details: { deleted: matches.length, items: deleted },
			};
			return result;
		},
		label: "Forget Memory",
		name: "forget_memory",
		parameters: Params,
	};
}
