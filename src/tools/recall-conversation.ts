import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import type { Database } from "better-sqlite3";

const Params = Type.Object({
	limit: Type.Optional(
		Type.Number({ description: "Max results to return (default: 20)", minimum: 1 }),
	),
	query: Type.String({ description: "Search term for past messages" }),
});

/** A row from the messages FTS search. */
interface MessageSearchRow {
	readonly content: string;
	readonly created_at: string;
	readonly role: string;
}

/**
 * Options for creating the recall_conversation tool.
 *
 * The messages table must have columns: `id` (INTEGER PRIMARY KEY),
 * `role` (TEXT), `content` (TEXT), `created_at` (TEXT).
 * An FTS5 virtual table named `{messagesTable}_fts` must index the
 * `content` column with `content_rowid=id`.
 */
export interface RecallConversationToolOptions {
	readonly db: Database;
	readonly messagesTable: string;
}

/**
 * Create the recall_conversation tool.
 *
 * Full-text search over past messages using FTS5.
 * The consumer (marrow) is responsible for creating the messages table
 * and FTS index.
 *
 * @param opts - Tool options
 * @returns AgentTool instance
 */
/**
 * Validate a SQL identifier to prevent injection via table name interpolation.
 *
 * @param name - Table name to validate
 * @throws If the name contains unsafe characters
 */
function assertSafeIdentifier(name: string): void {
	if (!/^[a-zA-Z_]\w*$/.test(name)) {
		throw new Error(`Unsafe SQL identifier: "${name}"`);
	}
}

export function createRecallConversationTool(
	opts: RecallConversationToolOptions,
): AgentTool<typeof Params> {
	assertSafeIdentifier(opts.messagesTable);
	const ftsTable = `${opts.messagesTable}_fts`;

	return {
		description:
			"Full-text search over past conversation messages. Returns matching messages ranked by relevance.",
		execute: async (_toolCallId, params) => {
			const limit = params.limit ?? 20;

			let rows: MessageSearchRow[];
			try {
				// Prepared per-call intentionally: the FTS table may not exist when the
				// tool is created (marrow creates it). better-sqlite3 caches prepared
				// statements internally by SQL text, so runtime overhead is negligible.
				rows = opts.db
					.prepare(
						`SELECT m.role, m.content, m.created_at
						FROM ${ftsTable} fts
						JOIN ${opts.messagesTable} m ON fts.rowid = m.id
						WHERE ${ftsTable} MATCH ?
						ORDER BY rank
						LIMIT ?`,
					)
					.all(params.query, limit) as MessageSearchRow[];
			} catch (err: unknown) {
				// Only handle SQLite operational errors (missing table, bad FTS syntax).
				// Re-throw unexpected errors (I/O, corruption, OOM).
				const isSqliteError =
					err instanceof Error &&
					"code" in err &&
					(err as Error & { code: string }).code === "SQLITE_ERROR";
				if (!isSqliteError) {
					throw err;
				}

				const msg = (err as Error).message?.toLowerCase() ?? "";
				const isTableMissing = msg.includes("no such table") || msg.includes("no such module");

				const result: AgentToolResult<{ error: string }> = {
					content: [
						{
							text: isTableMissing
								? "Conversation search unavailable (FTS index may not exist)."
								: `Search query error: ${(err as Error).message}`,
							type: "text",
						},
					],
					details: { error: isTableMissing ? "fts_unavailable" : "query_error" },
				};
				return result;
			}

			if (rows.length === 0) {
				const result: AgentToolResult<{ matches: number }> = {
					content: [{ text: "No matching messages found.", type: "text" }],
					details: { matches: 0 },
				};
				return result;
			}

			const lines = rows.map((r, i) => {
				return `${i + 1}. [${r.role}] (${r.created_at}) ${r.content}`;
			});

			const result: AgentToolResult<{ matches: number }> = {
				content: [{ text: lines.join("\n"), type: "text" }],
				details: { matches: rows.length },
			};
			return result;
		},
		label: "Recall Conversation",
		name: "recall_conversation",
		parameters: Params,
	};
}
