# Schemas And Protocols

This document lists the durable records, webview messages, agent tags, and remote executor payloads used by HF AI Code.

## Persistent Records

Additional runtime records introduced by the advanced agent layer are documented in [docs/ADVANCED_AGENT_RUNTIME.md](/c:/Serveurs/hf-ai-code/docs/ADVANCED_AGENT_RUNTIME.md). These include agent records, team records, question records, hooks, onboarding state, cost state, MCP-like profiles/connections, recent events, and runtime/audit logs.

### Chat summary record

```json
{
  "chatId": "chat_123",
  "rollingSummary": "Previous discussion summary...",
  "openTasks": [
    "Investigate failing tests"
  ],
  "importantFacts": [
    "Project uses Express and TypeScript"
  ],
  "lastCompactedMessageId": "msg_456",
  "updatedAt": "2026-04-03T10:00:00.000Z"
}
```

### Memory note

```json
{
  "id": "mem_123",
  "scope": "workspace",
  "kind": "constraint",
  "content": "Use ESM modules in this repo.",
  "sourceChatId": "chat_123",
  "createdAt": "2026-04-03T10:00:00.000Z"
}
```

### Task record

```json
{
  "id": "task_123",
  "title": "Fix failing API tests",
  "status": "running",
  "runtimeKind": "local",
  "agentId": "agent_123",
  "agentType": "worker",
  "teamName": "auth-squad",
  "chatId": "chat_123",
  "rounds": 2,
  "sandboxId": "sandbox_123",
  "sandboxState": "ready",
  "awaitingQuestionId": "",
  "checkpointAt": "2026-04-03T10:05:00.000Z",
  "resumeCount": 1,
  "patchId": "patch_123",
  "patchSummary": "3 files changed",
  "containerImage": "hf-ai-code-sandbox:latest"
}
```

### Task checkpoint

```json
{
  "phase": "executing_tools",
  "round": 2,
  "conversation": [],
  "pendingToolCalls": [],
  "nextToolIndex": 1,
  "toolResultBlocks": [],
  "gitRef": "abc123"
}
```

### Patch record

```json
{
  "id": "patch_123",
  "taskId": "task_123",
  "chatId": "chat_123",
  "sandboxId": "sandbox_123",
  "source": "sandbox",
  "summary": "3 files changed",
  "status": "pending",
  "files": [
    {
      "path": "src/index.js",
      "changeType": "modified"
    }
  ],
  "artifactPaths": {
    "diff": "patches/artifacts/patch_123.diff"
  }
}
```

### RAG chunk record

```json
{
  "id": "src/index.js:0:abcdef123456",
  "path": "src/index.js",
  "hash": "abcdef...",
  "mtimeMs": 1712139000000,
  "language": "javascript",
  "start": 0,
  "end": 1200,
  "text": "chunk text",
  "keywords": [
    "createServer",
    "src/index.js"
  ],
  "embedding": [0.01, 0.02]
}
```

## Webview Messages

### Extension to webview

- `state`
- `status`
- `checking`
- `userMsg`
- `thinking`
- `chunk`
- `done`
- `error`
- `systemMsg`

`state` includes:

- chats
- activeChatId
- messages
- summary
- tasks
- patches
- contextMeta
- ragStatus
- sandboxStatus
- memoryStatus
- instructionStatus
- connected
- model
- detail

### Webview to extension

- `ready`
- `send`
- `newChat`
- `selectChat`
- `renameChat`
- `deleteChat`
- `togglePin`
- `stopTask`
- `reviewPatch`
- `acceptPatch`
- `rejectPatch`
- `saveInstructions`
- `selectModel`
- `checkConnection`
- `saveToken`
- `saveModel`
- `applyCode`
- `copyCode`
- `createFile`

## Agent Tags

### Tool tag

```xml
<hfai-tool name="search_text">{"pattern":"createServer","path":"src"}</hfai-tool>
```

### Workspace action tags

```xml
<hfai-write path="src/new-file.js">
export const ok = true;
</hfai-write>
<hfai-delete path="src/old-file.js" />
<hfai-open path="src/new-file.js" />
```

Autonomous tasks prefer tool tags. Non-agent chat responses may still use workspace action tags, which are converted into reviewed patches.

## Cloud Executor API

### `GET /health`

Returns:

- executor mode
- task counts
- data root
- sandbox health
- whether `HF_API_TOKEN` is configured server-side

### `GET /tasks`

Returns the full persisted task list.

### `GET /tasks/:id`

Returns one task with logs, checkpoint, patch state, and sandbox metadata.

### `POST /tasks`

Request example:

```json
{
  "title": "Remote patch",
  "prompt": "Fix the failing API tests",
  "workspaceName": "repo-name",
  "files": [
    {
      "path": "src/index.js",
      "content": "..."
    }
  ],
  "messages": [],
  "modelId": "Qwen/Qwen3.5-397B-A17B:fastest",
  "sandbox": {
    "enabled": true,
    "runtimeRequired": true,
    "image": "hf-ai-code-sandbox:latest",
    "networkMode": "none"
  }
}
```

### `POST /tasks/:id/stop`

Requests task shutdown. Running tasks are marked stopped at the next safe point.

### `GET /tasks/:id/output`

Returns task output, logs, messages, and patch metadata.

### `PATCH /tasks/:id`

Updates task metadata such as title, labels, or other mutable fields.

### `POST /tasks/:id/messages`

Queues an external message into a running or paused remote task.

### `POST /tasks/:id/resume`

Marks a paused or interrupted remote task as resumable and schedules it again.

## Status Values

Task status values:

- `pending`
- `running`
- `resuming`
- `interrupted`
- `awaiting_user`
- `completed`
- `failed`
- `stopped`

Patch status values:

- `pending`
- `accepted`
- `rejected`

Sandbox status values commonly exposed to the UI:

- `ready`
- `resuming`
- `completed`
- `failed`
- `interrupted`
