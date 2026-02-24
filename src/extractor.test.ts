import { describe, expect, it, vi } from "vitest";
import { classifyConflict, extractFacts } from "./extractor.js";
import type { LlmClient } from "./types.js";

/** Create a mock LlmClient that returns a canned response. */
function mockLlm(response: string): LlmClient {
	return {
		complete: vi.fn().mockResolvedValue(response),
	};
}

describe("extractFacts", () => {
	it("extracts facts from a clean JSON response", async () => {
		const llm = mockLlm(
			'[{"fact": "User likes TypeScript", "intensity": 0.6}, {"fact": "User lives in Bangkok", "intensity": 0.3}]',
		);

		const facts = await extractFacts("I really like TypeScript. I live in Bangkok.", llm);

		expect(facts).toHaveLength(2);
		expect(facts[0]).toEqual({ fact: "User likes TypeScript", intensity: 0.6 });
		expect(facts[1]).toEqual({ fact: "User lives in Bangkok", intensity: 0.3 });
	});

	it("handles markdown-fenced JSON", async () => {
		const llm = mockLlm('```json\n[{"fact": "User dislikes Redux", "intensity": 0.85}]\n```');

		const facts = await extractFacts("I hate Redux", llm);

		expect(facts).toHaveLength(1);
		expect(facts[0]?.fact).toBe("User dislikes Redux");
	});

	it("clamps intensity above 1.0 to 1.0", async () => {
		const llm = mockLlm('[{"fact": "test", "intensity": 1.5}]');

		const facts = await extractFacts("test", llm);

		expect(facts[0]?.intensity).toBe(1.0);
	});

	it("clamps intensity below 0.0 to 0.0", async () => {
		const llm = mockLlm('[{"fact": "test", "intensity": -0.3}]');

		const facts = await extractFacts("test", llm);

		expect(facts[0]?.intensity).toBe(0.0);
	});

	it("returns empty array for unparseable response", async () => {
		const llm = mockLlm("I don't understand the request");

		const facts = await extractFacts("test", llm);

		expect(facts).toEqual([]);
	});

	it("returns empty array for empty JSON array", async () => {
		const llm = mockLlm("[]");

		const facts = await extractFacts("How's the weather?", llm);

		expect(facts).toEqual([]);
	});

	it("filters out malformed entries", async () => {
		const llm = mockLlm(
			'[{"fact": "valid", "intensity": 0.5}, {"wrong": "shape"}, {"fact": 123, "intensity": "bad"}]',
		);

		const facts = await extractFacts("test", llm);

		expect(facts).toHaveLength(1);
		expect(facts[0]?.fact).toBe("valid");
	});

	it("trims whitespace from facts", async () => {
		const llm = mockLlm('[{"fact": "  padded fact  ", "intensity": 0.5}]');

		const facts = await extractFacts("test", llm);

		expect(facts[0]?.fact).toBe("padded fact");
	});

	it("passes abort signal to LLM", async () => {
		const llm = mockLlm("[]");
		const controller = new AbortController();

		await extractFacts("test", llm, controller.signal);

		expect(llm.complete).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			controller.signal,
		);
	});

	it("filters out empty/whitespace-only facts after trim", async () => {
		const llm = mockLlm(
			'[{"fact": "  ", "intensity": 0.5}, {"fact": "", "intensity": 0.3}, {"fact": "valid fact", "intensity": 0.6}]',
		);

		const facts = await extractFacts("test", llm);

		expect(facts).toHaveLength(1);
		expect(facts[0]?.fact).toBe("valid fact");
	});

	it("returns empty array for object-wrapped JSON (not a raw array)", async () => {
		const llm = mockLlm('{"facts": [{"fact": "test", "intensity": 0.5}]}');

		const facts = await extractFacts("test", llm);

		expect(facts).toEqual([]);
	});
});

describe("classifyConflict", () => {
	it("returns DUPLICATE for duplicate response", async () => {
		const llm = mockLlm("DUPLICATE");
		const result = await classifyConflict("User lives in Berlin", "User's city is Berlin", llm);
		expect(result).toBe("DUPLICATE");
	});

	it("returns SUPERSEDES for superseding response", async () => {
		const llm = mockLlm("SUPERSEDES");
		const result = await classifyConflict("User lives in Bangkok", "User lives in Berlin", llm);
		expect(result).toBe("SUPERSEDES");
	});

	it("returns DISTINCT for distinct response", async () => {
		const llm = mockLlm("DISTINCT");
		const result = await classifyConflict("User likes TS", "User likes Rust", llm);
		expect(result).toBe("DISTINCT");
	});

	it("handles lowercase responses", async () => {
		const llm = mockLlm("duplicate");
		const result = await classifyConflict("a", "b", llm);
		expect(result).toBe("DUPLICATE");
	});

	it("defaults to DISTINCT for garbage responses", async () => {
		const llm = mockLlm("I think these are similar but not quite the same");
		const result = await classifyConflict("a", "b", llm);
		expect(result).toBe("DISTINCT");
	});

	it("extracts classification when LLM adds trailing explanation", async () => {
		const llm = mockLlm("SUPERSEDES\n\nThe user's city has changed from Berlin to Bangkok.");
		const result = await classifyConflict("User lives in Bangkok", "User lives in Berlin", llm);
		expect(result).toBe("SUPERSEDES");
	});

	it("extracts classification when LLM adds inline explanation", async () => {
		const llm = mockLlm("DUPLICATE — same information, just reworded");
		const result = await classifyConflict("User likes TS", "User enjoys TypeScript", llm);
		expect(result).toBe("DUPLICATE");
	});

	it("passes abort signal to LLM", async () => {
		const llm = mockLlm("DISTINCT");
		const controller = new AbortController();

		await classifyConflict("a", "b", llm, controller.signal);

		expect(llm.complete).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			controller.signal,
		);
	});

	it("strips markdown bold formatting from classification", async () => {
		const llm = mockLlm("**DUPLICATE**");
		const result = await classifyConflict("a", "b", llm);
		expect(result).toBe("DUPLICATE");
	});

	it("strips backtick formatting from classification", async () => {
		const llm = mockLlm("`SUPERSEDES`");
		const result = await classifyConflict("a", "b", llm);
		expect(result).toBe("SUPERSEDES");
	});

	it("strips quotes from classification", async () => {
		const llm = mockLlm('"DUPLICATE"');
		const result = await classifyConflict("a", "b", llm);
		expect(result).toBe("DUPLICATE");
	});

	it("defaults to DISTINCT for empty response", async () => {
		const llm = mockLlm("");
		const result = await classifyConflict("a", "b", llm);
		expect(result).toBe("DISTINCT");
	});

	it("defaults to DISTINCT for whitespace-only response", async () => {
		const llm = mockLlm("   \n\t  ");
		const result = await classifyConflict("a", "b", llm);
		expect(result).toBe("DISTINCT");
	});
});
