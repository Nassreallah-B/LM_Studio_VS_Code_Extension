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

See [docs/ADVANCED_AGENT_RUNTIME.md](/c:/Serveurs/hf-ai-code/docs/ADVANCED_AGENT_RUNTIME.md) for the runtime model and [docs/SCHEMAS_AND_PROTOCOLS.md](/c:/Serveurs/hf-ai-code/docs/SCHEMAS_AND_PROTOCOLS.md) for persisted records and cloud endpoints.

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

When disabled:

- only the typed chat message is sent

### `Background`

When enabled:

- the request becomes a background task
- the task gets its own persisted task record
- progress appears in the task card list
- the final answer is delivered back into the chat

## Chat Management

Each chat card supports:

- select
- rename
- pin
- delete

Pinned chats stay at the top of the list. The active chat is restored after reload.

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

## Patch Review

When an agent edits files, the changes appear as a pending patch.

Available actions:

- `Review`: opens the patch artifact for inspection
- `Accept`: applies the patch to the real workspace
- `Reject`: discards the patch from the apply queue

Agent edits are not written directly into the host workspace before review.

## Commands

Main commands:

- `hfaicode.openChat`
- `hfaicode.newChat`
- `hfaicode.explainCode`
- `hfaicode.fixCode`
- `hfaicode.refactorCode`
- `hfaicode.generateTests`
- `hfaicode.addComments`
- `hfaicode.optimizeCode`
- `hfaicode.generateCode`
- `hfaicode.askAboutSelection`
- `hfaicode.selectModel`
- `hfaicode.checkConnection`
- `hfaicode.setToken`
- `hfaicode.reviewDiff`
- `hfaicode.acceptDiff`
- `hfaicode.rejectDiff`

## Recommended Setup

1. Set `hfaicode.apiToken`.
2. Pick a router-compatible chat model in `hfaicode.modelId`.
3. Add stable preferences in `hfaicode.instructions.global` or from the `Instructions` card.
4. Add repo-specific rules in `hfaicode.instructions.workspace`.
5. Leave memory and RAG enabled.
6. Keep sandbox runtime required if you want strict agent isolation.
7. Start Docker Desktop before using agent tools or background tasks.

## Troubleshooting

### “Disconnected”

Check:

- the HF token exists
- the token has `Make calls to Inference Providers`
- the selected model is exposed through `router.huggingface.co/v1/models`

### Agent requests fail immediately

Check:

- Docker Desktop is running
- the Linux engine is healthy
- the sandbox image can be built from `sandbox/Dockerfile`
- `hfaicode.sandbox.runtimeRequired` is not blocking due to missing Docker

### Background tasks do not resume

Check:

- local VS Code storage is writable
- the task was not manually stopped
- the cloud executor, if used, was restarted with the same data directory

### Semantic RAG is not used

Check:

- `hfaicode.rag.mode` is not `lexical-only`
- the embedding model is valid
- the HF token can call feature extraction

### Patch exists but nothing changed in the workspace

That is expected until `Accept` is used.

## What “agent mode” means here

When enabled, the assistant can:

- inspect workspace files
- search the repo
- write files in the sandbox
- delete paths in the sandbox
- run shell commands in the sandbox
- create background tasks

What it cannot do automatically:

- bypass patch review and silently mutate the host workspace
