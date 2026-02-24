import { describe, expect, it } from "vitest";
import { contentHash } from "./hash.js";

describe("contentHash", () => {
	it("returns consistent hex hash for same input", () => {
		const hash1 = contentHash("hello world");
		const hash2 = contentHash("hello world");
		expect(hash1).toBe(hash2);
	});

	it("returns different hashes for different input", () => {
		const hash1 = contentHash("hello");
		const hash2 = contentHash("world");
		expect(hash1).not.toBe(hash2);
	});

	it("returns 64-char hex string (SHA-256)", () => {
		const hash = contentHash("test");
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("handles empty string", () => {
		const hash = contentHash("");
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		// SHA-256 of empty string is a well-known constant
		expect(hash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	});

	it("handles unicode (emoji, CJK)", () => {
		const emoji = contentHash("🦛 hippo");
		const cjk = contentHash("記憶システム");
		expect(emoji).toMatch(/^[0-9a-f]{64}$/);
		expect(cjk).toMatch(/^[0-9a-f]{64}$/);
		expect(emoji).not.toBe(cjk);
	});

	it("handles long strings", () => {
		const long = "x".repeat(100_000);
		const hash = contentHash(long);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});
});
