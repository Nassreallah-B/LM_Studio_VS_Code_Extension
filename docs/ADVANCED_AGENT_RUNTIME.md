# Advanced Agent Runtime

This document describes the runtime features added on top of the existing chat, memory, RAG, sandbox, and background task stack.

## Scope

The runtime now includes:

- named subagents
- agent messaging and resume
- team orchestration
- runtime hooks and policies
- MCP-like profile and resource catalogs
- lightweight web tools
- project onboarding memory
- cost and event tracking
- question / answer suspension
- chat forks and task branches

The implementation is local-first. Durable runtime state is stored as versioned JSON plus JSONL logs in VS Code extension storage.

## Built-In Agent Types

- `aria-orchestrator`: lead architect and event router (Step budget: 50)
- `rtl-ui-auditor`: specialist for Arabic/RTL, Tailwind, and Premium UX (Step budget: 30)
- `database-expert`: specialist for PostgreSQL, Supabase, and RLS (Step budget: 35)
- `security-sentinel`: permanent security guardian with verdict behavior (Step budget: 30)
- `refactoring-expert`: specialist for technical debt and Clean Code (Step budget: 80)
- `performance-monitor`: guardian of Core Web Vitals and error tracking (Step budget: 30)
- `onboarding-expert`: guardian of project conventions and standards
- `general-purpose`: default execution agent
- `Explore`: read-only code explorer
- `Plan`: read-only planning agent
- `verification`: read-only verifier with explicit verdict behavior
- `worker`: bounded execution agent
- `team-lead`: orchestration-only agent
- `fork`: branch agent inheriting parent context
- `guide`: documentation and usage guidance agent

Each type applies behavioral rules before tool execution:

- read-only agents cannot use file-write tools
- no-shell agents cannot execute shell commands
- no-spawn agents cannot create more agents
- orchestration-only agents should delegate instead of editing files directly

## Agent Lifecycle

1. A parent chat or task emits `spawn_agent`.
2. The runtime creates an agent record under `agent-runtime/agents/`.
3. A linked task is created and receives an agent-specific system prompt.
4. The task executes through the normal local or remote task manager.
5. Agent state is synchronized from the linked task status.
6. The agent can receive follow-up messages through `send_message`.
7. The agent can be stopped, resumed, waited on, or forked.

## Agent Tools

Advanced tools now exposed to the local agent runtime:

- `spawn_agent`
- `send_message`
- `wait_agent`
- `stop_agent`
- `resume_agent`
- `fork_agent`
- `list_agents`
- `get_agent`
- `create_team`
- `list_teams`
- `delete_team`
- `orchestrate_team`
- `task_output`
- `task_update`
- `todo_write`
- `web_fetch`
- `web_search`
- `list_hooks`
- `upsert_hook`
- `delete_hook`
- `list_mcp_profiles`
- `upsert_mcp_profile`
- `activate_mcp_profile`
- `deactivate_mcp_profile`
- `mcp_connect`
- `mcp_disconnect`
- `mcp_list_resources`
- `mcp_read_resource`
- `mcp_list_tools`
- `get_onboarding`
- `update_onboarding`
- `list_events`
- `ask_user_question`
- `lsp_symbols`
- `lsp_definitions`
- `lsp_references`
- `lsp_diagnostics`
- `workflow_run`
- `fork_chat`

## Team Mode

`orchestrate_team` creates:

- one `team-lead`
- zero or more `worker` agents
- an optional `verification` agent

The team record lives under `agent-runtime/teams/` and tracks:

- logical team name
- member list
- team status
- role of each member

This is a lightweight coordinator model, not a hidden black-box swarm.

## Questions And Resume

`ask_user_question` pauses the current task:

- a question record is stored under `agent-runtime/questions/`
- the task status becomes `awaiting_user`
- the chat receives a visible system message
- the next user reply resumes the linked task automatically

Remote cloud tasks also support external messages and explicit resume through task API endpoints.

## Hooks And Policies

Hooks are stored in `agent-runtime/hooks.json`.

Supported phases:

- `pre_prompt`
- `pre_tool`

Current actions:

- `annotate`
- `block`

Hooks can match:

- tool names
- agent types
- task statuses
- path regex patterns

This layer is used in addition to the built-in agent-type restrictions.

## MCP-Like Profiles And Resources

The runtime includes a lightweight MCP-like catalog layer:

- connections
- named profiles
- resources
- prompt catalogs
- tool catalogs

Supported live manifest modes:

- `static`
- `http`
- `http-json`
- `sse`
- `ws`

For HTTP-like transports, the runtime fetches a manifest from the configured URL or `<url>/manifest`.

Stored files:

- `agent-runtime/mcp-connections.json`
- `agent-runtime/mcp-profiles.json`

Important: this is a lightweight catalog/runtime layer, not a full external MCP protocol client with bidirectional tool invocation.

## Cost Tracking

The runtime writes estimated usage to `agent-runtime/costs.json`.

Tracked buckets:

- global totals
- per chat
- per task
- per agent

Tracked metrics:

- call count
- prompt tokens
- completion tokens
- embedding tokens

Token counts are estimated from text length, not provider billing telemetry.

## Events And Audit Logs

Recent events are stored in `agent-runtime/events.json`.

Append-only logs:

- `agent-runtime/logs/runtime.log`
- `agent-runtime/logs/audit.log`

Examples:

- agent spawned / resumed / stopped
- tool called / completed / failed
- hook changes
- MCP connection/profile changes
- onboarding updates

## Project Onboarding

Onboarding lives in `agent-runtime/onboarding.json`.

It stores:

- summary
- conventions
- risky zones
- build/test/lint commands
- important files

The first version is auto-seeded from `package.json` and `README.md` when possible, then can be updated explicitly through tools.

## Branching

Two forms of branching are supported:

- `fork_agent`: creates a branch task from another agent/task
- `fork_chat`: clones the active chat into a new chat branch

Forked chats preserve:

- transcript
- summary
- chat instructions
- parent chat link

## Cloud Task API Additions

The cloud executor now exposes:

- `GET /tasks/:id/output`
- `PATCH /tasks/:id`
- `POST /tasks/:id/messages`
- `POST /tasks/:id/resume`

These endpoints support:

- external messages
- question/resume flows
- linked agent updates
- remote output retrieval
