import { describe, expect, it } from "vitest";
import { contentHash } from "./embed.js";

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
