import type { EmbedFn } from "./types.js";

/**
 * Compute SHA-256 hash of content for dedup.
 *
 * @param content - Text to hash
 * @returns Hex-encoded SHA-256 hash
 */
export async function contentHash(content: string): Promise<string> {
	const encoded = new TextEncoder().encode(content);
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
	const hashArray = new Uint8Array(hashBuffer);
	return Array.from(hashArray)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Embed text using the injected embedding function.
 *
 * Thin wrapper for consistency — the consumer provides the actual
 * implementation (e.g., OpenAI text-embedding-3-small).
 *
 * @param text - Text to embed
 * @param embedFn - Embedding function
 * @returns Float32Array embedding vector
 */
export async function embedText(text: string, embedFn: EmbedFn): Promise<Float32Array> {
	return embedFn(text);
}
