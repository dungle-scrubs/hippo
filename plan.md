# Hippo — Agent Memory System

Persistent memory tools for the Marrow chat agent. Handles fact extraction,
semantic search, strength/decay dynamics, conflict resolution, and explicit
forgetting.

---

## Architecture

- **Package**: `~/dev/hippo`, standalone TypeScript package
- **Integration**:
  - **Marrow**: `AgentTool` instances passed via `extraTools` to `MarrowAgent`
  - **Tallow**: extension providing the same tools to tallow sessions
    (~/dev/tallow extension)
  - **CLI**: possible standalone CLI for direct memory operations (TBD —
    worth a conversation on whether this is a separate binary, a subcommand
    of an existing tool, or unnecessary if tallow/marrow cover all use cases)
- **Storage**: SQLite (better-sqlite3), reusing marrow's existing paradigm
- **Embeddings**: Float32Array blobs stored in SQLite, brute-force cosine
  similarity at query time
- **LLM**: cheap model (Gemini Flash / Haiku) for extraction and
  classification, routed through marrow's existing `LlmClient`
- **Runtime**: Bun
- **No**: MCP server, tool-proxy, PostgreSQL, Redis, cron jobs, background
  processes

### SQLite configuration

Run on every connection open:

```sql
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
```

WAL allows concurrent readers with a single writer. `busy_timeout` retries
for 5 seconds on write contention instead of failing immediately with
SQLITE_BUSY.

### Scalability ceiling

Brute-force cosine similarity is viable up to ~10k chunks per agent. Beyond
that, pre-filter by recency (last 90 days) or metadata tags before computing
similarity. If the dataset grows past 50k, migrate to sqlite-vec.

---

## Tools (8)

### Write tools

| Tool | Operates on | Pipeline |
| --- | --- | --- |
| `remember_facts` | facts | extract → embed → conflict check → insert/replace/strengthen |
| `store_memory` | memories | embed → content-hash dedup → insert or strengthen |
| `replace_memory_block` | memory block | find/replace text in a named block |
| `append_memory_block` | memory block | append text to a named block (creates block if missing) |
| `forget_memory` | facts + memories | semantic match → hard delete from chunks |

### Read tools

| Tool | Operates on | Returns |
| --- | --- | --- |
| `recall_memories` | facts + memories | semantic search results, strength-weighted |
| `recall_memory_block` | memory block | contents of a single named block (null if missing) |
| `recall_conversation` | messages | full-text search over past messages |

### Edge cases: memory block tools

- **`replace_memory_block`** — find text not found: return structured error
  (not a throw). Multiple matches: replace all. Block doesn't exist: error.
- **`append_memory_block`** — block doesn't exist: create it (upsert).
- **`recall_memory_block`** — block doesn't exist: return null.

---

## Data Model

### Facts vs Memories

Both live in the same `chunks` table, distinguished by a `kind` column.

**Facts** are atomic, have truth values, can conflict, can be superseded. They
go through the full extraction and conflict resolution pipeline.

- "User lives in Berlin"
- "User dislikes Redux"
- "The API rate limit is 100 req/min"

**Memories** are raw stored content — document chunks, experiences, decisions,
observations. They cannot conflict or be superseded. They are embedded and
stored with content-hash dedup (verbatim duplicates are strengthened, not
re-inserted).

- "We spent two hours debugging the OAuth flow and found the redirect URI
  was wrong"
- A paragraph from an uploaded PDF
- "The team decided to use SQLite instead of PostgreSQL"

### Schema

```sql
CREATE TABLE chunks (
    id                TEXT PRIMARY KEY,       -- ULID
    agent_id          TEXT NOT NULL,
    content           TEXT NOT NULL,
    content_hash      TEXT,                   -- SHA-256, for memory dedup
    embedding         BLOB NOT NULL,          -- Float32Array
    metadata          TEXT,                   -- JSON: source, tags, category
    kind              TEXT NOT NULL,          -- 'fact' or 'memory'
    running_intensity REAL NOT NULL DEFAULT 0.5,
    encounter_count   INTEGER NOT NULL DEFAULT 1,
    access_count      INTEGER NOT NULL DEFAULT 0,
    last_accessed_at  TEXT NOT NULL,           -- ISO timestamp
    superseded_by     TEXT,                    -- nullable FK to replacement chunk
    created_at        TEXT NOT NULL
);

CREATE TABLE memory_blocks (
    agent_id    TEXT NOT NULL,
    key         TEXT NOT NULL,                -- 'persona', 'human', 'objectives'
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (agent_id, key)
);
```

### Indexes

```sql
-- Memory dedup: verbatim content per agent (facts use similarity pipeline)
CREATE UNIQUE INDEX idx_chunks_memory_dedup
    ON chunks(agent_id, content_hash) WHERE kind = 'memory';

-- Query filters
CREATE INDEX idx_chunks_agent_kind ON chunks(agent_id, kind);
CREATE INDEX idx_chunks_last_accessed ON chunks(agent_id, last_accessed_at);

-- Supersession exclusion (partial — only indexes non-null rows)
CREATE INDEX idx_chunks_superseded
    ON chunks(superseded_by) WHERE superseded_by IS NOT NULL;
```

### Messages table (not owned by hippo)

Hippo does **not** define or own the `messages` table. Marrow writes messages
during its chat loop. Hippo's `recall_conversation` tool reads from it.

The consumer (marrow) is responsible for:

1. Creating the `messages` table
2. Creating an FTS5 virtual table for full-text search:

```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(
    content,
    content=messages,
    content_rowid=id
);
```

3. Keeping the FTS index in sync via triggers on INSERT/DELETE

`createHippoTools` accepts an optional `messagesTable` config (table name,
defaults to `'messages'`). If not provided, `recall_conversation` is omitted
from the returned tools array.

---

## Strength Model

Two forces act on every memory. No floors, no permanence. Everything decays
unless actively sustained.

### Formula

```
effective_strength = running_intensity × e^(-λ / decay_resistance × hours_since_last_access)

decay_resistance = 1 + log(1 + access_count) × 0.3
```

`running_intensity` is the single source of truth for how strong a memory is
pre-decay. There is no separate `base_strength` — retrieval and reinforcement
both operate on `running_intensity` directly.

### Forces

**Running intensity** — a moving average across encounters, not set once.
Updated every time the fact is reinforced or contradicted:

```
new_intensity = (old_intensity × encounter_count + new_reading) / (encounter_count + 1)
```

Early readings have high influence (few data points). Over time the average
stabilizes and individual readings matter less. Sarcasm, venting, and
momentary overreaction self-correct as new data comes in.

Retrieval applies a small boost: `running_intensity = min(1.0, running_intensity + 0.02)`.
Clamped to 1.0 to keep the scoring formula well-behaved.

**Decay resistance** — builds with access frequency. Frequently recalled
memories decay slower. A memory accessed once and a memory accessed 50 times
have fundamentally different decay rates, not just different last-access
timestamps.

| Access count | Decay resistance | Half-life |
| --- | --- | --- |
| 0 | 1.0 | ~29 days |
| 5 | 1.54 | ~44 days |
| 20 | 1.91 | ~55 days |
| 100 | 2.38 | ~69 days |

**Time decay** — continuous exponential. The default. Everything fades unless
sustained through access or reinforcement.

### Events that modify strength

| Event | What changes |
| --- | --- |
| **Creation** | `running_intensity = intensity`, `encounter_count = 1`, `access_count = 0` |
| **Retrieval** | `access_count += 1`, `last_accessed_at = now`, `running_intensity = min(1.0, running_intensity + 0.02)` |
| **Reinforcement** | `encounter_count += 1`, `access_count += 1`, `last_accessed_at = now`, running intensity updated via moving average |
| **Supersession** | Old chunk gets `superseded_by = new_id`, excluded from search. New chunk inserted fresh. |

### Design rationale

Nothing is permanent. A single intense statement doesn't cement a memory —
only sustained intensity over multiple encounters does. The system is
intentionally better than human memory: it doesn't get stuck on trauma,
sarcasm, or bad days. Intensity self-corrects as behavior contradicts or
confirms earlier statements.

---

## Intensity Detection

Rated 0.0–1.0 by the LLM during fact extraction (no extra call — part of the
extraction prompt).

### Signals

- **Emotional charge**: "hate", "love", "nightmare", "incredible"
- **Consequence language**: "cost us the client", "broke production"
- **Absolute language**: "never", "always", "I refuse", "non-negotiable"
- **Time/effort investment**: "spent three days", "been struggling with"
- **Identity statements**: "I'm a backend person", "I don't do frontend"
- **Explicit importance**: "remember this", "this is critical"
- **Repetition/elaboration**: restating the same point multiple ways
- **Contradiction of prior position**: reversal implies the new position
  matters

### Calibration

```
Casual aside, no signal              → 0.1–0.2
Clear statement with mild opinion    → 0.3–0.5
Strong conviction or emotional charge → 0.6–0.8
Sustained pattern + identity-level    → 0.85–1.0
```

---

## Recognition (Conflict Resolution)

When `remember_facts` processes a new fact, it embeds the fact and searches
existing chunks for semantic similarity.

### Threshold bands

```
similarity > 0.93     →  auto-classify DUPLICATE, strengthen
similarity 0.78–0.93  →  LLM tiebreaker (cheap model, one call)
similarity < 0.78     →  auto-classify NEW, insert
```

### LLM classification (ambiguous band only)

For each new-fact + existing-candidate pair, the LLM classifies:

- **DUPLICATE** — same information, different words. Strengthen existing,
  update running intensity.
- **SUPERSEDES** — same topic, new value. Old fact marked
  `superseded_by = new_id`. New fact inserted.
- **DISTINCT** — related but both true simultaneously. Insert as new.

No behavioral/explicit contradiction distinction — the LLM classifies into
three categories only. When a fact is superseded, the running intensity of
the new fact captures how strongly it was stated. That's enough signal.

---

## Forgetting

`forget_memory` performs a hard delete from `chunks` only. When the user asks
the agent to forget something, it's gone.

### Pipeline

```
"forget that I like Redux"
    ↓
Embed the description
    ↓
Semantic search for matching chunks
    ↓
Delete matching chunks from the database
    ↓
No record of the forget request is stored
```

No soft delete, no `forgotten_at` column, no audit trail of what was
forgotten. Forgetting means forgetting.

Memory blocks are not touched — if the agent needs to update a block after
forgetting, it uses `replace_memory_block` as a separate call.

---

## Search Scoring

`recall_memories` combines three signals:

```
score = w1 × cosine_similarity
      + w2 × effective_strength
      + w3 × recency_score
```

- `cosine_similarity` — relevance to the query, range [0, 1]
- `effective_strength` — the full strength formula (intensity × decay ×
  resistance), range [0, 1]
- `recency_score` — exponential decay over time:

```
recency_score = e^(-0.01 × days_since_creation)
```

This gives ~0.97 for 3-day-old, ~0.74 for 30-day-old, ~0.03 for a year old.
Bounded [0, 1], monotonically decreasing, no dependence on other items in
the result set.

Weights and decay constant (λ) are tuned empirically. Starting point:
`w1=0.6, w2=0.3, w3=0.1, λ=0.001`.

Chunks where `effective_strength < 0.05` are excluded from results (forgotten
by decay, not by explicit request).

Chunks with `superseded_by IS NOT NULL` are excluded from results.

---

## LLM & Embedding Calls

| Tool | LLM calls | Embedding calls | Model |
| --- | --- | --- | --- |
| `remember_facts` | 1–2 (extraction + classification if ambiguous) | N (one per extracted fact) | Cheap (Gemini Flash / Haiku) |
| `forget_memory` | 0 | 1 (query embedding) | — |
| `store_memory` | 0 | 1 | — |
| `recall_memories` | 0 | 1 (query embedding) | — |
| `recall_memory_block` | 0 | 0 | — |
| `replace_memory_block` | 0 | 0 | — |
| `append_memory_block` | 0 | 0 | — |
| `recall_conversation` | 0 | 0 (FTS, no embeddings) | — |

The classification call (LLM #2 in `remember_facts`) only fires when
candidates fall in the 0.78–0.93 ambiguous band. Most facts are clearly new
or clearly duplicate and skip it entirely.

---

## The `remember_facts` Pipeline (Detail)

```
User text
    │
    ▼
LLM call #1: Extract discrete facts + rate intensity each
    │
    │  Input:  "I NEVER want to use Redux again, it was a nightmare.
    │           Oh and I tried that new café on Sukhumvit."
    │
    │  Output: [
    │    { fact: "User strongly dislikes Redux", intensity: 0.85 },
    │    { fact: "User tried a café on Sukhumvit",  intensity: 0.15 }
    │  ]
    │
    ▼
For each extracted fact:
    │
    ├─ Embed the fact (embedding API call)
    │
    ├─ Search existing chunks for semantic similarity (top 5)
    │
    ├─ Classify:
    │   similarity > 0.93   → DUPLICATE (auto)
    │   similarity 0.78–0.93 → LLM call #2: DUPLICATE | SUPERSEDES | DISTINCT
    │   similarity < 0.78   → NEW (auto)
    │
    ▼
Execute action:
    │
    ├─ NEW       → insert chunk (ULID, agent_id, running_intensity = intensity)
    ├─ DUPLICATE → update running_intensity via moving average,
    │              encounter_count += 1, access_count += 1
    ├─ SUPERSEDES → mark old chunk superseded_by, insert new chunk
    └─ DISTINCT  → insert chunk (ULID, agent_id, running_intensity = intensity)

Return: summary of what was learned
    "Learned 2 facts: 1 new (café on Sukhumvit), 1 updated (Redux —
     reinforced dislike, intensity 0.85 → running avg 0.83)"
```

---

## Package Structure

```
~/dev/hippo/
├── src/
│   ├── index.ts                  # createHippoTools(opts) → AgentTool[]
│   ├── schema.ts                 # table definitions, migrations, WAL/busy_timeout
│   ├── embed.ts                  # embedding API calls
│   ├── similarity.ts             # cosine similarity over Float32Array
│   ├── strength.ts               # decay calculation, boost logic, scoring
│   ├── extractor.ts              # LLM-based fact extraction + classification
│   └── tools/
│       ├── remember-facts.ts
│       ├── store-memory.ts
│       ├── recall-memories.ts
│       ├── recall-memory-block.ts
│       ├── replace-memory-block.ts
│       ├── append-memory-block.ts
│       ├── recall-conversation.ts
│       └── forget-memory.ts
├── package.json
└── tsconfig.json
```

### Dependencies

```
@mariozechner/pi-agent-core   — AgentTool type
@mariozechner/pi-ai           — Type (TypeBox schemas)
better-sqlite3                — storage (marrow is Node; shared driver across both surfaces)
```

Embedding API and LLM calls use marrow's existing `LlmClient` interface,
injected via the factory options.

### Integration

```typescript
const hippoTools = createHippoTools({
    db,                    // better-sqlite3 Database handle
    llm,                   // LlmClient for extraction/classification
    embeddingApiKey,       // for text-embedding-3-small
    agentId: 'marrow-main', // namespace chunks + memory blocks per agent
    messagesTable: 'messages' // optional — omit to exclude recall_conversation
});

// Pass to MarrowAgent via extraTools
```

---

## Open Questions

- **Project-scoped vs personal memory** — not yet discussed
- **Weight tuning** (w1/w2/w3, λ, boost amounts) — empirical, tune by
  using it
- **Embedding model choice** — likely OpenAI text-embedding-3-small, could
  use Voyage for Anthropic alignment
- **Memory block management** — what blocks exist by default, when the
  agent should auto-update them vs explicit tool calls
- **Extraction prompt engineering** — the quality of fact extraction and
  intensity rating depends heavily on prompt design
- **Dream mode** — scheduled background processing (Kybernesis calls this
  the "Sleep Agent") that discovers connections between memories, generates
  tags, builds relationship edges, and surfaces insights during off-hours.
  Open questions: does this produce meaningful returns in practice, or is
  it busywork that burns tokens? Could experiment with various models
  (cheap vs capable) to evaluate whether the connections it finds are
  genuinely useful. Worth exploring before committing to the infrastructure
  (cron, job queue) it would require.
- **CLI** — TBD whether this is a separate binary, a subcommand, or
  unnecessary. Add `commander` dependency only if/when this is decided.
