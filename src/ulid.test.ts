import { describe, expect, it } from "vitest";
import { ulid } from "./ulid.js";

describe("ulid", () => {
	it("returns 26-character string", () => {
		expect(ulid()).toHaveLength(26);
	});

	it("uses only Crockford Base32 characters", () => {
		const id = ulid();
		expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
	});

	it("generates unique IDs", () => {
		const ids = new Set(Array.from({ length: 100 }, () => ulid()));
		expect(ids.size).toBe(100);
	});

	it("sorts lexicographically by time", () => {
		const earlier = ulid(1000000);
		const later = ulid(2000000);
		expect(earlier < later).toBe(true);
	});

	it("accepts custom timestamp", () => {
		const a = ulid(0);
		const b = ulid(0);
		// Same timestamp prefix (first 10 chars)
		expect(a.slice(0, 10)).toBe(b.slice(0, 10));
	});

	it("handles real Date.now() timestamps (> 2^32)", () => {
		const now = Date.now();
		expect(now).toBeGreaterThan(2 ** 32); // sanity: current timestamps exceed 32 bits
		const id = ulid(now);
		expect(id).toHaveLength(26);
		expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
	});

	it("preserves monotonicity at real timestamp scale", () => {
		const base = Date.now();
		const a = ulid(base);
		const b = ulid(base + 1);
		const c = ulid(base + 1000);
		// Time prefix should be monotonic
		expect(a.slice(0, 10) <= b.slice(0, 10)).toBe(true);
		expect(b.slice(0, 10) <= c.slice(0, 10)).toBe(true);
	});
});
