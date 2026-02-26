#!/usr/bin/env node
/**
 * Hippo MCP server — exposes memory tools over MCP protocol.
 *
 * Supports HTTP/SSE (multi-client) and STDIO (single-client) transports.
 * Embedding and LLM are configured via environment variables — consumers
 * send text, hippo handles vectorization and extraction.
 *
 * Every tool call includes an `agent_id` parameter for multi-agent
 * support on a shared database. Tool instances are created per-request
 * (pure factory — no DB calls, just closure binding) to inject the
 * caller's agent_id, then delegate to the library's battle-tested logic.
 */

import { createServer } from "node:http";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import Database from "better-sqlite3";
import { z } from "zod";
import { prepareStatements } from "../db.js";
import { createEmbeddingProvider } from "../providers/embedding.js";
import { createLlmProvider } from "../providers/llm.js";
import { initSchema, verifyEmbeddingModel } from "../schema.js";
import { createAppendMemoryBlockTool } from "../tools/append-memory-block.js";
import { createForgetMemoryTool } from "../tools/forget-memory.js";
import { createRecallMemoriesTool } from "../tools/recall-memories.js";
import { createRecallMemoryBlockTool } from "../tools/recall-memory-block.js";
import { createRememberFactsTool } from "../tools/remember-facts.js";
import { createReplaceMemoryBlockTool } from "../tools/replace-memory-block.js";
import { createStoreMemoryTool } from "../tools/store-memory.js";
import type { EmbedFn, LlmClient } from "../types.js";
import { resolveConfig } from "./config.js";

// ── Setup ────────────────────────────────────────────────────────────

const config = resolveConfig();
const db = new Database(config.db);
initSchema(db);
verifyEmbeddingModel(db, config.embedding.model);

const stmts = prepareStatements(db);
const embed: EmbedFn = createEmbeddingProvider(config.embedding);
const llm: LlmClient = createLlmProvider(config.llm);

const mcp = new McpServer({
	name: "hippo",
	version: "0.2.1", // x-release-please-version
});

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Map an AgentToolResult to an MCP CallToolResult.
 *
 * Passes through text content. If `details` contains an `error` field,
 * sets `isError: true` so MCP clients treat it as a tool error.
 * Hippo tools only produce TextContent, so ImageContent entries are
 * filtered out rather than throwing.
 *
 * @param result - AgentToolResult from a library tool
 * @returns MCP-compatible CallToolResult
 */
// biome-ignore lint/suspicious/noExplicitAny: AgentToolResult generic varies per tool
function toMcpResult(result: AgentToolResult<any>): {
	content: Array<{ text: string; type: "text" }>;
	isError?: boolean;
} {
	const hasError =
		result.details != null && typeof result.details === "object" && "error" in result.details;
	const textItems: Array<{ text: string; type: "text" }> = [];
	for (const item of result.content) {
		if (item.type === "text" && "text" in item) {
			textItems.push({ text: (item as { text: string }).text, type: "text" });
		}
	}
	return {
		content: textItems,
		...(hasError && { isError: true }),
	};
}

// ── Tool: remember_facts ─────────────────────────────────────────────

mcp.tool(
	"remember_facts",
	"Extract discrete facts from text, rate their intensity, check for conflicts with existing knowledge, and store. Handles duplicates, supersession, and new facts.",
	{
		agent_id: z.string().describe("Agent namespace for memory isolation"),
		text: z.string().max(10_000).describe("Text containing facts to extract and remember"),
	},
	async ({ agent_id, text }, extra) => {
		const tool = createRememberFactsTool({
			agentId: agent_id,
			db,
			embed,
			llm,
			stmts,
		});
		const result = await tool.execute("mcp", { text }, extra.signal);
		return toMcpResult(result);
	},
);

// ── Tool: store_memory ───────────────────────────────────────────────

mcp.tool(
	"store_memory",
	"Store a raw memory (document chunk, experience, decision). Deduplicates by content hash — identical content strengthens the existing memory.",
	{
		agent_id: z.string().describe("Agent namespace for memory isolation"),
		content: z.string().max(50_000).describe("Content to store as a memory"),
		metadata: z.string().optional().describe("Optional JSON metadata"),
	},
	async ({ agent_id, content, metadata }, extra) => {
		const tool = createStoreMemoryTool({
			agentId: agent_id,
			embed,
			stmts,
		});
		const result = await tool.execute("mcp", { content, metadata }, extra.signal);
		return toMcpResult(result);
	},
);

// ── Tool: recall_memories ────────────────────────────────────────────

mcp.tool(
	"recall_memories",
	"Semantic search over stored facts and memories. Returns results ranked by relevance, strength, and recency.",
	{
		agent_id: z.string().describe("Agent namespace for memory isolation"),
		kind: z.enum(["fact", "memory"]).optional().describe("Filter by chunk kind (default: all)"),
		limit: z.number().min(1).max(50).default(10).describe("Max results to return"),
		query: z.string().describe("What to search for in memory"),
	},
	async ({ agent_id, kind, limit, query }, extra) => {
		const tool = createRecallMemoriesTool({
			agentId: agent_id,
			embed,
			stmts,
		});
		const result = await tool.execute("mcp", { kind, limit, query }, extra.signal);
		return toMcpResult(result);
	},
);

// ── Tool: forget_memory ──────────────────────────────────────────────

mcp.tool(
	"forget_memory",
	"Forget specific memories or facts. Performs semantic match and hard deletes matching entries. No record of the forget request is stored.",
	{
		agent_id: z.string().describe("Agent namespace for memory isolation"),
		description: z.string().describe("Description of what to forget"),
		threshold: z.number().min(0).max(1).default(0.7).describe("Minimum similarity to delete"),
	},
	async ({ agent_id, description, threshold }, extra) => {
		const tool = createForgetMemoryTool({
			agentId: agent_id,
			db,
			embed,
			forgetThreshold: threshold,
			stmts,
		});
		const result = await tool.execute("mcp", { description }, extra.signal);
		return toMcpResult(result);
	},
);

// ── Tool: recall_memory_block ────────────────────────────────────────

mcp.tool(
	"recall_memory_block",
	"Retrieve the contents of a named memory block. Returns null if the block doesn't exist.",
	{
		agent_id: z.string().describe("Agent namespace"),
		key: z.string().describe("Block key (e.g. persona, objectives)"),
	},
	async ({ agent_id, key }) => {
		const tool = createRecallMemoryBlockTool({
			agentId: agent_id,
			stmts,
		});
		const result = await tool.execute("mcp", { key });
		return toMcpResult(result);
	},
);

// ── Tool: replace_memory_block ───────────────────────────────────────

mcp.tool(
	"replace_memory_block",
	"Find and replace text in a named memory block. Replaces all occurrences. Returns error if block doesn't exist or text not found.",
	{
		agent_id: z.string().describe("Agent namespace"),
		key: z.string().describe("Block key"),
		new_text: z.string().describe("Replacement text"),
		old_text: z.string().min(1).describe("Text to find"),
	},
	async ({ agent_id, key, new_text, old_text }) => {
		const tool = createReplaceMemoryBlockTool({
			agentId: agent_id,
			stmts,
		});
		const result = await tool.execute("mcp", { key, newText: new_text, oldText: old_text });
		return toMcpResult(result);
	},
);

// ── Tool: append_memory_block ────────────────────────────────────────

mcp.tool(
	"append_memory_block",
	"Append text to a named memory block. Creates the block if it doesn't exist (upsert).",
	{
		agent_id: z.string().describe("Agent namespace"),
		content: z.string().describe("Text to append"),
		key: z.string().describe("Block key"),
	},
	async ({ agent_id, content, key }) => {
		const tool = createAppendMemoryBlockTool({
			agentId: agent_id,
			stmts,
		});
		const result = await tool.execute("mcp", { content, key });
		return toMcpResult(result);
	},
);

// ── Transport ────────────────────────────────────────────────────────

if (config.transport === "stdio") {
	const transport = new StdioServerTransport();
	await mcp.connect(transport);
	console.error("Hippo MCP server running on stdio");
} else {
	const transports = new Map<string, SSEServerTransport>();

	const httpServer = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

		// Health check
		if (url.pathname === "/health") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ status: "ok" }));
			return;
		}

		// SSE endpoint — new connections
		if (url.pathname === "/sse" && req.method === "GET") {
			const transport = new SSEServerTransport("/messages", res);
			transports.set(transport.sessionId, transport);
			transport.onclose = () => {
				transports.delete(transport.sessionId);
			};
			await mcp.connect(transport);
			return;
		}

		// Message endpoint — client POSTs to this
		if (url.pathname === "/messages" && req.method === "POST") {
			const sessionId = url.searchParams.get("sessionId");
			if (!sessionId || !transports.has(sessionId)) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Invalid or missing sessionId" }));
				return;
			}
			// biome-ignore lint/style/noNonNullAssertion: checked in the guard above
			const transport = transports.get(sessionId)!;
			await transport.handlePostMessage(req, res);
			return;
		}

		res.writeHead(404);
		res.end("Not found");
	});

	httpServer.listen(config.port, () => {
		console.error(`Hippo MCP server listening on http://localhost:${config.port}`);
		console.error(`  SSE endpoint: GET  /sse`);
		console.error(`  Messages:     POST /messages?sessionId=<id>`);
		console.error(`  Health:       GET  /health`);
	});
}
