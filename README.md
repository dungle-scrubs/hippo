# Hippo

Persistent memory for AI agents. Give your agent the ability to
learn facts, store experiences, recall semantically, and forget
on command — backed by SQLite, with no external services.

Hippo is a TypeScript library that produces `AgentTool` instances.
You inject a database handle, an embedding function, and an LLM
client; it hands back tools your agent can call during conversation.

## Install

```bash
pnpm add hippo
```

Peer dependencies: `better-sqlite3`, `@mariozechner/pi-agent-core`,
`@mariozechner/pi-ai`, `@sinclair/typebox`.

## Quick start

```typescript
import Database from "better-sqlite3";
import { createHippoTools } from "hippo";

const db = new Database("agent.db");

const tools = createHippoTools({
  db,
  agentId: "my-agent",
  embed: async (text) => {
    // Your embedding function → Float32Array
    // e.g. OpenAI text-embedding-3-small
    return callEmbeddingApi(text);
  },
  llm: {
    // Cheap model for fact extraction (Gemini Flash, Haiku, etc.)
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

## Tools

### Write

| Tool | What it does |
|------|-------------|
| `remember_facts` | Extract facts from text, rate intensity, detect duplicates and contradictions, store or update |
| `store_memory` | Store raw content (docs, decisions, experiences) with content-hash dedup |
| `append_memory_block` | Append text to a named block (creates if missing) |
| `replace_memory_block` | Find/replace text in a named block |
| `forget_memory` | Semantic match → hard delete. No audit trail. |

### Read

| Tool | What it does |
|------|-------------|
| `recall_memories` | Semantic search across facts and memories, ranked by relevance × strength × recency |
| `recall_memory_block` | Get contents of a named block (null if missing) |
| `recall_conversation` | Full-text search over past messages (FTS5) |

## Key concepts

### Facts vs memories

Both live in the same table, distinguished by a `kind` column.

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

Memories below 5% effective strength are excluded from search
results — effectively forgotten through disuse.

### Conflict resolution

When `remember_facts` stores a new fact, it checks existing
facts by cosine similarity:

```
> 0.93  → auto-classify DUPLICATE, strengthen existing
0.78–0.93 → LLM tiebreaker (one cheap call)
< 0.78  → auto-classify NEW, insert
```

The LLM returns one of three verdicts: **DUPLICATE** (same info,
different words), **SUPERSEDES** (same topic, new value), or
**DISTINCT** (related but both true).

### Search scoring

`recall_memories` ranks results by a weighted composite:

```
score = 0.6 × cosine_similarity
      + 0.3 × effective_strength
      + 0.1 × recency_score
```

Accessed chunks get a small retrieval boost (+0.02 to intensity),
so frequently recalled memories stay strong.

## Configuration

```typescript
interface HippoOptions {
  db: Database;           // better-sqlite3 handle
  agentId: string;        // namespace for multi-agent isolation
  embed: EmbedFn;         // (text, signal?) => Float32Array
  llm: LlmClient;        // { complete(messages, systemPrompt, signal?) }
  messagesTable?: string; // enables recall_conversation
}
```

**`agentId`** — all chunks and blocks are scoped to this ID.
Multiple agents can share one database without interference.

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
```

Brute-force cosine similarity is viable up to ~10k chunks per
agent. Beyond that, pre-filter by recency or tags. Past 50k,
consider migrating to sqlite-vec.

## Requirements

- Node ≥ 22
- pnpm (package manager)
