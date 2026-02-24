import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbStatements } from "../db.js";
import { prepareStatements } from "../db.js";
import { initSchema } from "../schema.js";
import type { MemoryBlock } from "../types.js";
import { createAppendMemoryBlockTool } from "./append-memory-block.js";
import { createRecallMemoryBlockTool } from "./recall-memory-block.js";
import { createReplaceMemoryBlockTool } from "./replace-memory-block.js";

const AGENT_ID = "test-agent";

describe("memory block tools", () => {
	let db: Database.Database;
	let stmts: DbStatements;

	beforeEach(() => {
		db = new Database(":memory:");
		initSchema(db);
		stmts = prepareStatements(db);
	});

	afterEach(() => {
		db.close();
	});

	describe("recall_memory_block", () => {
		it("returns null for non-existent block", async () => {
			const tool = createRecallMemoryBlockTool({ agentId: AGENT_ID, stmts });
			const result = await tool.execute("tc1", { key: "persona" });

			expect(result.content[0]).toMatchObject({ text: "null", type: "text" });
			expect(result.details.value).toBeNull();
		});

		it("returns block value when it exists", async () => {
			stmts.upsertBlock.run({
				agent_id: AGENT_ID,
				key: "persona",
				updated_at: new Date().toISOString(),
				value: "A helpful assistant",
			});

			const tool = createRecallMemoryBlockTool({ agentId: AGENT_ID, stmts });
			const result = await tool.execute("tc1", { key: "persona" });

			expect(result.details.value).toBe("A helpful assistant");
		});

		it("isolates blocks by agent_id", async () => {
			stmts.upsertBlock.run({
				agent_id: "other-agent",
				key: "persona",
				updated_at: new Date().toISOString(),
				value: "Other agent persona",
			});

			const tool = createRecallMemoryBlockTool({ agentId: AGENT_ID, stmts });
			const result = await tool.execute("tc1", { key: "persona" });

			expect(result.details.value).toBeNull();
		});
	});

	describe("append_memory_block", () => {
		it("creates a new block when it doesn't exist", async () => {
			const tool = createAppendMemoryBlockTool({ agentId: AGENT_ID, stmts });
			const result = await tool.execute("tc1", {
				content: "First line",
				key: "objectives",
			});

			expect(result.details.action).toBe("created");

			const row = stmts.getBlockByKey.get(AGENT_ID, "objectives") as MemoryBlock;
			expect(row.value).toBe("First line");
		});

		it("updates updated_at timestamp on append", async () => {
			stmts.upsertBlock.run({
				agent_id: AGENT_ID,
				key: "objectives",
				updated_at: "2020-01-01T00:00:00.000Z",
				value: "Initial",
			});

			const tool = createAppendMemoryBlockTool({ agentId: AGENT_ID, stmts });
			await tool.execute("tc1", { content: "Appended", key: "objectives" });

			const row = stmts.getBlockByKey.get(AGENT_ID, "objectives") as MemoryBlock;
			expect(row.updated_at > "2020-01-01T00:00:00.000Z").toBe(true);
		});

		it("appends to existing block with newline separator", async () => {
			stmts.upsertBlock.run({
				agent_id: AGENT_ID,
				key: "objectives",
				updated_at: new Date().toISOString(),
				value: "First line",
			});

			const tool = createAppendMemoryBlockTool({ agentId: AGENT_ID, stmts });
			await tool.execute("tc1", { content: "Second line", key: "objectives" });

			const row = stmts.getBlockByKey.get(AGENT_ID, "objectives") as MemoryBlock;
			expect(row.value).toBe("First line\nSecond line");
		});
	});

	describe("replace_memory_block", () => {
		it("returns error for non-existent block", async () => {
			const tool = createReplaceMemoryBlockTool({ agentId: AGENT_ID, stmts });
			const result = await tool.execute("tc1", {
				key: "persona",
				newText: "new",
				oldText: "old",
			});

			expect(result.details.error).toBe("block_not_found");
		});

		it("returns error when text not found", async () => {
			stmts.upsertBlock.run({
				agent_id: AGENT_ID,
				key: "persona",
				updated_at: new Date().toISOString(),
				value: "A helpful assistant",
			});

			const tool = createReplaceMemoryBlockTool({ agentId: AGENT_ID, stmts });
			const result = await tool.execute("tc1", {
				key: "persona",
				newText: "new",
				oldText: "nonexistent text",
			});

			expect(result.details.error).toBe("text_not_found");
		});

		it("replaces text in block", async () => {
			stmts.upsertBlock.run({
				agent_id: AGENT_ID,
				key: "persona",
				updated_at: new Date().toISOString(),
				value: "A helpful assistant who likes cats",
			});

			const tool = createReplaceMemoryBlockTool({ agentId: AGENT_ID, stmts });
			await tool.execute("tc1", {
				key: "persona",
				newText: "dogs",
				oldText: "cats",
			});

			const row = stmts.getBlockByKey.get(AGENT_ID, "persona") as MemoryBlock;
			expect(row.value).toBe("A helpful assistant who likes dogs");
		});

		it("handles overlapping pattern in replaceAll", async () => {
			stmts.upsertBlock.run({
				agent_id: AGENT_ID,
				key: "notes",
				updated_at: new Date().toISOString(),
				value: "aaa",
			});

			const tool = createReplaceMemoryBlockTool({ agentId: AGENT_ID, stmts });
			await tool.execute("tc1", { key: "notes", newText: "b", oldText: "aa" });

			const row = stmts.getBlockByKey.get(AGENT_ID, "notes") as MemoryBlock;
			// replaceAll("aa", "b") on "aaa" → "ba" (non-overlapping left-to-right)
			expect(row.value).toBe("ba");
		});

		it("replaces all occurrences", async () => {
			stmts.upsertBlock.run({
				agent_id: AGENT_ID,
				key: "notes",
				updated_at: new Date().toISOString(),
				value: "foo bar foo baz foo",
			});

			const tool = createReplaceMemoryBlockTool({ agentId: AGENT_ID, stmts });
			const result = await tool.execute("tc1", {
				key: "notes",
				newText: "qux",
				oldText: "foo",
			});

			const row = stmts.getBlockByKey.get(AGENT_ID, "notes") as MemoryBlock;
			expect(row.value).toBe("qux bar qux baz qux");
			expect(result.details.replacements).toBe(3);
		});
	});
});
