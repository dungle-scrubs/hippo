# Hippo Roadmap

## Scope Column

Add an optional `scope` column to the `chunks` and
`memory_blocks` tables. This enables consumers to
partition memories by project, user, or any other
namespace without Hippo enforcing a specific policy.

### Schema Changes

```sql
-- chunks table
ALTER TABLE chunks ADD COLUMN scope TEXT;
CREATE INDEX idx_chunks_scope ON chunks(agent_id, scope);

-- memory_blocks table
ALTER TABLE memory_blocks ADD COLUMN scope TEXT;
```

### API Changes

- `createHippoTools()` accepts an optional `scope`
  in `HippoOptions`. When set, all write operations
  tag chunks with that scope.
- Recall functions accept an optional `scope` filter
  (single value or array of values). When provided,
  only chunks matching the scope(s) are searched.
- When `scope` is not provided, behavior is unchanged
  (backward compatible — searches all chunks).

### Consumer Enforcement

Hippo does not enforce scope requirements. Consumers
decide their own policy:

- **Marrow**: requires scope on every operation.
  Wraps Hippo tools so the agent cannot store
  unscoped chunks. Loads `scope = "user"` (always)
  plus `scope = <projectId>` (per session). Never
  loads other projects' chunks.
- **Other consumers**: can ignore scope entirely.
  The column is nullable and all existing queries
  work without it.

### Migration

Existing chunks (no scope) remain `scope = NULL`.
Consumers can backfill as needed. Marrow will
backfill existing chunks to `scope = "project-default"`
during its migration.

---

## Dashboard Edit/Delete API

Expose mutation endpoints so consumers can build
memory management UIs.

### New Functions

```typescript
/** Update a chunk's content and re-embed. */
function updateChunk(
  db: Database,
  embed: EmbedFn,
  chunkId: string,
  newContent: string
): Promise<Chunk>

/** Hard-delete a chunk by ID. */
function deleteChunk(
  db: Database,
  chunkId: string
): boolean
```

### Behavior

- `updateChunk` replaces `content`, recomputes
  `content_hash`, calls `embed()` to generate a new
  embedding vector, and updates both in a single
  transaction. Timestamps are updated.
- `deleteChunk` is a hard delete, same as
  `forget_memory`. No soft delete, no audit trail.

These are library functions, not agent tools. They
are intended for dashboard/API use, not for the
agent to call during conversation.

---

## Hybrid BM25 + Vector Search (RRF)

Already documented in plan.md. Summary:

1. Add FTS5 virtual table over `chunks.content`
2. BM25 keyword retrieval in parallel with vector
3. Reciprocal Rank Fusion to merge ranked lists
4. Strength and recency weighting applied after
   fusion

---

## MCP Server

HTTP/SSE transport for non-Marrow consumers.
Embedding and LLM configured in Hippo server
config (not passed by caller). `agent_id` as a
per-call parameter.

---

## Dream Mode (Exploratory)

Scheduled background processing that discovers
connections between memories, generates tags, builds
relationship edges, and surfaces insights. Open
question: does this produce meaningful returns or
burn tokens on busywork? Requires experimentation
before committing to infrastructure.
