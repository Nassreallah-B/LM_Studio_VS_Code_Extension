# Cloud Executor

The cloud executor is the remote background-task runtime implemented in `cloud-executor/server.js`.

## What It Does

- accepts workspace snapshots from the extension
- creates one sandbox per task
- runs autonomous agent rounds remotely
- checkpoints after tool execution
- persists task and patch records on disk
- resumes unfinished work after executor restart

## API

### `GET /health`

Reports:

- executor mode
- number of tasks
- number of running tasks
- data root
- configured LM Studio base URLs
- sandbox health

### `GET /tasks`

Returns all tasks persisted on the executor.

### `GET /tasks/:id`

Returns one task including:

- logs
- checkpoint
- patch data
- sandbox metadata

### `POST /tasks`

Creates a remote task from:

- title
- prompt
- workspace snapshot files
- prepared messages
- model id
- LM Studio base URLs
- sandbox configuration

### `POST /tasks/:id/stop`

Requests task interruption.

## Environment Variables

- `PORT`
- `CLOUD_EXECUTOR_DATA_DIR`
- `CLOUD_EXECUTOR_API_KEY`
- `CLOUD_EXECUTOR_MAX_ROUNDS`
- `CLOUD_EXECUTOR_SHELL_TIMEOUT_MS`
- `CLOUD_EXECUTOR_MAX_CONCURRENT_TASKS`
- `CLOUD_EXECUTOR_SANDBOX_IMAGE`
- `CLOUD_EXECUTOR_SANDBOX_NETWORK`
- `CLOUD_EXECUTOR_SANDBOX_TOOL_TIMEOUT_MS`
- `LOCALAI_BASE_URL`
- `LOCALAI_NATIVE_BASE_URL`
- `LOCALAI_MODEL_ID`

## LM Studio Routing

The executor talks to LM Studio through:

- `lmStudio.baseUrl` from the task payload when provided
- otherwise `LOCALAI_BASE_URL`

For native endpoints it uses:

- `lmStudio.nativeBaseUrl` from the task payload when provided
- otherwise `LOCALAI_NATIVE_BASE_URL`

## Sandbox Behavior

Each remote task:

- receives a copied workspace snapshot
- runs tools inside Docker
- does not write straight into the real host workspace
- produces a patch artifact at completion

## Resume Semantics

On startup the executor:

- reloads persisted tasks
- marks interrupted work as `resuming` or `interrupted`
- reattaches sandboxes
- continues from the latest checkpoint

## Smoke Test

Available script:

```powershell
npm run test:cloud-smoke
```

For full remote execution:

- Docker must be available
- LM Studio must be reachable through the configured base URL
