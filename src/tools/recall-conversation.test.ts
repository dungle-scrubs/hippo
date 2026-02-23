import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRecallConversationTool } from "./recall-conversation.js";

/** Extract text from the first content item. */
function firstText(result: AgentToolResult<unknown>): string {
	const item = result.content[0];
	return item?.type === "text" ? item.text : "";
}

describe("recall_conversation", () => {
	let db: Database.Database;

	beforeEach(() => {
		db = new Database(":memory:");

		// Create messages table (normally owned by marrow)
		db.exec(`
			CREATE TABLE messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				role TEXT NOT NULL,
				content TEXT NOT NULL,
				created_at TEXT NOT NULL
			);

			CREATE VIRTUAL TABLE messages_fts USING fts5(
				content,
				content=messages,
				content_rowid=id
			);

			CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
				INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
			END;

			CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
				INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
			END;
		`);

		// Seed some messages
		const insert = db.prepare("INSERT INTO messages (role, content, created_at) VALUES (?, ?, ?)");
		insert.run("user", "I want to build a memory system for the agent", "2025-02-20T10:00:00Z");
		insert.run(
			"assistant",
			"We could use SQLite with embeddings for semantic search",
			"2025-02-20T10:01:00Z",
		);
		insert.run("user", "What about conflict resolution for facts?", "2025-02-20T10:02:00Z");
		insert.run(
			"assistant",
			"We can use cosine similarity thresholds with LLM tiebreaker",
			"2025-02-20T10:03:00Z",
		);
		insert.run("user", "Let's also add a forget mechanism", "2025-02-20T10:04:00Z");
	});

	afterEach(() => {
		db.close();
	});

	it("finds messages matching a search query", async () => {
		const tool = createRecallConversationTool({ db, messagesTable: "messages" });

		const result = await tool.execute("tc1", { query: "memory system" });

		expect(result.details.matches).toBeGreaterThan(0);
		expect(firstText(result)).toContain("memory system");
	});

	it("returns no matches for unrelated query", async () => {
		const tool = createRecallConversationTool({ db, messagesTable: "messages" });

		const result = await tool.execute("tc1", { query: "kubernetes deployment" });

		expect(result.details.matches).toBe(0);
	});

	it("respects limit parameter", async () => {
		const tool = createRecallConversationTool({ db, messagesTable: "messages" });

		const result = await tool.execute("tc1", { limit: 1, query: "the" });

		expect(result.details.matches).toBeLessThanOrEqual(1);
	});

	it("handles missing FTS table gracefully", async () => {
		const bareDb = new Database(":memory:");
		const tool = createRecallConversationTool({
			db: bareDb,
			messagesTable: "messages",
		});

		const result = await tool.execute("tc1", { query: "anything" });

		expect(result.details.error).toBe("fts_unavailable");
		bareDb.close();
	});

	it("includes role and timestamp in results", async () => {
		const tool = createRecallConversationTool({ db, messagesTable: "messages" });

		const result = await tool.execute("tc1", { query: "SQLite" });

		expect(firstText(result)).toContain("[assistant]");
		expect(firstText(result)).toContain("2025-02-20");
	});

	it("rejects unsafe table names", () => {
		expect(() =>
			createRecallConversationTool({ db, messagesTable: "messages; DROP TABLE users" }),
		).toThrow("Unsafe SQL identifier");
	});

	it("accepts valid table names", () => {
		expect(() =>
			createRecallConversationTool({ db, messagesTable: "chat_messages_v2" }),
		).not.toThrow();
	});
});
