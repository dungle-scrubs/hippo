import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import type { DbStatements } from "../db.js";
import type { MemoryBlock } from "../types.js";

const Params = Type.Object({
	key: Type.String({
		description: "Block name to retrieve (e.g. 'persona', 'human', 'objectives')",
	}),
});

/** Options for creating the recall_memory_block tool. */
export interface RecallMemoryBlockToolOptions {
	readonly agentId: string;
	readonly stmts: DbStatements;
}

/**
 * Create the recall_memory_block tool.
 *
 * Returns the contents of a named memory block, or null if it doesn't exist.
 *
 * @param opts - Tool options
 * @returns AgentTool instance
 */
export function createRecallMemoryBlockTool(
	opts: RecallMemoryBlockToolOptions,
): AgentTool<typeof Params> {
	return {
		description:
			"Retrieve the contents of a named memory block. Returns null if the block doesn't exist.",
		execute: async (_toolCallId, params) => {
			const row = opts.stmts.getBlockByKey.get(opts.agentId, params.key) as MemoryBlock | undefined;

			const result: AgentToolResult<{ value: string | null }> = {
				content: [
					{
						text: row ? row.value : "null",
						type: "text",
					},
				],
				details: { value: row?.value ?? null },
			};
			return result;
		},
		label: "Recall Memory Block",
		name: "recall_memory_block",
		parameters: Params,
	};
}
