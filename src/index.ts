import type { AgentTool } from "@mariozechner/pi-agent-core";
import { prepareStatements } from "./db.js";
import { initSchema } from "./schema.js";
import {
	createAppendMemoryBlockTool,
	createForgetMemoryTool,
	createRecallConversationTool,
	createRecallMemoriesTool,
	createRecallMemoryBlockTool,
	createRememberFactsTool,
	createReplaceMemoryBlockTool,
	createStoreMemoryTool,
} from "./tools/index.js";
import type { HippoOptions } from "./types.js";

/**
 * Create all hippo memory tools for an agent.
 *
 * Initializes the SQLite schema (idempotent) and returns AgentTool
 * instances ready to pass to MarrowAgent via `extraTools`.
 *
 * @param opts - Configuration options
 * @returns Array of AgentTool instances (7 or 8 depending on messagesTable)
 */
// biome-ignore lint/suspicious/noExplicitAny: AgentTool generics don't unify across different parameter schemas
export function createHippoTools(opts: HippoOptions): AgentTool<any>[] {
	initSchema(opts.db);
	const stmts = prepareStatements(opts.db);

	const common = { agentId: opts.agentId, stmts };
	const withEmbed = { ...common, embed: opts.embed };

	// biome-ignore lint/suspicious/noExplicitAny: AgentTool generics don't unify across different parameter schemas
	const tools: AgentTool<any>[] = [
		createRememberFactsTool({ ...withEmbed, llm: opts.llm }),
		createStoreMemoryTool(withEmbed),
		createRecallMemoriesTool(withEmbed),
		createRecallMemoryBlockTool(common),
		createReplaceMemoryBlockTool(common),
		createAppendMemoryBlockTool(common),
		createForgetMemoryTool({ ...withEmbed, db: opts.db }),
	];

	if (opts.messagesTable) {
		tools.push(
			createRecallConversationTool({
				db: opts.db,
				messagesTable: opts.messagesTable,
			}),
		);
	}

	return tools;
}

export { initSchema } from "./schema.js";
// Re-export types for consumers
export type { ChunkKind, EmbedFn, HippoOptions, LlmClient } from "./types.js";
