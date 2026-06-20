# Architecture: Memory, Context, And RAG

HF AI Code keeps durable state on disk and reconstructs the active prompt from structured sources instead of replaying the entire raw transcript every time.

## Design Rules

- RAM is a cache, not the source of truth
- chat history persists until explicit deletion
- old history is compacted, not dropped
- retrieval is local-first and persistent
- semantic retrieval is optional and failure-tolerant

## Storage Layout

Workspace-scoped storage:

- `chats/index.json`
- `chats/messages/<chatId>.jsonl`
- `chats/summaries/<chatId>.json`
- `tasks/index.json`
- `tasks/<taskId>.json`
- `patches/index.json`
- `patches/<patchId>.json`
- `patches/artifacts/...`
- `memory/workspace.json`
- `rag/index.json`
- `sandboxes/...`

Global storage:

- `memory/global.json`

## Chat Model

Each chat persists:

- `id`
- `title`
- `createdAt`
- `updatedAt`
- `pinned`
- `archived`
- `lastModel`

Each message persists:

- `id`
- `chatId`
- `role`
- `content`
- `createdAt`

The extension always reloads the active chat from disk when rebuilding UI state.

## Rolling Summaries

When a chat grows beyond the configured threshold:

- older messages are summarized
- recent raw turns stay verbatim
- open tasks and key facts are preserved
- the summary is written back to disk

Defaults:

- `memory.maxRecentMessages = 12`
- `memory.compactionThresholdMessages = 12`

## Memory Scopes

### Global memory

Stores durable user-level preferences, such as:

- preferred language
- coding style
- long-lived constraints

### Workspace memory

Stores repo-specific facts, such as:

- architecture notes
- file conventions
- project decisions

The configured scope is controlled by `hfaicode.memory.scope`.

## Context Assembly Order

The prompt builder composes context in this order:

1. system prompt
2. global instructions
3. workspace instructions
4. repository instructions from `AGENTS.md` when present
5. chat-specific instructions
6. workspace action instructions
7. relevant global memory
8. relevant workspace memory
9. rolling chat summary
10. recent raw chat turns
11. active editor context when `File context` is enabled
12. retrieved workspace snippets
13. current user request

This keeps the live prompt bounded while preserving durable history on disk.

## Retrieval Pipeline

### Indexing

The workspace index:

- ignores large binary or excluded files
- chunks text files into overlapping segments
- stores lexical keywords
- stores embeddings when available

Defaults:

- chunk size: `1200` chars
- overlap: `200` chars
- top-k: `8`

### Lexical ranking

The first pass scores:

- token overlap with the query
- filename/path matches
- open-file bonus

### Semantic reranking

When enabled:

- chunk embeddings are created via Hugging Face feature extraction
- the query embedding is computed
- cosine similarity reranks lexical candidates
- results fall back to lexical-only if embedding calls fail

### Output budget

Only the highest-ranked snippets are injected into the prompt, capped by a character budget.

## Persistence And Rebuild

RAG state persists in `rag/index.json`.

The index rebuilds:

- on initialization
- when watched workspace files change
- when forced by the testing API

If the index is stale or empty:

- the extension schedules a rebuild
- retrieval returns a safe degraded result instead of crashing the chat flow

## Why This Prevents “Forgetting”

The assistant does not rely on a single growing in-memory transcript.

It keeps:

- full history on disk
- compacted historical summaries
- durable memory notes
- retrieved project context
- live recent turns

This combination is what gives the extension practical continuity across long sessions and restarts.

## MemoryDB — Structured Memory Layer

In addition to the file-based storage above, the extension uses `MemoryDB` — a **local JSON file** (`memory.json`) organized in 10 structured tables. This is NOT an external database.

### Why Both Systems Exist

| Concern | File-Based (PersistentState) | MemoryDB |
|---|---|---|
| **Source of truth** | ✅ Primary | Secondary (dual-write) |
| **Format** | Multiple JSON/JSONL files | Single JSON file, 10 tables |
| **Query capability** | Read entire file | Namespace filters, TTL, tags |
| **Data types** | Chats, messages, tasks, patches, memory | Events, patterns, agent state, metrics, workflows |
| **Backward compat** | Full — existing code unchanged | Additive — new code can query MemoryDB |

### Dual-Write Bridge

When `RuntimeFeatureStore` writes data, it automatically mirrors to MemoryDB:

```text
RuntimeFeatureStore                          MemoryDB (memory.json)
─────────────────                          ─────────────────────────
appendEvent()     ──── dual-write ────→    events table
saveOnboarding()  ──── dual-write ────→    memory_store (ns: onboarding)
saveAgent()       ──── dual-write ────→    agent_memory table
recordUsage()     ──── dual-write ────→    performance_metrics table
```

All dual-writes are **best-effort** (wrapped in try/catch). If MemoryDB fails, the primary JSON files remain intact.

### MemoryDB Tables

| Table | Records | Purpose |
|---|---|---|
| `memory_store` | KV pairs with namespaces | General structured data |
| `sessions` | Active sessions | Session tracking |
| `agents` | Agent registry | Agent configurations |
| `tasks` | Task tracking | Task status |
| `agent_memory` | Per-agent data | Private agent state |
| `shared_state` | Cross-agent data | Coordination state |
| `events` | Capped at 5000 | Event journal |
| `patterns` | Learned patterns | Error handling, performance |
| `performance_metrics` | Capped at 10000 | LLM usage, timing |
| `workflow_state` | SPARC state | Workflow checkpoints |

### Storage Location

```
<VS Code globalStorageUri>/memory.json    ← Single local file
```

## VectorDB — Semantic Search Layer

The `VectorDB` (`lib/vectorDB.js`) provides local vector search capabilities alongside the existing RAG pipeline.

### Search Modes

| Mode | Algorithm | Use Case |
|---|---|---|
| **Cosine** | Cosine similarity on embeddings | Pure semantic search |
| **BM25** | TF-IDF style lexical ranking | Keyword-based search |
| **Hybrid** | RRF fusion of cosine + BM25 | Best of both worlds |

### Storage

```
<VS Code globalStorageUri>/vectordb.json    ← Single local file
```

### Relationship to RAG

The existing RAG pipeline (`rag/index.json`) handles workspace file indexing and retrieval. VectorDB provides an additional search layer for agent memory, patterns, and cross-session data.

## Complete Storage Map

All persistence is 100% local — **no external databases, no cloud storage, no network calls for data**.

```text
Workspace Storage (per project)
├── chats/
│   ├── index.json              ← Chat list
│   ├── messages/<chatId>.jsonl ← Chat messages
│   └── summaries/<chatId>.json ← Rolling summaries
├── tasks/
│   ├── index.json              ← Task list
│   └── <taskId>.json           ← Task state + checkpoints
├── patches/
│   ├── index.json              ← Patch list
│   └── <patchId>.json          ← Patch artifacts
├── memory/
│   └── workspace.json          ← Workspace-scoped notes
├── rag/
│   └── index.json              ← Workspace file index
├── agent-runtime/
│   ├── agents/                 ← Agent records
│   ├── teams/                  ← Team records
│   ├── questions/              ← Q&A suspension records
│   ├── events.json             ← Runtime events
│   ├── hooks.json              ← Lifecycle hooks
│   ├── costs.json              ← LLM usage tracking
│   ├── onboarding.json         ← Project conventions
│   ├── mcp-profiles.json       ← MCP-like catalogs
│   ├── mcp-connections.json    ← MCP connections
│   └── logs/
│       ├── runtime.log         ← Append-only runtime log
│       └── audit.log           ← Append-only audit log
└── sandboxes/                  ← Docker sandbox data

Global Storage (per user)
├── memory/global.json          ← Global memory notes
├── memory.json                 ← MemoryDB (10 tables)
└── vectordb.json               ← Vector search index

RAM Only (lost on restart)
├── LearningEngine trajectories
├── ProviderRouter health state
├── MutationGuard audit log
└── AIDefence state
```

The only network calls the extension makes are **LLM API requests** (HuggingFace, Ollama, etc.) for chat completions and embeddings.

