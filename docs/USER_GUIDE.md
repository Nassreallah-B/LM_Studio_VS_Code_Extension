# User Guide

## Advanced runtime

The chat can now drive:

- named subagents
- team orchestration
- runtime todo lists
- hooks and policies
- onboarding memory updates
- MCP-like resource catalogs
- question / answer suspension and resume
- chat forks

Practical behavior:

- if an agent asks a question, the task pauses and the next user reply resumes it
- background or spawned agents persist as normal tasks and retain their own state
- forked chats keep the current transcript, summary, and chat instructions
- advanced runtime state is visible in storage under `agent-runtime/`

See [docs/ADVANCED_AGENT_RUNTIME.md](/c:/Serveurs/localai-code-1.0.0/docs/ADVANCED_AGENT_RUNTIME.md) for the runtime model and [docs/SCHEMAS_AND_PROTOCOLS.md](/c:/Serveurs/localai-code-1.0.0/docs/SCHEMAS_AND_PROTOCOLS.md) for persisted records and cloud endpoints.

## Sidebar Layout

The sidebar is split into:

- chat list
- active conversation
- task status
- patch review
- workspace status
- instructions

## Toolbar Buttons

### `Explain`

Sends a request to explain the current selection or file. If `File context` is enabled, the current editor selection or file content is included.

### `Fix`

Requests a correction pass. In agent mode, the assistant can inspect files, run tools in the sandbox, and return a reviewed patch.

### `Refactor`

Requests a structural improvement while preserving behavior.

### `Tests`

Requests test generation. In agent mode this can include sandboxed file creation and shell-driven validation.

### `Optimize`

Requests a performance or efficiency pass.

### `Docs`

Requests comments, docs, or explanation-oriented edits.

### `New`

Creates a new persistent chat. It does not delete old conversations.

## Toggles

### `File context`

When enabled:

- the current editor selection is preferred
- otherwise the current file is attached
- the prompt builder injects that editor context before the current user message

### `Background`

When enabled:

- the request becomes a background task
- the task gets its own persisted task record
- progress appears in the task card list
- the final answer is delivered back into the chat

## Connection Setup

The disconnect card lets you:

- save `localai.baseUrl`
- save `localai.modelId`
- retry connection checks

Expected default server:

- `http://localhost:1234/v1`

## Instructions

The `Instructions` card lets you edit three instruction layers:

- `Chat`: applies only to the current conversation
- `Workspace`: applies to the current project
- `Global`: applies across all workspaces

Recommended usage:

- put stable output preferences and style rules in `Global`
- put repo conventions and architecture constraints in `Workspace`
- put one-off task constraints in `Chat`

These layers are injected into the system prompt before memory, summary, and retrieval context. Repository-level `AGENTS.md` is also included when present.

## Commands

- `localai.openChat`
- `localai.newChat`
- `localai.explainCode`
- `localai.fixCode`
- `localai.refactorCode`
- `localai.generateTests`
- `localai.addComments`
- `localai.optimizeCode`
- `localai.generateCode`
- `localai.askAboutSelection`
- `localai.selectModel`
- `localai.checkConnection`
- `localai.reviewDiff`
- `localai.acceptDiff`
- `localai.rejectDiff`

## Recommended Setup

1. Start LM Studio.
2. Load a chat model.
3. Start the local server.
4. Add stable preferences in `localai.instructions.global` or from the `Instructions` card.
5. Add repo-specific rules in `localai.instructions.workspace`.
6. Keep `localai.modelId = auto` unless you need a fixed model.
7. Load an embedding-capable model if you want semantic RAG.
8. Start Docker Desktop before using agent tools or background tasks.

## Troubleshooting

### “Disconnected”

Check:

- LM Studio is running
- the local server is started
- `localai.baseUrl` points to the correct host and port
- at least one model is loaded

### Semantic RAG is not used

Check:

- `localai.rag.mode` is not `lexical-only`
- an embedding-capable model is loaded
- `localai.rag.embeddingModel` points to the correct model or is `auto`

### Agent requests fail immediately

Check:

- Docker Desktop is running
- the Linux engine is healthy
- the sandbox image can be built from `sandbox/Dockerfile`
- `localai.sandbox.runtimeRequired` is not blocking due to missing Docker

### Patch exists but nothing changed in the workspace

That is expected until `Accept` is used.
