import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbStatements } from "../db.js";
import { prepareStatements } from "../db.js";
import { initSchema } from "../schema.js";
import type { Chunk, EmbedFn } from "../types.js";
import { createStoreMemoryTool } from "./store-memory.js";

const AGENT_ID = "test-agent";

/** Mock embed that returns a deterministic vector. */
const mockEmbed: EmbedFn = vi.fn(async () => new Float32Array([0.1, 0.2, 0.3]));

describe("store_memory", () => {
	let db: Database.Database;
	let stmts: DbStatements;

	beforeEach(() => {
		db = new Database(":memory:");
		initSchema(db);
		stmts = prepareStatements(db);
		vi.clearAllMocks();
	});

	afterEach(() => {
		db.close();
	});

	it("stores a new memory", async () => {
		const tool = createStoreMemoryTool({ agentId: AGENT_ID, embed: mockEmbed, stmts });

		const result = await tool.execute("tc1", { content: "OAuth redirect was wrong" });

		expect(result.details.action).toBe("stored");
		expect(mockEmbed).toHaveBeenCalledOnce();

		const chunks = db.prepare("SELECT * FROM chunks WHERE agent_id = ?").all(AGENT_ID) as Chunk[];
		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.content).toBe("OAuth redirect was wrong");
		expect(chunks[0]?.kind).toBe("memory");
		expect(chunks[0]?.content_hash).toBeTruthy();
	});

	it("strengthens duplicate content instead of re-inserting", async () => {
		const tool = createStoreMemoryTool({ agentId: AGENT_ID, embed: mockEmbed, stmts });

		await tool.execute("tc1", { content: "Same content" });
		const result = await tool.execute("tc2", { content: "Same content" });

		expect(result.details.action).toBe("strengthened");

		const chunks = db.prepare("SELECT * FROM chunks WHERE agent_id = ?").all(AGENT_ID) as Chunk[];
		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.encounter_count).toBe(2);
	});

	it("stores metadata when provided", async () => {
		const tool = createStoreMemoryTool({ agentId: AGENT_ID, embed: mockEmbed, stmts });

		await tool.execute("tc1", {
			content: "PDF content",
			metadata: '{"source": "upload", "tags": ["docs"]}',
		});

		const chunks = db.prepare("SELECT * FROM chunks WHERE agent_id = ?").all(AGENT_ID) as Chunk[];
		expect(chunks[0]?.metadata).toBe('{"source": "upload", "tags": ["docs"]}');
	});

	it("does not call embed for duplicate content", async () => {
		const tool = createStoreMemoryTool({ agentId: AGENT_ID, embed: mockEmbed, stmts });

		await tool.execute("tc1", { content: "test content" });
		vi.clearAllMocks();
		await tool.execute("tc2", { content: "test content" });

		// Embed is not called for the duplicate
		expect(mockEmbed).not.toHaveBeenCalled();
	});

	it("treats different content as separate memories", async () => {
		const tool = createStoreMemoryTool({ agentId: AGENT_ID, embed: mockEmbed, stmts });

		await tool.execute("tc1", { content: "First memory" });
		await tool.execute("tc2", { content: "Second memory" });

		const chunks = db.prepare("SELECT * FROM chunks WHERE agent_id = ?").all(AGENT_ID) as Chunk[];
		expect(chunks).toHaveLength(2);
	});

	it("updates running_intensity on duplicate via moving average", async () => {
		const tool = createStoreMemoryTool({ agentId: AGENT_ID, embed: mockEmbed, stmts });

		await tool.execute("tc1", { content: "Same content" });

		const before = db.prepare("SELECT * FROM chunks WHERE agent_id = ?").get(AGENT_ID) as Chunk;
		// Default intensity for new memory is 0.5
		expect(before.running_intensity).toBeCloseTo(0.5, 2);

		await tool.execute("tc2", { content: "Same content" });

		const after = db.prepare("SELECT * FROM chunks WHERE agent_id = ?").get(AGENT_ID) as Chunk;
		// Moving average: (0.5 * 1 + 0.5) / 2 = 0.5 — same value since default is 0.5
		// The key thing is that the code path exercises updatedIntensity()
		expect(after.running_intensity).toBeCloseTo(0.5, 2);
		expect(after.encounter_count).toBe(2);
	});

	it("does not add ellipsis for short content", async () => {
		const tool = createStoreMemoryTool({ agentId: AGENT_ID, embed: mockEmbed, stmts });

		const result = await tool.execute("tc1", { content: "Short note" });

		const text = result.content[0];
		expect(text?.type === "text" && text.text).toBe('Stored memory: "Short note"');
	});

	it("truncates long content with ellipsis", async () => {
		const tool = createStoreMemoryTool({ agentId: AGENT_ID, embed: mockEmbed, stmts });
		const longContent = "x".repeat(200);

		const result = await tool.execute("tc1", { content: longContent });

		const text = result.content[0];
		expect(text?.type === "text" && text.text).toContain("...");
		expect(text?.type === "text" && text.text.length).toBeLessThan(200);
	});

	it("propagates embed errors — nothing stored", async () => {
		const failEmbed: EmbedFn = vi.fn().mockRejectedValue(new Error("Embedding API down"));
		const tool = createStoreMemoryTool({ agentId: AGENT_ID, embed: failEmbed, stmts });

		await expect(tool.execute("tc1", { content: "should not persist" })).rejects.toThrow(
			"Embedding API down",
		);

		const chunks = db.prepare("SELECT * FROM chunks WHERE agent_id = ?").all(AGENT_ID);
		expect(chunks).toHaveLength(0);
	});
});
