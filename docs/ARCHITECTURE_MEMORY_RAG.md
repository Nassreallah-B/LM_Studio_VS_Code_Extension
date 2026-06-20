# Architecture: Memory, Context, And RAG

LocalAI Code keeps durable state on disk and reconstructs the active prompt from structured sources instead of replaying the entire raw transcript every time.

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

The configured scope is controlled by `localai.memory.scope`.

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

- chunk embeddings are created through LM Studio `/v1/embeddings`
- the query embedding is computed
- cosine similarity reranks lexical candidates
- results fall back to lexical-only if no embedding model is loaded or the embedding call fails

## Why This Prevents “Forgetting”

The assistant does not rely on a single growing in-memory transcript.

It keeps:

- full history on disk
- compacted historical summaries
- durable memory notes
- retrieved project context
- live recent turns
