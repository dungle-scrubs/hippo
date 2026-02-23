import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import type { DbStatements } from "../db.js";
import type { MemoryBlock } from "../types.js";

const Params = Type.Object({
	content: Type.String({ description: "Text to append to the block" }),
	key: Type.String({ description: "Block name (e.g. 'persona', 'human', 'objectives')" }),
});

/** Options for creating the append_memory_block tool. */
export interface AppendMemoryBlockToolOptions {
	readonly agentId: string;
	readonly stmts: DbStatements;
}

/**
 * Create the append_memory_block tool.
 *
 * Appends text to a named memory block. Creates the block if it doesn't exist.
 *
 * @param opts - Tool options
 * @returns AgentTool instance
 */
export function createAppendMemoryBlockTool(
	opts: AppendMemoryBlockToolOptions,
): AgentTool<typeof Params> {
	return {
		description:
			"Append text to a named memory block. Creates the block if it doesn't exist (upsert).",
		execute: async (_toolCallId, params) => {
			const now = new Date().toISOString();
			const existing = opts.stmts.getBlockByKey.get(opts.agentId, params.key) as
				| MemoryBlock
				| undefined;

			const newValue = existing ? `${existing.value}\n${params.content}` : params.content;

			opts.stmts.upsertBlock.run({
				agent_id: opts.agentId,
				key: params.key,
				updated_at: now,
				value: newValue,
			});

			const action = existing ? "appended to" : "created";
			const result: AgentToolResult<{ action: string }> = {
				content: [{ text: `${action} block "${params.key}"`, type: "text" }],
				details: { action },
			};
			return result;
		},
		label: "Append Memory Block",
		name: "append_memory_block",
		parameters: Params,
	};
}
