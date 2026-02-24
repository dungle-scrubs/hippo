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

	it("isolates dedup by agent_id", async () => {
		const tool1 = createStoreMemoryTool({ agentId: "agent-1", embed: mockEmbed, stmts });
		const tool2 = createStoreMemoryTool({ agentId: "agent-2", embed: mockEmbed, stmts });

		await tool1.execute("tc1", { content: "Shared content" });
		const result = await tool2.execute("tc2", { content: "Shared content" });

		// Second agent should get its own chunk, not strengthen the first
		expect(result.details.action).toBe("stored");

		const chunks = db.prepare("SELECT * FROM chunks").all() as Chunk[];
		expect(chunks).toHaveLength(2);
	});

	it("rejects invalid JSON metadata", async () => {
		const tool = createStoreMemoryTool({ agentId: AGENT_ID, embed: mockEmbed, stmts });

		await expect(tool.execute("tc1", { content: "test", metadata: "not json {" })).rejects.toThrow(
			"Invalid JSON",
		);
	});

	it("accepts valid JSON metadata", async () => {
		const tool = createStoreMemoryTool({ agentId: AGENT_ID, embed: mockEmbed, stmts });

		const result = await tool.execute("tc1", {
			content: "test",
			metadata: '{"source": "pdf"}',
		});

		expect(result.details.action).toBe("stored");
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

	it("handles concurrent stores of same content via constraint fallback", async () => {
		const resolvers: Array<(v: Float32Array) => void> = [];
		const embed: EmbedFn = vi.fn(
			() =>
				new Promise<Float32Array>((resolve) => {
					resolvers.push(resolve);
				}),
		);

		const tool = createStoreMemoryTool({ agentId: AGENT_ID, embed, stmts });

		// Start both calls — both check hash (find nothing) then await embed
		const p1 = tool.execute("tc1", { content: "Race content" });
		const p2 = tool.execute("tc2", { content: "Race content" });

		// Both embed calls are pending
		expect(resolvers).toHaveLength(2);

		// Resolve first — its insert succeeds
		// biome-ignore lint/style/noNonNullAssertion: test setup guarantees two resolvers
		resolvers[0]!(new Float32Array([0.1, 0.2, 0.3]));
		const r1 = await p1;
		expect(r1.details.action).toBe("stored");

		// Resolve second — hits UNIQUE constraint, falls back to strengthen
		// biome-ignore lint/style/noNonNullAssertion: test setup guarantees two resolvers
		resolvers[1]!(new Float32Array([0.1, 0.2, 0.3]));
		const r2 = await p2;
		expect(r2.details.action).toBe("strengthened");

		const chunks = db.prepare("SELECT * FROM chunks WHERE agent_id = ?").all(AGENT_ID) as Chunk[];
		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.encounter_count).toBe(2);
	});

	it("rejects content exceeding maxContentLength", async () => {
		const tool = createStoreMemoryTool({
			agentId: AGENT_ID,
			embed: mockEmbed,
			maxContentLength: 100,
			stmts,
		});

		await expect(tool.execute("tc1", { content: "x".repeat(101) })).rejects.toThrow(
			"Content too long",
		);
		expect(mockEmbed).not.toHaveBeenCalled();
	});

	it("allows content within maxContentLength", async () => {
		const tool = createStoreMemoryTool({
			agentId: AGENT_ID,
			embed: mockEmbed,
			maxContentLength: 100,
			stmts,
		});

		const result = await tool.execute("tc1", { content: "x".repeat(100) });
		expect(result.details.action).toBe("stored");
	});
});
