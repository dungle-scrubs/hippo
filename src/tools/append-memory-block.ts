import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { type DbStatements, normalizeScope } from "../db.js";
import type { MemoryBlock } from "../types.js";

/** Threshold in bytes at which the tool warns about block size. */
const BLOCK_SIZE_WARNING_BYTES = 100_000;

const Params = Type.Object({
	content: Type.String({ description: "Text to append to the block" }),
	key: Type.String({ description: "Block name (e.g. 'persona', 'human', 'objectives')" }),
});

/** Options for creating the append_memory_block tool. */
export interface AppendMemoryBlockToolOptions {
	readonly agentId: string;
	readonly scope?: string;
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
			const scope = normalizeScope(opts.scope);
			const existing = opts.stmts.getBlockByKeyAndScope.get(opts.agentId, scope, params.key) as
				| MemoryBlock
				| undefined;

			const newValue = existing ? `${existing.value}\n${params.content}` : params.content;

			opts.stmts.upsertBlock.run({
				agent_id: opts.agentId,
				scope,
				key: params.key,
				updated_at: now,
				value: newValue,
			});

			const action = existing ? "appended to" : "created";
			const sizeBytes = new TextEncoder().encode(newValue).byteLength;
			const warning =
				sizeBytes > BLOCK_SIZE_WARNING_BYTES
					? ` (warning: block is ${Math.round(sizeBytes / 1024)}KB — consider using replace_memory_block to trim)`
					: "";
			const result: AgentToolResult<{ action: string; sizeBytes: number }> = {
				content: [{ text: `${action} block "${params.key}"${warning}`, type: "text" }],
				details: { action, sizeBytes },
			};
			return result;
		},
		label: "Append Memory Block",
		name: "append_memory_block",
		parameters: Params,
	};
}
