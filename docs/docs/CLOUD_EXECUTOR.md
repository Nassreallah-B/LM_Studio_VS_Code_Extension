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
- server token availability
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
- sandbox configuration

### `POST /tasks/:id/stop`

Requests task interruption.

## Persistence

Executor storage root:

- `tasks/index.json`
- `tasks/<taskId>.json`
- `sandboxes/...`

Durability depends on the executor reusing the same data directory across restarts.

## Server-Side Token Mode

Production default:

- set `HF_API_TOKEN` on the executor host

Why:

- remote tasks can continue after executor restart
- the executor does not depend on the extension to re-forward a token
- restart recovery is simpler and more reliable

Optional dev fallback:

- `hfaicode.cloud.forwardApiToken = true`

That mode is intended only for trusted development environments.

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
- `HF_API_TOKEN`
- `HF_MODEL_ID`

## Sandbox Behavior

Each remote task:

- receives a copied workspace snapshot
- runs tools inside Docker
- does not write straight into the real host workspace
- produces a patch artifact at completion

Completed tasks:

- stop or destroy the sandbox according to retention settings

Failed tasks:

- retain sandbox state when configured for postmortem review

## Resume Semantics

On startup the executor:

- reloads persisted tasks
- marks interrupted work as `resuming` or `interrupted`
- reattaches sandboxes
- continues from the latest checkpoint

This applies to both model-round checkpoints and tool-execution checkpoints.

## Smoke Test

Available script:

```powershell
npm run test:cloud-smoke
```

For full remote execution, Docker must be available and `HF_API_TOKEN` should be configured. If no token is available, the smoke script can still validate basic executor startup and health behavior.
