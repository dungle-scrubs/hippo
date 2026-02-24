/**
 * Server configuration — resolved from environment variables.
 *
 * All config comes from env vars. No config files. The server
 * needs: a database path, embedding API credentials, and LLM
 * API credentials.
 */

import type { EmbeddingProviderConfig } from "../providers/embedding.js";
import type { LlmProviderConfig } from "../providers/llm.js";

/** Fully resolved server configuration. */
export interface ServerConfig {
	readonly db: string;
	readonly embedding: EmbeddingProviderConfig;
	readonly llm: LlmProviderConfig;
	readonly port: number;
	readonly transport: "http" | "stdio";
}

/**
 * Read a required environment variable, throwing if missing.
 *
 * @param key - Environment variable name
 * @returns The value
 * @throws Error if the variable is not set
 */
function required(key: string): string {
	const value = process.env[key];
	if (!value) {
		throw new Error(`Missing required environment variable: ${key}`);
	}
	return value;
}

/**
 * Read an optional environment variable with a default.
 *
 * @param key - Environment variable name
 * @param fallback - Default value if not set
 * @returns The value or default
 */
function optional(key: string, fallback: string): string {
	return process.env[key] ?? fallback;
}

/**
 * Resolve server configuration from environment variables.
 *
 * Required:
 *   HIPPO_DB          — SQLite database path
 *   HIPPO_EMBED_KEY   — Embedding API key
 *   HIPPO_LLM_KEY     — LLM API key
 *
 * Optional:
 *   HIPPO_TRANSPORT        — "http" (default) or "stdio"
 *   HIPPO_PORT             — HTTP port (default: 3100)
 *   HIPPO_EMBED_URL        — Embedding base URL (default: https://api.openai.com/v1)
 *   HIPPO_EMBED_MODEL      — Embedding model (default: text-embedding-3-small)
 *   HIPPO_EMBED_DIMENSIONS — Embedding dimensions (optional)
 *   HIPPO_LLM_URL          — LLM base URL (default: https://openrouter.ai/api/v1)
 *   HIPPO_LLM_MODEL        — LLM model (default: google/gemini-flash-2.0)
 *
 * @returns Resolved ServerConfig
 */
export function resolveConfig(): ServerConfig {
	const transport = optional("HIPPO_TRANSPORT", "http") as "http" | "stdio";
	const dimensionsStr = process.env.HIPPO_EMBED_DIMENSIONS;

	return {
		db: required("HIPPO_DB"),
		embedding: {
			apiKey: required("HIPPO_EMBED_KEY"),
			baseUrl: optional("HIPPO_EMBED_URL", "https://api.openai.com/v1"),
			dimensions: dimensionsStr ? Number.parseInt(dimensionsStr, 10) : undefined,
			model: optional("HIPPO_EMBED_MODEL", "text-embedding-3-small"),
		},
		llm: {
			apiKey: required("HIPPO_LLM_KEY"),
			baseUrl: optional("HIPPO_LLM_URL", "https://openrouter.ai/api/v1"),
			model: optional("HIPPO_LLM_MODEL", "google/gemini-flash-2.0"),
		},
		port: Number.parseInt(optional("HIPPO_PORT", "3100"), 10),
		transport,
	};
}
