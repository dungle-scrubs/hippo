<p align="center">
  <img src="assets/logo.png" alt="Hippo" width="200" height="200">
</p>

# Hippo

Persistent memory for AI agents. Give your agent the ability to
learn facts, store experiences, recall semantically, and forget
on command — backed by SQLite, with no external services.

## Three ways to use it

| Mode | What | When |
|------|------|------|
| **Library** | `createHippoTools(opts)` returns `AgentTool[]` | You're building on marrow / pi-agent-core |
| **MCP server** | `hippo-server` binary, HTTP/SSE or STDIO | Any MCP-compatible client (Claude, Cursor, etc.) |
| **CLI** | `hippo` binary for inspection and management | Database admin, debugging, backup/restore |

All three share the same SQLite storage, strength model, and
conflict resolution. The library provides all 8 memory tools; the
MCP server exposes 7 (all except `recall_conversation`, which
requires a client-managed messages table). The CLI provides
read/write database access without embedding or LLM calls.

## Install

```bash
pnpm add @dungle-scrubs/hippo
```

### Dependencies by usage mode

| Dependency | Library | MCP server | CLI |
|------------|---------|------------|-----|
| `better-sqlite3` | Required | Required | Required |
| `@mariozechner/pi-agent-core` | Required | — | — |
| `@mariozechner/pi-ai` | Required | — | — |

**Library mode** returns `AgentTool` instances from pi-agent-core,
so both pi packages are peer dependencies. **MCP server** and
**CLI** are standalone — they have no pi dependency. If you're
only using hippo as an MCP server or CLI tool, you only need
`better-sqlite3`.

## Quick start — Library

```typescript
import Database from "better-sqlite3";
import { createHippoTools } from "@dungle-scrubs/hippo";

const db = new Database("agent.db");

const tools = createHippoTools({
  db,
  agentId: "my-agent",
  embed: async (text) => {
    // Your embedding function → Float32Array
    return callEmbeddingApi(text);
  },
  llm: {
    complete: async (messages, systemPrompt) => {
      return callLlm(messages, systemPrompt);
    },
  },
});

// Pass to your agent framework
agent.addTools(tools);
```

`createHippoTools` initializes the schema (idempotent) and returns
7 tools. Pass `messagesTable: "messages"` to get an 8th tool that
searches conversation history via FTS5.

### Built-in providers

Don't want to wire up embedding and LLM functions yourself? Hippo
ships OpenAI-compatible providers that work with any `/v1/embeddings`
or `/v1/chat/completions` endpoint (OpenAI, OpenRouter, Ollama,
vLLM, etc.):

```typescript
import Database from "better-sqlite3";
import {
  createHippoTools,
  createEmbeddingProvider,
  createLlmProvider,
} from "@dungle-scrubs/hippo";

const db = new Database("agent.db");

const tools = createHippoTools({
  db,
  agentId: "my-agent",
  embed: createEmbeddingProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    baseUrl: "https://api.openai.com/v1",
    model: "text-embedding-3-small",
    dimensions: 1536, // optional
  }),
  llm: createLlmProvider({
    apiKey: process.env.OPENROUTER_API_KEY!,
    baseUrl: "https://openrouter.ai/api/v1",
    model: "google/gemini-flash-2.0",
  }),
});
```

### Embedding model safety

Call `verifyEmbeddingModel(db, "text-embedding-3-small")` after
`initSchema` to lock the database to a specific embedding model.
First call stores the model name. Subsequent calls throw if the
model doesn't match — prevents mixing incompatible vector spaces.

```typescript
import { initSchema, verifyEmbeddingModel } from "@dungle-scrubs/hippo";

initSchema(db);
verifyEmbeddingModel(db, "text-embedding-3-small");
// Later, with a different model:
verifyEmbeddingModel(db, "voyage-3"); // throws!
```

## Quick start — MCP server

The MCP server handles embedding and LLM calls internally. Clients
send text; hippo vectorizes and stores. Every tool call takes an
`agent_id` parameter for multi-agent support on a shared database.

```bash
# Required
export HIPPO_DB=./agent.db
export HIPPO_EMBED_KEY=sk-...
export HIPPO_LLM_KEY=sk-...

# Start HTTP/SSE server (default)
hippo-server

# Or STDIO for single-client piping
HIPPO_TRANSPORT=stdio hippo-server
```

### Server environment variables

| Variable | Required | Default |
|----------|----------|---------|
| `HIPPO_DB` | Yes | — |
| `HIPPO_EMBED_KEY` | Yes | — |
| `HIPPO_LLM_KEY` | Yes | — |
| `HIPPO_TRANSPORT` | No | `http` |
| `HIPPO_PORT` | No | `3100` |
| `HIPPO_EMBED_URL` | No | `https://api.openai.com/v1` |
| `HIPPO_EMBED_MODEL` | No | `text-embedding-3-small` |
| `HIPPO_EMBED_DIMENSIONS` | No | (model default) |
| `HIPPO_LLM_URL` | No | `https://openrouter.ai/api/v1` |
| `HIPPO_LLM_MODEL` | No | `google/gemini-flash-2.0` |

### HTTP endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/sse` | Open SSE connection (returns `sessionId`) |
| `POST` | `/messages?sessionId=<id>` | Send MCP messages |
| `GET` | `/health` | Health check (`{"status": "ok"}`) |

## Quick start — CLI

The CLI inspects and manages hippo databases without embedding or
LLM access. For semantic operations, use the library or MCP server.

```bash
# Set once, or pass --db <path> to every command
export HIPPO_DB=./agent.db

# Initialize schema (idempotent)
hippo init

# Overview
hippo stats
hippo agents

# Browse data
hippo chunks my-agent
hippo chunks my-agent --kind fact --limit 20
hippo blocks my-agent
hippo block my-agent persona

# Text search (case-insensitive, across all agents)
hippo search "redux" --kind fact

# Maintenance
hippo delete CHUNK_ID_1 CHUNK_ID_2 --force
hippo purge --force
hippo purge --agent my-agent --before 2025-01-01 --force

# Backup and restore
hippo export my-agent > backup.json
hippo import backup.json
```

All commands support `--json` for machine-readable output.

### CLI commands

| Command | What it does |
|---------|-------------|
| `init` | Create tables and indexes (idempotent) |
| `stats` | Chunk counts, block counts, agent count, file size |
| `agents` | List all agent IDs with chunk counts |
| `chunks <agent>` | List chunks with filters (`--kind`, `--superseded`, `--limit`) |
| `blocks <agent>` | List memory blocks with sizes |
| `block <agent> <key>` | Get contents of a named block |
| `search <text>` | Case-insensitive LIKE search across chunks |
| `delete <ids...>` | Hard delete by ID, resurrects superseded chunks |
| `purge` | Remove superseded chunks (`--agent`, `--before` filters) |
| `export <agent>` | Export all data as JSON (embeddings as base64) |
| `import <file>` | Import from JSON, skip duplicate IDs |

## Tools

### Write

| Tool | What it does |
|------|-------------|
| `remember_facts` | Extract facts from text, rate intensity, detect duplicates and contradictions, store or update |
| `store_memory` | Store raw content (docs, decisions, experiences) with content-hash dedup |
| `append_memory_block` | Append text to a named block (creates if missing) |
| `replace_memory_block` | Find/replace text in a named block (replaces all occurrences) |
| `forget_memory` | Semantic match → hard delete. No audit trail. |

### Read

| Tool | What it does |
|------|-------------|
| `recall_memories` | Semantic search across facts and memories, ranked by relevance × strength × recency |
| `recall_memory_block` | Get contents of a named block (null if missing) |
| `recall_conversation` | Full-text search over past messages (FTS5) |

## Key concepts

### Facts vs memories

Both live in the same `chunks` table, distinguished by a `kind` column.

**Facts** are atomic claims that can conflict. "User lives in
Berlin" can be superseded by "User lives in Bangkok." They go
through extraction, embedding, and conflict resolution.

**Memories** are raw content — experiences, documents, decisions.
They can't conflict. Verbatim duplicates are strengthened, not
re-inserted.

### Strength and decay

Every memory decays over time unless actively used. Two forces
interact:

**Running intensity** — a moving average across encounters.
A single emotional outburst doesn't cement a memory; sustained
intensity over multiple encounters does. Early readings have
high influence, but the average stabilizes as data accumulates.

**Decay resistance** — built by access frequency. A memory
recalled 50 times decays far slower than one recalled once.

```
effective_strength = intensity × e^(-λ / resistance × hours)
resistance = 1 + log(1 + access_count) × 0.3
```

| Access count | Decay resistance | Half-life |
|--------------|-----------------|-----------|
| 0 | 1.0 | ~29 days |
| 5 | 1.54 | ~44 days |
| 20 | 1.91 | ~55 days |
| 100 | 2.38 | ~69 days |

Memories below 5% effective strength are excluded from search
results — effectively forgotten through disuse.

### Conflict resolution

When `remember_facts` stores a new fact, it checks existing
facts by cosine similarity (top 5 candidates):

```
> 0.93  → auto-classify DUPLICATE, strengthen existing
0.78–0.93 → LLM tiebreaker (one cheap call)
< 0.78  → auto-classify NEW, insert
```

The LLM returns one of three verdicts: **DUPLICATE** (same info,
different words), **SUPERSEDES** (same topic, new value), or
**DISTINCT** (related but both true).

Facts extracted from the same text have intra-batch visibility —
each fact sees the results of previously processed facts in the
same call, preventing duplicate insertions within a batch.

### Search scoring

`recall_memories` ranks results by a weighted composite:

```
score = 0.6 × cosine_similarity
      + 0.3 × effective_strength
      + 0.1 × recency_score
```

Recency decays exponentially: ~0.97 at 3 days, ~0.74 at 30 days,
~0.03 at 1 year.

Accessed chunks get a small retrieval boost (+0.02 to intensity),
so frequently recalled memories stay strong.

### Forgetting

`forget_memory` performs a hard delete. No soft deletes, no audit
trail. When a deleted chunk had superseded another chunk, the
superseded chunk is resurrected (its `superseded_by` reference is
cleared).

Memory blocks are not touched by `forget_memory` — use
`replace_memory_block` separately if needed.

## Configuration

### Library options

```typescript
interface HippoOptions {
  db: Database;                           // better-sqlite3 handle
  agentId: string;                        // namespace for multi-agent isolation
  embed: EmbedFn;                         // (text, signal?) => Float32Array
  llm: LlmClient;                         // { complete(messages, systemPrompt, signal?) }
  messagesTable?: string;                 // enables recall_conversation
  scope?: string;                         // default write scope (optional)
  recallScopes?: string | readonly string[]; // optional recall filter
}
```

**`agentId`** — all chunks and blocks are scoped to this ID.
Multiple agents can share one database without interference.

**`scope`** — optional default scope for writes (`remember_facts`,
`store_memory`, and memory block tools). Omit to write globally.

**`recallScopes`** — optional scope filter for recall operations
(`recall_memories`, `forget_memory`). Accepts one scope or many.
When omitted, recall behavior is unchanged (searches all scopes).

**`embed`** — you provide the embedding function. Hippo stores
the resulting `Float32Array` as a BLOB and does brute-force
cosine similarity at query time. Any embedding model works;
dimensions don't matter as long as they're consistent.

**`llm`** — used only by `remember_facts` for extraction and
conflict classification. A cheap, fast model is ideal. Most
tools make zero LLM calls.

**`messagesTable`** — if your agent writes messages to a table,
hippo can search it with FTS5. You own the table and FTS index;
hippo just reads from it. Omit this to exclude
`recall_conversation` from the tool set.

### Embedding provider options

```typescript
interface EmbeddingProviderConfig {
  apiKey: string;       // Bearer token
  baseUrl: string;      // e.g. "https://api.openai.com/v1"
  model: string;        // e.g. "text-embedding-3-small"
  dimensions?: number;  // optional, model-dependent
}
```

### LLM provider options

```typescript
interface LlmProviderConfig {
  apiKey: string;        // Bearer token
  baseUrl: string;       // e.g. "https://openrouter.ai/api/v1"
  model: string;         // e.g. "google/gemini-flash-2.0"
  maxTokens?: number;    // default: 2048
  temperature?: number;  // default: 0
}
```

## LLM and embedding costs

| Tool | LLM calls | Embed calls |
|------|-----------|-------------|
| `remember_facts` | 1–2 | N (per extracted fact) |
| `store_memory` | 0 | 1 |
| `recall_memories` | 0 | 1 |
| `forget_memory` | 0 | 1 |
| `recall_memory_block` | 0 | 0 |
| `replace_memory_block` | 0 | 0 |
| `append_memory_block` | 0 | 0 |
| `recall_conversation` | 0 | 0 |

The second LLM call in `remember_facts` only fires when a
candidate falls in the ambiguous 0.78–0.93 similarity band.
Most facts are clearly new or clearly duplicate and skip it.

## Storage

SQLite via better-sqlite3. Schema is created automatically on
first call. WAL mode and 5-second busy timeout are set on every
connection.

```
chunks         — facts and memories with embeddings
memory_blocks  — key-value text blocks (persona, objectives, etc.)
hippo_meta     — embedding model tracking
```

Brute-force cosine similarity is viable up to ~10k chunks per
agent. Beyond that, pre-filter by recency or tags. Past 50k,
consider migrating to sqlite-vec.

## Dashboard chunk mutations

These are library helpers for building edit/delete APIs outside the
agent tool interface:

```typescript
import { deleteChunk, updateChunk } from "@dungle-scrubs/hippo";

const updated = await updateChunk(db, embed, chunkId, "new content");
const deleted = deleteChunk(db, chunkId);
```

- `updateChunk` re-embeds content and updates chunk fields in a
  single transaction.
- `deleteChunk` hard-deletes a chunk and clears supersession
  references that pointed to it.

## Exports

The library exports both the tool factory and all building blocks:

```typescript
// Main API
export { createHippoTools } from "@dungle-scrubs/hippo";

// Built-in providers
export { createEmbeddingProvider } from "@dungle-scrubs/hippo";
export { createLlmProvider } from "@dungle-scrubs/hippo";

// Chunk mutation helpers
export { deleteChunk, updateChunk } from "@dungle-scrubs/hippo";

// Schema utilities
export { initSchema, verifyEmbeddingModel } from "@dungle-scrubs/hippo";

// Types
export type {
  Chunk, ChunkKind, EmbedFn, HippoOptions,
  LlmClient, MemoryBlock, RememberFactAction,
  RememberFactsResult, ScopeFilter, SearchResult,
  EmbeddingProviderConfig, LlmProviderConfig,
} from "@dungle-scrubs/hippo";
```

## Development

```bash
pnpm install
just ci          # build + check + test

just build       # tsc → dist/
just test        # vitest run (209 tests)
just test-watch  # vitest watch mode
just typecheck   # tsc --noEmit
just check       # biome lint + format
just fix         # auto-fix lint and format
```

## Requirements

- Node ≥ 22
- pnpm
