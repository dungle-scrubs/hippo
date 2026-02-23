import { describe, expect, it } from "vitest";
import { contentHash, embedText } from "./embed.js";

describe("contentHash", () => {
	it("returns consistent hex hash for same input", async () => {
		const hash1 = await contentHash("hello world");
		const hash2 = await contentHash("hello world");
		expect(hash1).toBe(hash2);
	});

	it("returns different hashes for different input", async () => {
		const hash1 = await contentHash("hello");
		const hash2 = await contentHash("world");
		expect(hash1).not.toBe(hash2);
	});

	it("returns 64-char hex string (SHA-256)", async () => {
		const hash = await contentHash("test");
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("embedText", () => {
	it("delegates to the provided embed function", async () => {
		const mockEmbed = async (_text: string): Promise<Float32Array> =>
			new Float32Array([0.1, 0.2, 0.3]);

		const result = await embedText("test", mockEmbed);
		expect(result).toBeInstanceOf(Float32Array);
		expect(result.length).toBe(3);
	});
});
