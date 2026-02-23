import { describe, expect, it } from "vitest";
import { bufferToEmbedding, cosineSimilarity, embeddingToBuffer } from "./similarity.js";

describe("cosineSimilarity", () => {
	it("returns 1.0 for identical vectors", () => {
		const v = new Float32Array([1, 2, 3]);
		expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
	});

	it("returns -1.0 for opposite vectors", () => {
		const a = new Float32Array([1, 0, 0]);
		const b = new Float32Array([-1, 0, 0]);
		expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
	});

	it("returns 0.0 for orthogonal vectors", () => {
		const a = new Float32Array([1, 0, 0]);
		const b = new Float32Array([0, 1, 0]);
		expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
	});

	it("is magnitude-invariant", () => {
		const a = new Float32Array([1, 2, 3]);
		const b = new Float32Array([10, 20, 30]);
		expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
	});

	it("throws on length mismatch", () => {
		const a = new Float32Array([1, 2]);
		const b = new Float32Array([1, 2, 3]);
		expect(() => cosineSimilarity(a, b)).toThrow("length mismatch");
	});

	it("throws on zero-length vectors", () => {
		const a = new Float32Array([]);
		const b = new Float32Array([]);
		expect(() => cosineSimilarity(a, b)).toThrow("zero-length");
	});

	it("returns 0 for zero-magnitude vectors", () => {
		const a = new Float32Array([0, 0, 0]);
		const b = new Float32Array([1, 2, 3]);
		expect(cosineSimilarity(a, b)).toBe(0);
	});
});

describe("bufferToEmbedding / embeddingToBuffer", () => {
	it("roundtrips Float32Array through Buffer", () => {
		const original = new Float32Array([0.1, 0.5, -0.3, 1.0]);
		const buf = embeddingToBuffer(original);
		const restored = bufferToEmbedding(buf);

		expect(restored.length).toBe(original.length);
		for (let i = 0; i < original.length; i++) {
			expect(restored[i]).toBeCloseTo(original[i]!, 5);
		}
	});

	it("preserves buffer size", () => {
		const embedding = new Float32Array([1, 2, 3]);
		const buf = embeddingToBuffer(embedding);
		expect(buf.byteLength).toBe(embedding.byteLength);
	});
});
