# Testing

## Runtime vNext checks

Current validation performed after the advanced runtime changes:

- `node -c extension.js`
- `node -c cloud-executor/server.js`
- `node -c lib/runtimeFeatures.js`

Cloud API additions to smoke manually:

- `GET /tasks/:id/output`
- `PATCH /tasks/:id`
- `POST /tasks/:id/messages`
- `POST /tasks/:id/resume`

## Local Static Validation

These checks should pass after code changes:

```powershell
node -c extension.js
node -c cloud-executor/server.js
node -c lib/dockerSandbox.js
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('package ok')"
```

The embedded webview script can also be syntax-checked by extracting the `<script>` block from `media/chat.html`.

## Live LM Studio Checks

Useful direct checks:

- model discovery through `/v1/models`
- chat completion through `/v1/chat/completions`
- embedding call through `/v1/embeddings`

Requirements:

- LM Studio local server running
- at least one chat model loaded
- one embedding-capable model loaded for semantic RAG

## Extension Live Test

Script:

```powershell
npm run test:vscode-live
```

This test exercises:

- extension activation
- connection check
- RAG rebuild
- semantic retrieval
- prompt send
- multi-chat persistence
- background task flow

Optional environment:

- `LOCALAI_BASE_URL`
- `LOCALAI_NATIVE_BASE_URL`
- `LOCALAI_MODEL_ID`
- `LOCALAI_EMBEDDING_MODEL`

## Cloud Executor Smoke Test

Script:

```powershell
npm run test:cloud-smoke
```

This validates:

- executor startup
- `/health`
- remote task creation
- remote agent completion

Requirements for the full path:

- Docker available
- LM Studio reachable through the configured base URL

## Manual Resume Validation

1. start a long-running background task
2. close VS Code or stop the cloud executor while it is running
3. restart the runtime
4. confirm the task returns as `resuming` or `interrupted`
5. confirm execution continues from the last checkpoint
