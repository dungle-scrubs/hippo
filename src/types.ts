import type { Message } from "@mariozechner/pi-ai";
import type { Database } from "better-sqlite3";

/**
 * LLM completion interface — structurally compatible with marrow's LlmClient.
 *
 * Accepts pi-ai's Message[] so marrow's OpenRouterLlmClient can be passed
 * directly without an adapter.
 */
export interface LlmClient {
	/**
	 * Send messages with a system prompt and get a text response.
	 *
	 * @param messages - pi-ai Message array (UserMessage | AssistantMessage | ToolResultMessage)
	 * @param systemPrompt - System-level instruction
	 * @param signal - Optional abort signal
	 * @returns The model's text response
	 */
	complete(messages: Message[], systemPrompt: string, signal?: AbortSignal): Promise<string>;
}

/** Embedding function injected by the consumer. */
export type EmbedFn = (text: string, signal?: AbortSignal) => Promise<Float32Array>;

/** Chunk kind discriminator. */
export type ChunkKind = "fact" | "memory";

/** A row from the chunks table. */
export interface Chunk {
	readonly access_count: number;
	readonly agent_id: string;
	readonly content: string;
	readonly content_hash: string | null;
	readonly created_at: string;
	readonly embedding: Buffer;
	readonly id: string;
	readonly kind: ChunkKind;
	readonly last_accessed_at: string;
	readonly metadata: string | null;
	readonly encounter_count: number;
	readonly running_intensity: number;
	readonly superseded_by: string | null;
}

/** A row from the memory_blocks table. */
export interface MemoryBlock {
	readonly agent_id: string;
	readonly key: string;
	readonly updated_at: string;
	readonly value: string;
}

/** A single extracted fact from the LLM extraction pipeline. */
export interface ExtractedFact {
	readonly fact: string;
	readonly intensity: number;
}

/** Classification result for conflict resolution. */
export type ConflictClassification = "DISTINCT" | "DUPLICATE" | "SUPERSEDES";

/** Result of a search query against chunks. */
export interface SearchResult {
	readonly chunk: Chunk;
	readonly score: number;
}

/** Options for creating hippo tools. */
export interface HippoOptions {
	readonly agentId: string;
	readonly db: Database;
	readonly embed: EmbedFn;
	readonly llm: LlmClient;
	readonly messagesTable?: string;
}

/** Result summary returned by remember_facts. */
export interface RememberFactsResult {
	readonly facts: readonly RememberFactAction[];
}

/** Action taken for a single extracted fact. */
export type RememberFactAction =
	| { readonly action: "inserted"; readonly content: string; readonly intensity: number }
	| {
			readonly action: "reinforced";
			readonly content: string;
			readonly newIntensity: number;
			readonly oldIntensity: number;
	  }
	| {
			readonly action: "superseded";
			readonly content: string;
			readonly oldContent: string;
	  };
