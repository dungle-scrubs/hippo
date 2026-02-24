import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { type DbStatements, getAllActiveChunks } from "../db.js";
import { chunkEmbedding, cosineSimilarity } from "../similarity.js";
import {
	effectiveStrength,
	recencyScore,
	retrievalBoost,
	STRENGTH_FLOOR,
	searchScore,
} from "../strength.js";
import type { EmbedFn, SearchResult } from "../types.js";

/** Default maximum chunks to load for brute-force semantic search. */
const DEFAULT_MAX_SEARCH_CHUNKS = 10_000;

const Params = Type.Object({
	limit: Type.Optional(
		Type.Number({ description: "Max results to return (default: 10)", minimum: 1 }),
	),
	query: Type.String({ description: "What to search for in memory" }),
});

/** Options for creating the recall_memories tool. */
export interface RecallMemoriesToolOptions {
	readonly agentId: string;
	readonly embed: EmbedFn;
	/** Max chunks to load for brute-force search (default: 10,000). */
	readonly maxSearchChunks?: number;
	readonly stmts: DbStatements;
}

/**
 * Create the recall_memories tool.
 *
 * Performs semantic search over facts and memories, weighted by
 * cosine similarity, effective strength, and recency.
 *
 * @param opts - Tool options
 * @returns AgentTool instance
 */
export function createRecallMemoriesTool(
	opts: RecallMemoriesToolOptions,
): AgentTool<typeof Params> {
	return {
		description:
			"Semantic search over stored facts and memories. Returns results ranked by relevance, strength, and recency.",
		execute: async (_toolCallId, params, signal) => {
			const limit = params.limit ?? 10;
			const maxChunks = opts.maxSearchChunks ?? DEFAULT_MAX_SEARCH_CHUNKS;
			const now = new Date();
			const queryEmbedding = await opts.embed(params.query, signal);

			// Single query for all active chunks (facts + memories),
			// capped to avoid loading unbounded data into memory.
			const allChunks = getAllActiveChunks(opts.stmts, opts.agentId, maxChunks);

			// Score and filter
			const scored: SearchResult[] = [];
			for (const chunk of allChunks) {
				const similarity = cosineSimilarity(queryEmbedding, chunkEmbedding(chunk));

				const hoursSince =
					(now.getTime() - new Date(chunk.last_accessed_at).getTime()) / (1000 * 60 * 60);
				const strength = effectiveStrength(chunk.running_intensity, chunk.access_count, hoursSince);

				if (strength < STRENGTH_FLOOR) {
					continue;
				}

				const daysSince =
					(now.getTime() - new Date(chunk.created_at).getTime()) / (1000 * 60 * 60 * 24);
				const recency = recencyScore(daysSince);
				const score = searchScore(similarity, strength, recency);

				scored.push({ chunk, score });
			}

			// Sort by score descending, take top N
			scored.sort((a, b) => b.score - a.score);
			const topResults = scored.slice(0, limit);

			// Apply retrieval boost to accessed chunks.
			// Boost failures are non-fatal — search results are still valid.
			for (const { chunk } of topResults) {
				try {
					const boosted = retrievalBoost(chunk.running_intensity);
					opts.stmts.touchChunk.run({
						id: chunk.id,
						last_accessed_at: now.toISOString(),
						running_intensity: boosted,
					});
				} catch {
					// Retrieval boost is best-effort — a failed boost should not
					// discard valid search results.
				}
			}

			// Format response
			if (topResults.length === 0) {
				const result: AgentToolResult<{ results: readonly SearchResult[] }> = {
					content: [{ text: "No memories found.", type: "text" }],
					details: { results: [] },
				};
				return result;
			}

			const lines = topResults.map(
				(r, i) => `${i + 1}. [${r.chunk.kind}] (score: ${r.score.toFixed(3)}) ${r.chunk.content}`,
			);

			const result: AgentToolResult<{ results: readonly SearchResult[] }> = {
				content: [{ text: lines.join("\n"), type: "text" }],
				details: { results: topResults },
			};
			return result;
		},
		label: "Recall Memories",
		name: "recall_memories",
		parameters: Params,
	};
}
