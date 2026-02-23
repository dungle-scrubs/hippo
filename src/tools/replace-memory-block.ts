import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import type { DbStatements } from "../db.js";
import type { MemoryBlock } from "../types.js";

const Params = Type.Object({
	key: Type.String({ description: "Block name (e.g. 'persona', 'human')" }),
	newText: Type.String({ description: "Replacement text" }),
	oldText: Type.String({ description: "Text to find and replace" }),
});

/** Options for creating the replace_memory_block tool. */
export interface ReplaceMemoryBlockToolOptions {
	readonly agentId: string;
	readonly stmts: DbStatements;
}

/**
 * Create the replace_memory_block tool.
 *
 * Performs find/replace on a named memory block. Replaces all occurrences.
 * Returns a structured error (not a throw) if the block doesn't exist or
 * the search text isn't found.
 *
 * @param opts - Tool options
 * @returns AgentTool instance
 */
export function createReplaceMemoryBlockTool(
	opts: ReplaceMemoryBlockToolOptions,
): AgentTool<typeof Params> {
	return {
		description:
			"Find and replace text in a named memory block. Replaces all occurrences. Returns error if block doesn't exist or text not found.",
		execute: async (_toolCallId, params) => {
			const row = opts.stmts.getBlockByKey.get(opts.agentId, params.key) as MemoryBlock | undefined;

			if (!row) {
				const result: AgentToolResult<{ error: string }> = {
					content: [{ text: `Error: block "${params.key}" does not exist`, type: "text" }],
					details: { error: "block_not_found" },
				};
				return result;
			}

			if (!row.value.includes(params.oldText)) {
				const result: AgentToolResult<{ error: string }> = {
					content: [
						{
							text: `Error: text not found in block "${params.key}"`,
							type: "text",
						},
					],
					details: { error: "text_not_found" },
				};
				return result;
			}

			const newValue = row.value.replaceAll(params.oldText, params.newText);
			const now = new Date().toISOString();

			opts.stmts.upsertBlock.run({
				agent_id: opts.agentId,
				key: params.key,
				updated_at: now,
				value: newValue,
			});

			const result: AgentToolResult<{ replacements: number }> = {
				content: [{ text: `Updated block "${params.key}"`, type: "text" }],
				details: {
					replacements: row.value.split(params.oldText).length - 1,
				},
			};
			return result;
		},
		label: "Replace Memory Block",
		name: "replace_memory_block",
		parameters: Params,
	};
}
