import { createHash } from "node:crypto";

/**
 * Compute SHA-256 hash of content for dedup.
 *
 * Synchronous — matches the sync SQLite layer. Uses node:crypto
 * instead of the async Web Crypto API.
 *
 * @param content - Text to hash
 * @returns Hex-encoded SHA-256 hash
 */
export function contentHash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}
