import { describe, expect, it } from "vitest";
import { contentHash } from "./hash.js";

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

	it("handles empty string", async () => {
		const hash = await contentHash("");
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		// SHA-256 of empty string is a well-known constant
		expect(hash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	});

	it("handles unicode (emoji, CJK)", async () => {
		const emoji = await contentHash("🦛 hippo");
		const cjk = await contentHash("記憶システム");
		expect(emoji).toMatch(/^[0-9a-f]{64}$/);
		expect(cjk).toMatch(/^[0-9a-f]{64}$/);
		expect(emoji).not.toBe(cjk);
	});

	it("handles long strings", async () => {
		const long = "x".repeat(100_000);
		const hash = await contentHash(long);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});
});
