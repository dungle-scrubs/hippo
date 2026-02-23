import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { type DbStatements, getActiveChunks } from "../db.js";
import { embedText } from "../embed.js";
import { bufferToEmbedding, cosineSimilarity } from "../similarity.js";
import type { Chunk, EmbedFn } from "../types.js";

/** Minimum similarity threshold for a chunk to be considered a match for deletion. */
const FORGET_THRESHOLD = 0.7;

const Params = Type.Object({
	description: Type.String({
		description: "Description of what to forget (e.g. 'that I like Redux')",
	}),
});

/** Options for creating the forget_memory tool. */
export interface ForgetMemoryToolOptions {
	readonly agentId: string;
	readonly embed: EmbedFn;
	readonly stmts: DbStatements;
}

/**
 * Create the forget_memory tool.
 *
 * Hard deletes matching chunks from the database. No audit trail.
 *
 * @param opts - Tool options
 * @returns AgentTool instance
 */
export function createForgetMemoryTool(opts: ForgetMemoryToolOptions): AgentTool<typeof Params> {
	return {
		description:
			"Forget specific memories or facts. Performs semantic match and hard deletes matching entries. No record of the forget request is stored.",
		execute: async (_toolCallId, params) => {
			const queryEmbedding = await embedText(params.description, opts.embed);

			const facts = getActiveChunks(opts.stmts, opts.agentId, "fact");
			const memories = getActiveChunks(opts.stmts, opts.agentId, "memory");
			const allChunks = [...facts, ...memories];

			// Find matching chunks above threshold
			const matches: Array<{ chunk: Chunk; similarity: number }> = [];
			for (const chunk of allChunks) {
				const chunkEmbedding = bufferToEmbedding(chunk.embedding as unknown as Buffer);
				const similarity = cosineSimilarity(queryEmbedding, chunkEmbedding);
				if (similarity >= FORGET_THRESHOLD) {
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

			// Hard delete
			for (const { chunk } of matches) {
				opts.stmts.deleteChunk.run(chunk.id);
			}

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
