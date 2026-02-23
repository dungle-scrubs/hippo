import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { type DbStatements, getActiveChunks } from "../db.js";
import { bufferToEmbedding, cosineSimilarity } from "../similarity.js";
import {
	effectiveStrength,
	recencyScore,
	retrievalBoost,
	STRENGTH_FLOOR,
	searchScore,
} from "../strength.js";
import type { EmbedFn, SearchResult } from "../types.js";

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
		execute: async (_toolCallId, params) => {
			const limit = params.limit ?? 10;
			const now = new Date();
			const queryEmbedding = await opts.embed(params.query);

			// Gather all active chunks (both facts and memories)
			const facts = getActiveChunks(opts.stmts, opts.agentId, "fact");
			const memories = getActiveChunks(opts.stmts, opts.agentId, "memory");
			const allChunks = [...facts, ...memories];

			// Score and filter
			const scored: SearchResult[] = [];
			for (const chunk of allChunks) {
				const chunkEmbedding = bufferToEmbedding(chunk.embedding as unknown as Buffer);
				const similarity = cosineSimilarity(queryEmbedding, chunkEmbedding);

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

			// Apply retrieval boost to accessed chunks
			for (const { chunk } of topResults) {
				const boosted = retrievalBoost(chunk.running_intensity);
				opts.stmts.touchChunk.run({
					id: chunk.id,
					last_accessed_at: now.toISOString(),
					running_intensity: boosted,
				});
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
