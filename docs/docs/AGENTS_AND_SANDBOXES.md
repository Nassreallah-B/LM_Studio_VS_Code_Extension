# Agents And Sandboxes

This document describes the runtime components that make HF AI Code behave like an agentic coding system instead of a simple chat panel.

The advanced subagent, team, hooks, onboarding, MCP-like catalog, event, and cost layer is documented separately in [docs/ADVANCED_AGENT_RUNTIME.md](/c:/Serveurs/hf-ai-code/docs/ADVANCED_AGENT_RUNTIME.md).

## Runtime Roles

### Foreground agent

- created when the user sends a normal chat message while `hfaicode.agent.enabled = true`
- uses the active chat as the parent conversation
- runs multiple model/tool rounds
- streams progress back into the sidebar
- produces a pending patch instead of applying host edits directly

### Background local agent

- created when `Background` is enabled in the UI
- owns its own task record and checkpoint state
- runs in the same extension host process
- still executes every workspace tool in a sandbox
- survives VS Code restarts through persisted task state

### Background remote agent

- created when cloud execution is enabled and a cloud executor is configured
- runs through `cloud-executor/server.js`
- receives a workspace snapshot instead of a live host mount
- persists rounds, checkpoints, patch state, and logs on the executor host
- resumes after executor restart

### Sandbox supervisor

- owns Docker health checks and image readiness
- creates or reattaches sandbox containers
- copies workspace content into the sandbox root
- executes tool calls with timeouts
- records git checkpoints inside the sandbox workspace
- exports the final patch/diff artifact

### Patch reviewer

- stores pending patch metadata in `patches/`
- exposes review, accept, and reject actions
- applies host edits only after explicit approval
- marks patch state back into the task and UI snapshots

## Tool Execution Model

The model does not call VS Code APIs directly. It emits tool tags:

```xml
<hfai-tool name="read_file">{"path":"src/index.js"}</hfai-tool>
```

Supported autonomous tools:

- `list_files`
- `read_file`
- `search_text`
- `write_file`
- `delete_path`
- `run_shell`
- `git_status`
- `git_diff`
- `list_tasks`
- `get_task`
- `stop_task`
- `spawn_task`

Additional local runtime tools now include subagents, teams, hooks, MCP-like resources, onboarding, events, web tools, LSP tools, user-question pause/resume, and chat/task forks. See [docs/ADVANCED_AGENT_RUNTIME.md](/c:/Serveurs/hf-ai-code/docs/ADVANCED_AGENT_RUNTIME.md).

`write_file` and `delete_path` modify only the sandbox workspace until a patch is reviewed and accepted.

## Sandbox Guarantees

### What is isolated

- file reads and writes
- shell commands
- git status and diff
- task workspaces

### What is not inside the container

- Hugging Face API calls
- the prompt builder
- the conversation store
- the patch review UI

The orchestrator runs outside the container and calls the model directly. Only workspace tooling runs inside Docker.

## Sandbox Lifecycle

1. The agent request starts.
2. A sandbox is created or reattached.
3. The workspace is copied into the sandbox root.
4. The model emits tool tags.
5. Tool calls execute inside the sandbox.
6. After each tool batch, a sandbox git checkpoint is committed.
7. When the agent finishes, the sandbox diff is exported as a patch artifact.
8. The host workspace changes only if the user accepts that patch.

## Resume Model

Checkpointed task state includes:

- current round
- conversation at the checkpoint
- pending tool calls
- next tool index
- tool result blocks
- sandbox git ref
- sandbox metadata

If VS Code or the executor restarts while a task is running:

- the task is marked `resuming` or `interrupted`
- the sandbox is reattached
- the previous git ref is restored when needed
- execution continues from the last safe checkpoint

## Patch Review

A patch record includes:

- patch id
- source task or chat
- sandbox id
- file list
- summaries
- artifact paths
- created/updated timestamps

The UI exposes:

- patch summary card
- per-patch review button
- accept button
- reject button

`Accept` applies the patch to the real workspace.

`Reject` preserves history but drops the pending patch from the apply queue.

## Docker Prerequisites

The current implementation assumes:

- Docker Desktop is installed
- the Linux engine is reachable
- WSL2 is available on Windows

When `hfaicode.sandbox.runtimeRequired = true`, missing Docker is treated as a hard blocker for agent tool execution.

## Security Notes

- model secrets are not injected into the sandbox container
- the default sandbox network mode is `none`
- the real workspace is not mounted read-write for autonomous execution
- patch review is the boundary between sandbox work and host mutation
