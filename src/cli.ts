#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import Database from "better-sqlite3";
import { Command } from "commander";
import { initSchema } from "./schema.js";

// ── Row types for CLI queries ────────────────────────────────────────

interface CountRow {
	readonly count: number;
}

interface AgentIdRow {
	readonly agent_id: string;
}

interface ChunkRow {
	readonly access_count: number;
	readonly agent_id: string;
	readonly content: string;
	readonly content_hash: string | null;
	readonly created_at: string;
	readonly encounter_count: number;
	readonly id: string;
	readonly kind: string;
	readonly last_accessed_at: string;
	readonly metadata: string | null;
	readonly running_intensity: number;
	readonly superseded_by: string | null;
}

interface BlockRow {
	readonly agent_id: string;
	readonly key: string;
	readonly updated_at: string;
	readonly value: string;
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Resolve the database path from --db flag or HIPPO_DB env var.
 *
 * @param prog - Commander program instance
 * @returns Database file path
 */
function resolveDbPath(prog: Command): string {
	const opts = prog.opts<{ db?: string }>();
	const dbPath = opts.db ?? process.env.HIPPO_DB;
	if (!dbPath) {
		console.error("Error: --db <path> is required (or set HIPPO_DB env var)");
		process.exit(1);
	}
	return dbPath;
}

/**
 * Open a database with WAL mode and busy timeout.
 *
 * @param dbPath - Path to SQLite file
 * @returns Database handle
 */
function openDb(dbPath: string): Database.Database {
	const db = new Database(dbPath);
	db.pragma("journal_mode=WAL");
	db.pragma("busy_timeout=5000");
	return db;
}

/**
 * Output data as JSON or formatted text.
 *
 * @param data - Data to output
 * @param json - Whether to use JSON format
 * @param textFn - Function to produce human-readable output
 */
function output<T>(data: T, json: boolean, textFn: (data: T) => string): void {
	if (json) {
		console.log(JSON.stringify(data, null, 2));
	} else {
		console.log(textFn(data));
	}
}

/**
 * Truncate a string with ellipsis if it exceeds maxLen.
 *
 * @param s - Input string
 * @param maxLen - Maximum length before truncation
 * @returns Truncated string
 */
function truncate(s: string, maxLen: number): string {
	if (s.length <= maxLen) return s;
	return `${s.slice(0, maxLen - 1)}…`;
}

// ── Program ──────────────────────────────────────────────────────────

const program = new Command()
	.name("hippo")
	.description(
		[
			"Inspect and manage hippo memory databases.",
			"",
			"Hippo stores facts, memories, and key-value blocks for AI agents",
			"in SQLite. Each agent has its own namespace. Facts go through",
			"conflict resolution (duplicates merge, superseding facts replace).",
			"Memories are raw content with content-hash dedup. Blocks are named",
			"text buffers (persona, objectives, etc.).",
			"",
			"This CLI inspects and manages the database without embedding or",
			"LLM access. For semantic operations, use the hippo library API.",
			"",
			"Database path: pass --db <path> or set HIPPO_DB env var.",
		].join("\n"),
	)
	.version("0.1.0") // x-release-please-version
	.option("--db <path>", "SQLite database path (env: HIPPO_DB)");

// ── init ─────────────────────────────────────────────────────────────

program
	.command("init")
	.description(
		[
			"Initialize the hippo schema. Creates chunks and memory_blocks",
			"tables with indexes. Safe to run multiple times (idempotent).",
			"Creates the database file if it doesn't exist.",
		].join(" "),
	)
	.action(() => {
		const dbPath = resolveDbPath(program);
		const db = new Database(dbPath);
		initSchema(db);
		db.close();
		console.log(`Initialized: ${dbPath}`);
	});

// ── stats ────────────────────────────────────────────────────────────

program
	.command("stats")
	.description(
		[
			"Database statistics: chunk counts by kind and status, block",
			"count, number of agents, and file size on disk.",
		].join(" "),
	)
	.option("--json", "Output as JSON")
	.action((opts: { json?: boolean }) => {
		const dbPath = resolveDbPath(program);
		if (!existsSync(dbPath)) {
			console.error(`Error: database not found: ${dbPath}`);
			process.exit(1);
		}
		const db = openDb(dbPath);

		const agents = db
			.prepare(
				"SELECT DISTINCT agent_id FROM chunks UNION SELECT DISTINCT agent_id FROM memory_blocks",
			)
			.all() as AgentIdRow[];
		const total = (db.prepare("SELECT COUNT(*) as count FROM chunks").get() as CountRow).count;
		const facts = (
			db.prepare("SELECT COUNT(*) as count FROM chunks WHERE kind = 'fact'").get() as CountRow
		).count;
		const memories = (
			db.prepare("SELECT COUNT(*) as count FROM chunks WHERE kind = 'memory'").get() as CountRow
		).count;
		const superseded = (
			db
				.prepare("SELECT COUNT(*) as count FROM chunks WHERE superseded_by IS NOT NULL")
				.get() as CountRow
		).count;
		const active = total - superseded;
		const blocks = (db.prepare("SELECT COUNT(*) as count FROM memory_blocks").get() as CountRow)
			.count;
		const fileSizeBytes = statSync(dbPath).size;

		db.close();

		const data = {
			agents: agents.length,
			blocks,
			chunks: { active, facts, memories, superseded, total },
			fileSizeBytes,
		};

		output(data, opts.json ?? false, (d) =>
			[
				`Database: ${dbPath}`,
				`Agents:   ${d.agents}`,
				`Chunks:   ${d.chunks.active} active (${d.chunks.facts} facts, ${d.chunks.memories} memories), ${d.chunks.superseded} superseded`,
				`Blocks:   ${d.blocks}`,
				`Size:     ${(d.fileSizeBytes / 1024).toFixed(1)} KB`,
			].join("\n"),
		);
	});

// ── agents ───────────────────────────────────────────────────────────

program
	.command("agents")
	.description("List all agent IDs that have stored data in the database.")
	.option("--json", "Output as JSON")
	.action((opts: { json?: boolean }) => {
		const dbPath = resolveDbPath(program);
		const db = openDb(dbPath);

		const rows = db
			.prepare(
				`SELECT agent_id, COUNT(*) as chunk_count FROM chunks
				 GROUP BY agent_id
				 UNION ALL
				 SELECT agent_id, 0 FROM memory_blocks
				 WHERE agent_id NOT IN (SELECT DISTINCT agent_id FROM chunks)
				 GROUP BY agent_id`,
			)
			.all() as Array<{ agent_id: string; chunk_count: number }>;

		// Aggregate: an agent may appear in both queries
		const agents = new Map<string, number>();
		for (const row of rows) {
			agents.set(row.agent_id, (agents.get(row.agent_id) ?? 0) + row.chunk_count);
		}

		db.close();

		const list = [...agents.entries()]
			.map(([id, chunks]) => ({ agentId: id, chunks }))
			.sort((a, b) => a.agentId.localeCompare(b.agentId));

		output(list, opts.json ?? false, (d) => {
			if (d.length === 0) return "No agents found.";
			return d.map((a) => `${a.agentId} (${a.chunks} chunks)`).join("\n");
		});
	});

// ── chunks ───────────────────────────────────────────────────────────

program
	.command("chunks")
	.argument("<agent>", "Agent ID to list chunks for")
	.description(
		[
			"List chunks (facts and memories) for an agent. Shows content,",
			"kind, intensity, access count, and timestamps. Excludes superseded",
			"chunks by default.",
		].join(" "),
	)
	.option("--kind <type>", "Filter by kind: fact or memory")
	.option("--superseded", "Include superseded chunks")
	.option("--limit <n>", "Max results (default: 50)", "50")
	.option("--json", "Output as JSON")
	.action(
		(
			agent: string,
			opts: { json?: boolean; kind?: string; limit: string; superseded?: boolean },
		) => {
			const dbPath = resolveDbPath(program);
			const db = openDb(dbPath);

			let sql = "SELECT * FROM chunks WHERE agent_id = ?";
			const params: unknown[] = [agent];

			if (!opts.superseded) {
				sql += " AND superseded_by IS NULL";
			}
			if (opts.kind) {
				sql += " AND kind = ?";
				params.push(opts.kind);
			}
			sql += " ORDER BY last_accessed_at DESC LIMIT ?";
			params.push(Number.parseInt(opts.limit, 10));

			const rows = db.prepare(sql).all(...params) as ChunkRow[];
			db.close();

			// Strip embedding BLOBs from JSON output — they're opaque binary
			const clean = rows.map((r) => ({
				access_count: r.access_count,
				content: r.content,
				content_hash: r.content_hash,
				created_at: r.created_at,
				encounter_count: r.encounter_count,
				id: r.id,
				kind: r.kind,
				last_accessed_at: r.last_accessed_at,
				metadata: r.metadata,
				running_intensity: r.running_intensity,
				superseded_by: r.superseded_by,
			}));

			output(clean, opts.json ?? false, (d) => {
				if (d.length === 0) return "No chunks found.";
				return d
					.map((c, i) => {
						const sup = c.superseded_by ? ` [superseded by ${c.superseded_by}]` : "";
						return [
							`${i + 1}. [${c.kind}] ${truncate(c.content, 80)}${sup}`,
							`   id: ${c.id}  intensity: ${c.running_intensity.toFixed(2)}  encounters: ${c.encounter_count}  accesses: ${c.access_count}`,
							`   created: ${c.created_at}  last accessed: ${c.last_accessed_at}`,
						].join("\n");
					})
					.join("\n\n");
			});
		},
	);

// ── blocks ───────────────────────────────────────────────────────────

program
	.command("blocks")
	.argument("<agent>", "Agent ID to list blocks for")
	.description("List all memory blocks (key-value text buffers) for an agent.")
	.option("--json", "Output as JSON")
	.action((agent: string, opts: { json?: boolean }) => {
		const dbPath = resolveDbPath(program);
		const db = openDb(dbPath);

		const rows = db
			.prepare("SELECT * FROM memory_blocks WHERE agent_id = ? ORDER BY key")
			.all(agent) as BlockRow[];
		db.close();

		const data = rows.map((r) => ({
			key: r.key,
			sizeBytes: new TextEncoder().encode(r.value).byteLength,
			updatedAt: r.updated_at,
		}));

		output(data, opts.json ?? false, (d) => {
			if (d.length === 0) return "No blocks found.";
			return d
				.map((b) => `${b.key} (${(b.sizeBytes / 1024).toFixed(1)} KB, updated ${b.updatedAt})`)
				.join("\n");
		});
	});

// ── block ────────────────────────────────────────────────────────────

program
	.command("block")
	.argument("<agent>", "Agent ID")
	.argument("<key>", "Block key (e.g. persona, objectives)")
	.description(
		[
			"Get the contents of a named memory block. Returns the full text",
			"value, or an error if the block doesn't exist.",
		].join(" "),
	)
	.option("--json", "Output as JSON")
	.action((agent: string, key: string, opts: { json?: boolean }) => {
		const dbPath = resolveDbPath(program);
		const db = openDb(dbPath);

		const row = db
			.prepare("SELECT * FROM memory_blocks WHERE agent_id = ? AND key = ?")
			.get(agent, key) as BlockRow | undefined;
		db.close();

		if (!row) {
			if (opts.json) {
				console.log(JSON.stringify({ error: "block_not_found", key }, null, 2));
			} else {
				console.error(`Block "${key}" not found for agent "${agent}".`);
			}
			process.exit(1);
		}

		output(
			{ key: row.key, updatedAt: row.updated_at, value: row.value },
			opts.json ?? false,
			(d) => d.value,
		);
	});

// ── search ───────────────────────────────────────────────────────────

program
	.command("search")
	.argument("<text>", "Text to search for (case-insensitive substring match)")
	.description(
		[
			"Search chunk content by text (case-insensitive LIKE match).",
			"Searches across all agents unless --agent is specified.",
			"This is a simple text search, not semantic — use the library",
			"API for embedding-based recall.",
		].join(" "),
	)
	.option("--agent <id>", "Filter to a specific agent")
	.option("--kind <type>", "Filter by kind: fact or memory")
	.option("--limit <n>", "Max results (default: 20)", "20")
	.option("--json", "Output as JSON")
	.action(
		(text: string, opts: { agent?: string; json?: boolean; kind?: string; limit: string }) => {
			const dbPath = resolveDbPath(program);
			const db = openDb(dbPath);

			let sql = "SELECT * FROM chunks WHERE content LIKE ? AND superseded_by IS NULL";
			const params: unknown[] = [`%${text}%`];

			if (opts.agent) {
				sql += " AND agent_id = ?";
				params.push(opts.agent);
			}
			if (opts.kind) {
				sql += " AND kind = ?";
				params.push(opts.kind);
			}
			sql += " ORDER BY last_accessed_at DESC LIMIT ?";
			params.push(Number.parseInt(opts.limit, 10));

			const rows = db.prepare(sql).all(...params) as ChunkRow[];
			db.close();

			const clean = rows.map((r) => ({
				agent_id: r.agent_id,
				content: r.content,
				created_at: r.created_at,
				id: r.id,
				kind: r.kind,
				running_intensity: r.running_intensity,
			}));

			output(clean, opts.json ?? false, (d) => {
				if (d.length === 0) return "No matches.";
				return d
					.map(
						(c, i) =>
							`${i + 1}. [${c.agent_id}/${c.kind}] ${truncate(c.content, 80)}\n   id: ${c.id}  intensity: ${c.running_intensity.toFixed(2)}  created: ${c.created_at}`,
					)
					.join("\n\n");
			});
		},
	);

// ── delete ───────────────────────────────────────────────────────────

program
	.command("delete")
	.argument("<ids...>", "One or more chunk IDs to delete")
	.description(
		[
			"Delete specific chunks by ID. This is a hard delete with no",
			"undo. Superseded-by references pointing to deleted chunks are",
			"cleared (resurrecting the previously superseded chunk).",
		].join(" "),
	)
	.option("--force", "Skip confirmation")
	.option("--json", "Output as JSON")
	.action((ids: string[], opts: { force?: boolean; json?: boolean }) => {
		const dbPath = resolveDbPath(program);
		const db = openDb(dbPath);

		// Verify all IDs exist
		const existing = ids.filter((id) => {
			const row = db.prepare("SELECT id FROM chunks WHERE id = ?").get(id);
			return row !== undefined;
		});

		if (existing.length === 0) {
			db.close();
			if (opts.json) {
				console.log(JSON.stringify({ deleted: 0, notFound: ids }));
			} else {
				console.log("No matching chunks found.");
			}
			return;
		}

		if (!opts.force && !opts.json) {
			// Show what will be deleted
			for (const id of existing) {
				const row = db.prepare("SELECT id, kind, content FROM chunks WHERE id = ?").get(id) as {
					content: string;
					id: string;
					kind: string;
				};
				console.log(`  [${row.kind}] ${truncate(row.content, 60)} (${row.id})`);
			}
			console.log(`\nWill delete ${existing.length} chunk(s). Use --force to confirm.`);
			db.close();
			return;
		}

		// Delete in a transaction, resurrecting superseded chunks
		const deleted = db.transaction(() => {
			let count = 0;
			for (const id of existing) {
				const agentRow = db.prepare("SELECT agent_id FROM chunks WHERE id = ?").get(id) as
					| AgentIdRow
					| undefined;
				if (agentRow) {
					db.prepare(
						"UPDATE chunks SET superseded_by = NULL WHERE superseded_by = ? AND agent_id = ?",
					).run(id, agentRow.agent_id);
					db.prepare("DELETE FROM chunks WHERE id = ?").run(id);
					count++;
				}
			}
			return count;
		})();

		db.close();

		const notFound = ids.filter((id) => !existing.includes(id));
		output({ deleted, notFound }, opts.json ?? false, (d) => {
			let msg = `Deleted ${d.deleted} chunk(s).`;
			if (d.notFound.length > 0) {
				msg += ` Not found: ${d.notFound.join(", ")}`;
			}
			return msg;
		});
	});

// ── purge ────────────────────────────────────────────────────────────

program
	.command("purge")
	.description(
		[
			"Remove superseded chunks. These are facts that have been replaced",
			"by newer versions and are no longer returned by searches. Safe to",
			"run — only removes chunks marked as superseded.",
		].join(" "),
	)
	.option("--agent <id>", "Only purge for a specific agent")
	.option("--before <date>", "Only purge chunks created before this ISO date")
	.option("--force", "Skip confirmation")
	.option("--json", "Output as JSON")
	.action((opts: { agent?: string; before?: string; force?: boolean; json?: boolean }) => {
		const dbPath = resolveDbPath(program);
		const db = openDb(dbPath);

		let countSql = "SELECT COUNT(*) as count FROM chunks WHERE superseded_by IS NOT NULL";
		let deleteSql = "DELETE FROM chunks WHERE superseded_by IS NOT NULL";
		const params: unknown[] = [];

		if (opts.agent) {
			countSql += " AND agent_id = ?";
			deleteSql += " AND agent_id = ?";
			params.push(opts.agent);
		}
		if (opts.before) {
			countSql += " AND created_at < ?";
			deleteSql += " AND created_at < ?";
			params.push(opts.before);
		}

		const { count } = db.prepare(countSql).get(...params) as CountRow;

		if (count === 0) {
			db.close();
			output({ purged: 0 }, opts.json ?? false, () => "Nothing to purge.");
			return;
		}

		if (!opts.force && !opts.json) {
			console.log(`${count} superseded chunk(s) found. Use --force to purge.`);
			db.close();
			return;
		}

		db.prepare(deleteSql).run(...params);
		db.close();

		output({ purged: count }, opts.json ?? false, (d) => `Purged ${d.purged} superseded chunk(s).`);
	});

// ── export ───────────────────────────────────────────────────────────

program
	.command("export")
	.argument("<agent>", "Agent ID to export")
	.description(
		[
			"Export all data for an agent as JSON to stdout. Includes all",
			"chunks (active and superseded) and memory blocks. Embeddings",
			"are exported as base64-encoded blobs. Pipe to a file to save:",
			"  hippo --db agent.db export my-agent > backup.json",
		].join(" "),
	)
	.action((agent: string) => {
		const dbPath = resolveDbPath(program);
		const db = openDb(dbPath);

		const chunks = db.prepare("SELECT * FROM chunks WHERE agent_id = ?").all(agent) as Array<
			ChunkRow & { embedding: Buffer }
		>;
		const blocks = db
			.prepare("SELECT * FROM memory_blocks WHERE agent_id = ?")
			.all(agent) as BlockRow[];

		db.close();

		const data = {
			agentId: agent,
			blocks: blocks.map((b) => ({
				key: b.key,
				updatedAt: b.updated_at,
				value: b.value,
			})),
			chunks: chunks.map((c) => ({
				access_count: c.access_count,
				content: c.content,
				content_hash: c.content_hash,
				created_at: c.created_at,
				embedding_base64: c.embedding.toString("base64"),
				encounter_count: c.encounter_count,
				id: c.id,
				kind: c.kind,
				last_accessed_at: c.last_accessed_at,
				metadata: c.metadata,
				running_intensity: c.running_intensity,
				superseded_by: c.superseded_by,
			})),
			exportedAt: new Date().toISOString(),
			version: 1,
		};

		console.log(JSON.stringify(data, null, 2));
	});

// ── import ───────────────────────────────────────────────────────────

interface ExportedChunk {
	readonly access_count: number;
	readonly content: string;
	readonly content_hash: string | null;
	readonly created_at: string;
	readonly embedding_base64: string;
	readonly encounter_count: number;
	readonly id: string;
	readonly kind: string;
	readonly last_accessed_at: string;
	readonly metadata: string | null;
	readonly running_intensity: number;
	readonly superseded_by: string | null;
}

interface ExportedBlock {
	readonly key: string;
	readonly updatedAt: string;
	readonly value: string;
}

interface ExportData {
	readonly agentId: string;
	readonly blocks: readonly ExportedBlock[];
	readonly chunks: readonly ExportedChunk[];
	readonly version: number;
}

program
	.command("import")
	.argument("<file>", "JSON file to import (from hippo export)")
	.description(
		[
			"Import agent data from a JSON file (produced by hippo export).",
			"Initializes the schema if needed. Inserts chunks and blocks,",
			"skipping any with duplicate IDs. Does not overwrite existing data.",
		].join(" "),
	)
	.option("--json", "Output as JSON")
	.action((file: string, opts: { json?: boolean }) => {
		const dbPath = resolveDbPath(program);

		if (!existsSync(file)) {
			console.error(`Error: file not found: ${file}`);
			process.exit(1);
		}

		const raw: unknown = JSON.parse(readFileSync(file, "utf-8"));
		const data = raw as ExportData;

		if (!data.agentId || !Array.isArray(data.chunks) || !Array.isArray(data.blocks)) {
			console.error("Error: invalid export format (expected agentId, chunks, blocks)");
			process.exit(1);
		}

		const db = new Database(dbPath);
		initSchema(db);

		const insertChunk = db.prepare(`
			INSERT OR IGNORE INTO chunks (id, agent_id, content, content_hash, embedding, metadata,
				kind, running_intensity, encounter_count, access_count, last_accessed_at, superseded_by, created_at)
			VALUES (@id, @agent_id, @content, @content_hash, @embedding, @metadata,
				@kind, @running_intensity, @encounter_count, @access_count, @last_accessed_at, @superseded_by, @created_at)
		`);

		const upsertBlock = db.prepare(`
			INSERT OR IGNORE INTO memory_blocks (agent_id, key, value, updated_at)
			VALUES (@agent_id, @key, @value, @updated_at)
		`);

		let chunksInserted = 0;
		let blocksInserted = 0;

		db.transaction(() => {
			for (const c of data.chunks) {
				const result = insertChunk.run({
					access_count: c.access_count,
					agent_id: data.agentId,
					content: c.content,
					content_hash: c.content_hash,
					created_at: c.created_at,
					embedding: Buffer.from(c.embedding_base64, "base64"),
					encounter_count: c.encounter_count,
					id: c.id,
					kind: c.kind,
					last_accessed_at: c.last_accessed_at,
					metadata: c.metadata,
					running_intensity: c.running_intensity,
					superseded_by: c.superseded_by,
				});
				if (result.changes > 0) chunksInserted++;
			}
			for (const b of data.blocks) {
				const result = upsertBlock.run({
					agent_id: data.agentId,
					key: b.key,
					updated_at: b.updatedAt,
					value: b.value,
				});
				if (result.changes > 0) blocksInserted++;
			}
		})();

		db.close();

		const summary = {
			agentId: data.agentId,
			blocksImported: blocksInserted,
			blocksSkipped: data.blocks.length - blocksInserted,
			chunksImported: chunksInserted,
			chunksSkipped: data.chunks.length - chunksInserted,
		};

		output(summary, opts.json ?? false, (d) =>
			[
				`Imported for agent "${d.agentId}":`,
				`  Chunks: ${d.chunksImported} imported, ${d.chunksSkipped} skipped (duplicate)`,
				`  Blocks: ${d.blocksImported} imported, ${d.blocksSkipped} skipped (duplicate)`,
			].join("\n"),
		);
	});

// ── Parse ────────────────────────────────────────────────────────────

program.parse();
