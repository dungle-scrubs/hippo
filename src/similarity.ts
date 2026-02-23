/**
 * Compute cosine similarity between two Float32Array embeddings.
 *
 * @param a - First embedding vector
 * @param b - Second embedding vector
 * @returns Cosine similarity in range [-1, 1]
 * @throws If vectors have different lengths or are zero-length
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	if (a.length !== b.length) {
		throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`);
	}
	if (a.length === 0) {
		throw new Error("Cannot compute cosine similarity of zero-length vectors");
	}

	let dot = 0;
	let normA = 0;
	let normB = 0;

	for (let i = 0; i < a.length; i++) {
		// biome-ignore lint/style/noNonNullAssertion: loop bounded by length
		const ai = a[i]!;
		// biome-ignore lint/style/noNonNullAssertion: loop bounded by length
		const bi = b[i]!;
		dot += ai * bi;
		normA += ai * ai;
		normB += bi * bi;
	}

	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	if (denom === 0) {
		return 0;
	}

	return dot / denom;
}

/**
 * Deserialize embedding BLOB from SQLite into Float32Array.
 *
 * Copies through Uint8Array to guarantee 4-byte alignment.
 * better-sqlite3 typically returns offset-0 Buffers, but the spec
 * doesn't guarantee it and Float32Array requires aligned access.
 *
 * @param buf - Buffer containing raw float32 bytes
 * @returns Float32Array embedding
 */
export function bufferToEmbedding(buf: Buffer): Float32Array {
	const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
	return new Float32Array(
		bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
	);
}

/**
 * Serialize Float32Array to Buffer for SQLite BLOB storage.
 *
 * @param embedding - Float32Array embedding
 * @returns Buffer for BLOB column
 */
export function embeddingToBuffer(embedding: Float32Array): Buffer {
	return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}
