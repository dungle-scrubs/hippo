import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHippoTools } from "./index.js";
import type { EmbedFn, LlmClient } from "./types.js";

describe("createHippoTools", () => {
	let db: Database.Database;

	const mockLlm: LlmClient = {
		complete: vi.fn(async () => "[]"),
	};
	const mockEmbed: EmbedFn = vi.fn(async () => new Float32Array([0.1, 0.2, 0.3]));

	beforeEach(() => {
		db = new Database(":memory:");
	});

	afterEach(() => {
		db.close();
	});

	it("returns 7 tools without messagesTable", () => {
		const tools = createHippoTools({
			agentId: "test",
			db,
			embed: mockEmbed,
			llm: mockLlm,
		});

		expect(tools).toHaveLength(7);

		const names = tools.map((t) => t.name).sort();
		expect(names).toEqual([
			"append_memory_block",
			"forget_memory",
			"recall_memories",
			"recall_memory_block",
			"remember_facts",
			"replace_memory_block",
			"store_memory",
		]);
	});

	it("returns 8 tools with messagesTable", () => {
		const tools = createHippoTools({
			agentId: "test",
			db,
			embed: mockEmbed,
			llm: mockLlm,
			messagesTable: "messages",
		});

		expect(tools).toHaveLength(8);

		const names = tools.map((t) => t.name);
		expect(names).toContain("recall_conversation");
	});

	it("initializes schema (tables exist after creation)", () => {
		createHippoTools({
			agentId: "test",
			db,
			embed: mockEmbed,
			llm: mockLlm,
		});

		const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
			name: string;
		}>;
		const tableNames = tables.map((t) => t.name);

		expect(tableNames).toContain("chunks");
		expect(tableNames).toContain("memory_blocks");
	});

	it("is idempotent (calling twice doesn't error)", () => {
		const opts = { agentId: "test", db, embed: mockEmbed, llm: mockLlm };

		createHippoTools(opts);
		expect(() => createHippoTools(opts)).not.toThrow();
	});

	it("all tools have required properties", () => {
		const tools = createHippoTools({
			agentId: "test",
			db,
			embed: mockEmbed,
			llm: mockLlm,
			messagesTable: "messages",
		});

		for (const tool of tools) {
			expect(tool.name).toBeTruthy();
			expect(tool.label).toBeTruthy();
			expect(tool.description).toBeTruthy();
			expect(tool.parameters).toBeTruthy();
			expect(typeof tool.execute).toBe("function");
		}
	});
});
