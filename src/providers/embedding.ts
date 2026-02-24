/**
 * OpenAI-compatible embedding provider.
 *
 * Calls any API that implements the `/v1/embeddings` endpoint
 * (OpenAI, OpenRouter, Ollama, vLLM, etc.) and returns a Float32Array
 * matching hippo's EmbedFn signature.
 */

import type { EmbedFn } from "../types.js";

/** Configuration for the embedding provider. */
export interface EmbeddingProviderConfig {
	/** API key for authentication (sent as Bearer token). */
	readonly apiKey: string;
	/** Base URL of the OpenAI-compatible API (e.g. "https://api.openai.com/v1"). */
	readonly baseUrl: string;
	/** Embedding dimensions to request (optional, model-dependent). */
	readonly dimensions?: number;
	/** Model identifier (e.g. "text-embedding-3-small"). */
	readonly model: string;
}

/** Shape of the OpenAI embeddings API response. */
interface EmbeddingResponse {
	readonly data: readonly [{ readonly embedding: readonly number[] }];
	readonly model: string;
	readonly usage: { readonly prompt_tokens: number; readonly total_tokens: number };
}

/**
 * Create an embedding function from OpenAI-compatible API config.
 *
 * @param config - Provider configuration
 * @returns EmbedFn that calls the API and returns Float32Array
 */
export function createEmbeddingProvider(config: EmbeddingProviderConfig): EmbedFn {
	const url = `${config.baseUrl.replace(/\/+$/, "")}/embeddings`;

	return async (text: string, signal?: AbortSignal): Promise<Float32Array> => {
		const body: Record<string, unknown> = {
			input: text,
			model: config.model,
		};
		if (config.dimensions !== undefined) {
			body.dimensions = config.dimensions;
		}

		const response = await fetch(url, {
			body: JSON.stringify(body),
			headers: {
				Authorization: `Bearer ${config.apiKey}`,
				"Content-Type": "application/json",
			},
			method: "POST",
			signal,
		});

		if (!response.ok) {
			const errorText = await response.text().catch(() => "unknown error");
			throw new Error(`Embedding API error ${response.status}: ${errorText}`);
		}

		const json = (await response.json()) as EmbeddingResponse;
		return new Float32Array(json.data[0].embedding);
	};
}
