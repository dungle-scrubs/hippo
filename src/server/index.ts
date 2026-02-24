#!/usr/bin/env node
/**
 * Hippo MCP server — exposes memory tools over MCP protocol.
 *
 * Supports HTTP/SSE (multi-client) and STDIO (single-client) transports.
 * Embedding and LLM are configured via environment variables — consumers
 * send text, hippo handles vectorization and extraction.
 *
 * Every tool call includes an `agent_id` parameter for multi-agent
 * support on a shared database.
 */

import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import Database from "better-sqlite3";
import { z } from "zod";
import { prepareStatements } from "../db.js";
import { classifyConflict, extractFacts } from "../extractor.js";
import { contentHash } from "../hash.js";
import { createEmbeddingProvider } from "../providers/embedding.js";
import { createLlmProvider } from "../providers/llm.js";
import { initSchema, verifyEmbeddingModel } from "../schema.js";
import { chunkEmbedding, cosineSimilarity, embeddingToBuffer } from "../similarity.js";
import {
	effectiveStrength,
	recencyScore,
	retrievalBoost,
	STRENGTH_FLOOR,
	searchScore,
} from "../strength.js";
import type { Chunk, EmbedFn, LlmClient } from "../types.js";
import { ulid } from "../ulid.js";
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
	version: "0.1.0", // x-release-please-version
});

// ── Tool: remember_facts ─────────────────────────────────────────────

mcp.tool(
	"remember_facts",
	"Extract and store facts from text. Handles conflict resolution: duplicates strengthen, superseding facts replace old ones.",
	{
		agent_id: z.string().describe("Agent namespace for memory isolation"),
		text: z.string().max(10_000).describe("Text containing facts to extract and remember"),
	},
	async ({ agent_id, text }) => {
		const facts = await extractFacts(text, llm);
		if (facts.length === 0) {
			return { content: [{ type: "text", text: "No facts extracted." }] };
		}

		const results: string[] = [];

		for (const { fact, intensity } of facts) {
			const embedding = await embed(fact);
			const embeddingBuf = embeddingToBuffer(embedding);
			const now = new Date().toISOString();

			// Find similar existing facts
			const existing = stmts.getActiveChunksByAgent.all(agent_id, "fact", 200) as Chunk[];

			let bestSim = 0;
			let bestChunk: Chunk | null = null;
			for (const chunk of existing) {
				const sim = cosineSimilarity(embedding, chunkEmbedding(chunk));
				if (sim > bestSim) {
					bestSim = sim;
					bestChunk = chunk;
				}
			}

			if (bestSim > 0.93 && bestChunk) {
				// Auto-DUPLICATE
				const newIntensity =
					(bestChunk.running_intensity * bestChunk.encounter_count + intensity) /
					(bestChunk.encounter_count + 1);
				stmts.reinforceChunk.run({
					id: bestChunk.id,
					last_accessed_at: now,
					running_intensity: newIntensity,
				});
				results.push(`reinforced: "${fact}"`);
			} else if (bestSim >= 0.78 && bestChunk) {
				// LLM tiebreaker
				const classification = await classifyConflict(fact, bestChunk.content, llm);

				if (classification === "DUPLICATE") {
					const newIntensity =
						(bestChunk.running_intensity * bestChunk.encounter_count + intensity) /
						(bestChunk.encounter_count + 1);
					stmts.reinforceChunk.run({
						id: bestChunk.id,
						last_accessed_at: now,
						running_intensity: newIntensity,
					});
					results.push(`reinforced: "${fact}"`);
				} else if (classification === "SUPERSEDES") {
					const newId = ulid();
					db.transaction(() => {
						stmts.insertChunk.run({
							access_count: 0,
							agent_id,
							content: fact,
							content_hash: null,
							created_at: now,
							embedding: embeddingBuf,
							encounter_count: 1,
							id: newId,
							kind: "fact",
							last_accessed_at: now,
							metadata: null,
							running_intensity: intensity,
							superseded_by: null,
						});
						stmts.supersedeChunk.run(newId, bestChunk.id);
					})();
					results.push(`superseded: "${fact}" (replaced "${bestChunk.content}")`);
				} else {
					// DISTINCT
					stmts.insertChunk.run({
						access_count: 0,
						agent_id,
						content: fact,
						content_hash: null,
						created_at: now,
						embedding: embeddingBuf,
						encounter_count: 1,
						id: ulid(),
						kind: "fact",
						last_accessed_at: now,
						metadata: null,
						running_intensity: intensity,
						superseded_by: null,
					});
					results.push(`new: "${fact}"`);
				}
			} else {
				// NEW
				stmts.insertChunk.run({
					access_count: 0,
					agent_id,
					content: fact,
					content_hash: null,
					created_at: now,
					embedding: embeddingBuf,
					encounter_count: 1,
					id: ulid(),
					kind: "fact",
					last_accessed_at: now,
					metadata: null,
					running_intensity: intensity,
					superseded_by: null,
				});
				results.push(`new: "${fact}"`);
			}
		}

		return { content: [{ type: "text", text: results.join("\n") }] };
	},
);

// ── Tool: store_memory ───────────────────────────────────────────────

mcp.tool(
	"store_memory",
	"Store raw content as a memory chunk. Deduplicates by content hash — storing the same text twice strengthens the existing memory instead of creating a duplicate.",
	{
		agent_id: z.string().describe("Agent namespace for memory isolation"),
		content: z.string().max(50_000).describe("Content to store as a memory"),
		metadata: z.string().optional().describe("Optional JSON metadata"),
	},
	async ({ agent_id, content, metadata }) => {
		const hash = contentHash(content);
		const now = new Date().toISOString();

		// Check for duplicate
		const existing = stmts.getMemoryByHash.get(agent_id, hash) as Chunk | undefined;
		if (existing) {
			const boosted = retrievalBoost(existing.running_intensity);
			stmts.reinforceChunk.run({
				id: existing.id,
				last_accessed_at: now,
				running_intensity: boosted,
			});
			return {
				content: [{ type: "text", text: `Memory already exists (strengthened): ${existing.id}` }],
			};
		}

		const embedding = await embed(content);
		const id = ulid();
		stmts.insertChunk.run({
			access_count: 0,
			agent_id,
			content,
			content_hash: hash,
			created_at: now,
			embedding: embeddingToBuffer(embedding),
			encounter_count: 1,
			id,
			kind: "memory",
			last_accessed_at: now,
			metadata: metadata ?? null,
			running_intensity: 0.5,
			superseded_by: null,
		});

		return { content: [{ type: "text", text: `Stored memory: ${id}` }] };
	},
);

// ── Tool: recall_memories ────────────────────────────────────────────

mcp.tool(
	"recall_memories",
	"Semantic search over stored facts and memories. Returns results ranked by relevance, strength, and recency.",
	{
		agent_id: z.string().describe("Agent namespace for memory isolation"),
		limit: z.number().min(1).max(50).default(10).describe("Max results to return"),
		query: z.string().describe("What to search for in memory"),
	},
	async ({ agent_id, limit, query }) => {
		const queryEmbedding = await embed(query);
		const now = new Date();

		const allChunks = stmts.getAllActiveChunksByAgent.all(agent_id, 10_000) as Chunk[];

		const scored: Array<{ chunk: Chunk; score: number }> = [];
		for (const chunk of allChunks) {
			const similarity = cosineSimilarity(queryEmbedding, chunkEmbedding(chunk));
			if (similarity < 0.1) continue;

			const hoursSince =
				(now.getTime() - new Date(chunk.last_accessed_at).getTime()) / (1000 * 60 * 60);
			const strength = effectiveStrength(chunk.running_intensity, chunk.access_count, hoursSince);
			if (strength < STRENGTH_FLOOR) continue;

			const daysSince =
				(now.getTime() - new Date(chunk.created_at).getTime()) / (1000 * 60 * 60 * 24);
			const recency = recencyScore(daysSince);
			scored.push({ chunk, score: searchScore(similarity, strength, recency) });
		}

		scored.sort((a, b) => b.score - a.score);
		const top = scored.slice(0, limit);

		// Retrieval boost
		for (const { chunk } of top) {
			try {
				stmts.touchChunk.run({
					id: chunk.id,
					last_accessed_at: now.toISOString(),
					running_intensity: retrievalBoost(chunk.running_intensity),
				});
			} catch {
				// Non-fatal
			}
		}

		if (top.length === 0) {
			return { content: [{ type: "text", text: "No memories found." }] };
		}

		const lines = top.map(
			(r, i) => `${i + 1}. [${r.chunk.kind}] (score: ${r.score.toFixed(3)}) ${r.chunk.content}`,
		);
		return { content: [{ type: "text", text: lines.join("\n") }] };
	},
);

// ── Tool: forget_memory ──────────────────────────────────────────────

mcp.tool(
	"forget_memory",
	"Forget memories matching a description. Embeds the description, finds semantically similar chunks, and hard-deletes them.",
	{
		agent_id: z.string().describe("Agent namespace for memory isolation"),
		description: z.string().describe("Description of what to forget"),
		threshold: z.number().min(0).max(1).default(0.7).describe("Minimum similarity to delete"),
	},
	async ({ agent_id, description, threshold }) => {
		const queryEmbedding = await embed(description);
		const allChunks = stmts.getAllActiveChunksByAgent.all(agent_id, 10_000) as Chunk[];

		const toDelete: Chunk[] = [];
		for (const chunk of allChunks) {
			const sim = cosineSimilarity(queryEmbedding, chunkEmbedding(chunk));
			if (sim >= threshold) {
				toDelete.push(chunk);
			}
		}

		if (toDelete.length === 0) {
			return { content: [{ type: "text", text: "No matching memories found to forget." }] };
		}

		db.transaction(() => {
			for (const chunk of toDelete) {
				stmts.clearSupersededBy.run(chunk.id, agent_id);
				stmts.deleteChunk.run(chunk.id);
			}
		})();

		const lines = toDelete.map((c) => `- [${c.kind}] ${c.content}`);
		return {
			content: [
				{ type: "text", text: `Forgot ${toDelete.length} memory(s):\n${lines.join("\n")}` },
			],
		};
	},
);

// ── Tool: recall_memory_block ────────────────────────────────────────

mcp.tool(
	"recall_memory_block",
	"Read the contents of a named memory block (key-value text buffer like persona, objectives, etc.).",
	{
		agent_id: z.string().describe("Agent namespace"),
		key: z.string().describe("Block key (e.g. persona, objectives)"),
	},
	async ({ agent_id, key }) => {
		const row = stmts.getBlockByKey.get(agent_id, key) as { value: string } | undefined;
		if (!row) {
			return { content: [{ type: "text", text: `Block "${key}" not found.` }] };
		}
		return { content: [{ type: "text", text: row.value }] };
	},
);

// ── Tool: replace_memory_block ───────────────────────────────────────

mcp.tool(
	"replace_memory_block",
	"Find and replace text within a named memory block. Returns error if block doesn't exist or text not found.",
	{
		agent_id: z.string().describe("Agent namespace"),
		key: z.string().describe("Block key"),
		new_text: z.string().describe("Replacement text"),
		old_text: z.string().min(1).describe("Text to find"),
	},
	async ({ agent_id, key, new_text, old_text }) => {
		const row = stmts.getBlockByKey.get(agent_id, key) as { value: string } | undefined;
		if (!row) {
			return {
				content: [{ type: "text", text: `Block "${key}" not found.` }],
				isError: true,
			};
		}
		if (!row.value.includes(old_text)) {
			return {
				content: [{ type: "text", text: `Text not found in block "${key}".` }],
				isError: true,
			};
		}
		const updated = row.value.replace(old_text, new_text);
		stmts.upsertBlock.run({ agent_id, key, updated_at: new Date().toISOString(), value: updated });
		return { content: [{ type: "text", text: `Updated block "${key}".` }] };
	},
);

// ── Tool: append_memory_block ────────────────────────────────────────

mcp.tool(
	"append_memory_block",
	"Append text to a named memory block. Creates the block if it doesn't exist.",
	{
		agent_id: z.string().describe("Agent namespace"),
		content: z.string().describe("Text to append"),
		key: z.string().describe("Block key"),
	},
	async ({ agent_id, content, key }) => {
		const row = stmts.getBlockByKey.get(agent_id, key) as { value: string } | undefined;
		const newValue = row ? row.value + content : content;
		stmts.upsertBlock.run({
			agent_id,
			key,
			updated_at: new Date().toISOString(),
			value: newValue,
		});
		const sizeBytes = new TextEncoder().encode(newValue).byteLength;
		let msg = `Appended to block "${key}" (${sizeBytes} bytes).`;
		if (sizeBytes > 100_000) {
			msg += " Warning: block exceeds 100KB.";
		}
		return { content: [{ type: "text", text: msg }] };
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
