import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initSchema } from "./schema.js";
import { embeddingToBuffer } from "./similarity.js";
import { ulid } from "./ulid.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
const AGENT = "test-agent";

/**
 * Run the hippo CLI and return stdout.
 *
 * @param args - CLI arguments (after "hippo")
 * @returns stdout as string
 */
function hippo(...args: string[]): string {
	return execFileSync("node", [CLI, ...args], {
		encoding: "utf-8",
		timeout: 10_000,
	}).trim();
}

/**
 * Run the hippo CLI expecting failure, return stderr.
 *
 * @param args - CLI arguments
 * @returns stderr as string
 */
function hippoFail(...args: string[]): string {
	try {
		execFileSync("node", [CLI, ...args], {
			encoding: "utf-8",
			timeout: 10_000,
		});
		throw new Error("Expected command to fail");
	} catch (err: unknown) {
		const e = err as { stderr?: string; status?: number };
		return (e.stderr ?? "").trim();
	}
}

describe("hippo CLI", () => {
	let tmpDir: string;
	let dbPath: string;

	beforeAll(() => {
		// Create a temp directory with a seeded database
		tmpDir = mkdtempSync(join(tmpdir(), "hippo-cli-test-"));
		dbPath = join(tmpDir, "test.db");

		const db = new Database(dbPath);
		initSchema(db);

		const now = new Date().toISOString();
		const embed = embeddingToBuffer(new Float32Array([0.1, 0.2, 0.3, 0.4]));

		// Insert test data
		const insertChunk = db.prepare(`
			INSERT INTO chunks (id, agent_id, content, content_hash, embedding, metadata,
				kind, running_intensity, encounter_count, access_count, last_accessed_at, created_at)
			VALUES (@id, @agent_id, @content, @content_hash, @embedding, @metadata,
				@kind, @running_intensity, @encounter_count, @access_count, @last_accessed_at, @created_at)
		`);

		const factId = ulid();
		const memoryId = ulid();
		const supersededId = ulid();
		const supersederId = ulid();

		insertChunk.run({
			access_count: 3,
			agent_id: AGENT,
			content: "User likes TypeScript",
			content_hash: null,
			created_at: now,
			embedding: embed,
			encounter_count: 2,
			id: factId,
			kind: "fact",
			last_accessed_at: now,
			metadata: null,
			running_intensity: 0.7,
		});

		insertChunk.run({
			access_count: 1,
			agent_id: AGENT,
			content: "OAuth redirect was misconfigured",
			content_hash: "abc123",
			created_at: now,
			embedding: embed,
			encounter_count: 1,
			id: memoryId,
			kind: "memory",
			last_accessed_at: now,
			metadata: '{"source": "debug"}',
			running_intensity: 0.5,
		});

		// Supersession chain: supersededId was replaced by supersederId
		insertChunk.run({
			access_count: 0,
			agent_id: AGENT,
			content: "User lives in Berlin",
			content_hash: null,
			created_at: now,
			embedding: embed,
			encounter_count: 1,
			id: supersededId,
			kind: "fact",
			last_accessed_at: now,
			metadata: null,
			running_intensity: 0.4,
		});
		insertChunk.run({
			access_count: 0,
			agent_id: AGENT,
			content: "User lives in Bangkok",
			content_hash: null,
			created_at: now,
			embedding: embed,
			encounter_count: 1,
			id: supersederId,
			kind: "fact",
			last_accessed_at: now,
			metadata: null,
			running_intensity: 0.5,
		});
		db.prepare("UPDATE chunks SET superseded_by = ? WHERE id = ?").run(supersederId, supersededId);

		// Insert a block
		db.prepare(
			"INSERT INTO memory_blocks (agent_id, key, value, updated_at) VALUES (?, ?, ?, ?)",
		).run(AGENT, "persona", "A helpful coding assistant", now);

		db.close();
	});

	afterAll(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	// ── --help ─────────────────────────────────────────────────────

	it("shows help with --help", () => {
		const out = hippo("--help");
		expect(out).toContain("Inspect and manage hippo memory databases");
		expect(out).toContain("Commands:");
		expect(out).toContain("init");
		expect(out).toContain("stats");
		expect(out).toContain("chunks");
		expect(out).toContain("search");
	});

	it("shows subcommand help", () => {
		const out = hippo("chunks", "--help");
		expect(out).toContain("--kind");
		expect(out).toContain("--superseded");
		expect(out).toContain("--json");
	});

	// ── init ───────────────────────────────────────────────────────

	it("init creates a new database", () => {
		const newDb = join(tmpDir, "new.db");
		const out = hippo("--db", newDb, "init");
		expect(out).toContain("Initialized");
		expect(existsSync(newDb)).toBe(true);
	});

	it("init is idempotent", () => {
		const out = hippo("--db", dbPath, "init");
		expect(out).toContain("Initialized");
	});

	// ── stats ──────────────────────────────────────────────────────

	it("stats shows database overview", () => {
		const out = hippo("--db", dbPath, "stats");
		expect(out).toContain("Agents:");
		expect(out).toContain("Chunks:");
		expect(out).toContain("Blocks:");
		expect(out).toContain("facts");
	});

	it("stats --json returns structured data", () => {
		const out = hippo("--db", dbPath, "stats", "--json");
		const data = JSON.parse(out);
		expect(data.agents).toBe(1);
		expect(data.chunks.total).toBe(4);
		expect(data.chunks.facts).toBe(3);
		expect(data.chunks.memories).toBe(1);
		expect(data.chunks.superseded).toBe(1);
		expect(data.blocks).toBe(1);
		expect(data.fileSizeBytes).toBeGreaterThan(0);
	});

	// ── agents ─────────────────────────────────────────────────────

	it("agents lists agent IDs", () => {
		const out = hippo("--db", dbPath, "agents");
		expect(out).toContain(AGENT);
	});

	it("agents --json returns array", () => {
		const out = hippo("--db", dbPath, "agents", "--json");
		const data = JSON.parse(out);
		expect(data.length).toBeGreaterThan(0);
		expect(data[0].agentId).toBe(AGENT);
		expect(data[0].chunks).toBeGreaterThan(0);
	});

	// ── chunks ─────────────────────────────────────────────────────

	it("chunks lists active chunks", () => {
		const out = hippo("--db", dbPath, "chunks", AGENT);
		expect(out).toContain("TypeScript");
		expect(out).toContain("OAuth");
		expect(out).toContain("Bangkok");
		// Superseded chunk should be excluded by default
		expect(out).not.toContain("Berlin");
	});

	it("chunks --superseded includes superseded", () => {
		const out = hippo("--db", dbPath, "chunks", AGENT, "--superseded");
		expect(out).toContain("Berlin");
		expect(out).toContain("superseded by");
	});

	it("chunks --kind fact filters by kind", () => {
		const out = hippo("--db", dbPath, "chunks", AGENT, "--kind", "fact");
		expect(out).toContain("TypeScript");
		expect(out).not.toContain("OAuth");
	});

	it("chunks --json returns structured data", () => {
		const out = hippo("--db", dbPath, "chunks", AGENT, "--json");
		const data = JSON.parse(out);
		expect(data.length).toBe(3); // excludes superseded
		expect(data[0].id).toBeTruthy();
		expect(data[0].content).toBeTruthy();
		expect(data[0].kind).toBeTruthy();
		// Should NOT contain raw embedding
		expect(data[0].embedding).toBeUndefined();
	});

	it("chunks --limit caps results", () => {
		const out = hippo("--db", dbPath, "chunks", AGENT, "--json", "--limit", "1");
		const data = JSON.parse(out);
		expect(data.length).toBe(1);
	});

	// ── blocks ─────────────────────────────────────────────────────

	it("blocks lists block keys", () => {
		const out = hippo("--db", dbPath, "blocks", AGENT);
		expect(out).toContain("persona");
	});

	it("blocks --json returns structured data", () => {
		const out = hippo("--db", dbPath, "blocks", AGENT, "--json");
		const data = JSON.parse(out);
		expect(data.length).toBe(1);
		expect(data[0].key).toBe("persona");
		expect(data[0].sizeBytes).toBeGreaterThan(0);
	});

	// ── block ──────────────────────────────────────────────────────

	it("block returns block content", () => {
		const out = hippo("--db", dbPath, "block", AGENT, "persona");
		expect(out).toBe("A helpful coding assistant");
	});

	it("block --json returns structured data", () => {
		const out = hippo("--db", dbPath, "block", AGENT, "persona", "--json");
		const data = JSON.parse(out);
		expect(data.value).toBe("A helpful coding assistant");
		expect(data.key).toBe("persona");
	});

	it("block errors on missing key", () => {
		const err = hippoFail("--db", dbPath, "block", AGENT, "nonexistent");
		expect(err).toContain("not found");
	});

	// ── search ─────────────────────────────────────────────────────

	it("search finds matching chunks", () => {
		const out = hippo("--db", dbPath, "search", "TypeScript");
		expect(out).toContain("TypeScript");
	});

	it("search returns empty for no matches", () => {
		const out = hippo("--db", dbPath, "search", "xyznonexistent");
		expect(out).toContain("No matches");
	});

	it("search --json returns structured data", () => {
		const out = hippo("--db", dbPath, "search", "OAuth", "--json");
		const data = JSON.parse(out);
		expect(data.length).toBe(1);
		expect(data[0].content).toContain("OAuth");
	});

	it("search --agent filters by agent", () => {
		const out = hippo("--db", dbPath, "search", "TypeScript", "--agent", "nonexistent", "--json");
		const data = JSON.parse(out);
		expect(data.length).toBe(0);
	});

	// ── delete ─────────────────────────────────────────────────────

	it("delete without --force shows preview", () => {
		// Get a chunk ID first
		const json = hippo("--db", dbPath, "chunks", AGENT, "--json", "--kind", "memory");
		const chunks = JSON.parse(json);
		const id = chunks[0].id;

		const out = hippo("--db", dbPath, "delete", id);
		expect(out).toContain("Will delete");
		expect(out).toContain("--force");

		// Chunk should still exist
		const after = hippo("--db", dbPath, "chunks", AGENT, "--json", "--kind", "memory");
		expect(JSON.parse(after).length).toBe(1);
	});

	// ── purge ──────────────────────────────────────────────────────

	it("purge without --force shows count", () => {
		const out = hippo("--db", dbPath, "purge");
		expect(out).toContain("superseded");
		expect(out).toContain("--force");
	});

	// ── export / import ────────────────────────────────────────────

	it("export produces valid JSON with all data", () => {
		const out = hippo("--db", dbPath, "export", AGENT);
		const data = JSON.parse(out);
		expect(data.agentId).toBe(AGENT);
		expect(data.version).toBe(1);
		expect(data.chunks.length).toBe(4); // includes superseded
		expect(data.blocks.length).toBe(1);
		expect(data.chunks[0].embedding_base64).toBeTruthy();
	});

	it("export → import roundtrips data", () => {
		// Export
		const exported = hippo("--db", dbPath, "export", AGENT);

		// Import into a fresh database
		const newDb = join(tmpDir, "import-test.db");
		const exportFile = join(tmpDir, "export.json");
		writeFileSync(exportFile, exported);

		const out = hippo("--db", newDb, "import", exportFile, "--json");
		const result = JSON.parse(out);
		expect(result.chunksImported).toBe(4);
		expect(result.blocksImported).toBe(1);

		// Verify data exists in new DB
		const stats = JSON.parse(hippo("--db", newDb, "stats", "--json"));
		expect(stats.chunks.total).toBe(4);
		expect(stats.blocks).toBe(1);
	});

	it("import skips duplicates on re-import", () => {
		const exported = hippo("--db", dbPath, "export", AGENT);
		const exportFile = join(tmpDir, "reexport.json");
		writeFileSync(exportFile, exported);

		// Import into same DB — all should be skipped
		const out = hippo("--db", dbPath, "import", exportFile, "--json");
		const result = JSON.parse(out);
		expect(result.chunksImported).toBe(0);
		expect(result.chunksSkipped).toBe(4);
	});

	// ── error handling ─────────────────────────────────────────────

	it("errors without --db flag", () => {
		const err = hippoFail("stats");
		expect(err).toContain("--db");
	});

	it("stats errors on missing database file", () => {
		const err = hippoFail("--db", "/tmp/nonexistent-hippo.db", "stats");
		expect(err).toContain("not found");
	});
});
