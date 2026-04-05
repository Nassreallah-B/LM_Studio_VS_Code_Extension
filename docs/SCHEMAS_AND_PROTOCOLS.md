# Schemas And Protocols

This document lists the durable records, webview messages, agent tags, and remote executor payloads used by LocalAI Code.

## Persistent Records

Additional runtime records introduced by the advanced agent layer are documented in [docs/ADVANCED_AGENT_RUNTIME.md](/c:/Serveurs/localai-code-1.0.0/docs/ADVANCED_AGENT_RUNTIME.md). These include agent records, team records, question records, hooks, onboarding state, cost state, MCP-like profiles/connections, recent events, and runtime/audit logs.

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
  "containerImage": "localai-code-sandbox:latest"
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
  ]
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
- baseUrl
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
- `saveBaseUrl`
- `saveModel`
- `applyCode`
- `copyCode`
- `createFile`

## Agent Tags

### Tool tag

```xml
<localai-tool name="search_text">{"pattern":"createServer","path":"src"}</localai-tool>
```

### Workspace action tags

```xml
<localai-write path="src/new-file.js">
export const ok = true;
</localai-write>
<localai-delete path="src/old-file.js" />
<localai-open path="src/new-file.js" />
```

## Cloud Executor API

### `GET /health`

Returns:

- executor mode
- task counts
- data root
- sandbox health
- configured LM Studio base URLs

### `POST /tasks`

Request example:

```json
{
  "title": "Remote patch",
  "prompt": "Fix the failing API tests",
  "workspaceName": "repo-name",
  "files": [],
  "messages": [],
  "modelId": "auto",
  "lmStudio": {
    "baseUrl": "http://127.0.0.1:1234/v1",
    "nativeBaseUrl": "http://127.0.0.1:1234"
  },
  "sandbox": {
    "enabled": true,
    "runtimeRequired": true,
    "image": "localai-code-sandbox:latest",
    "networkMode": "none"
  }
}
```

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
