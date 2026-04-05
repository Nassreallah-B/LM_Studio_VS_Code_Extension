# Implementation History

## Advanced Agent Runtime

Latest expansion:

- added named subagents and agent records
- added agent message, wait, stop, resume, and fork flows
- added team orchestration with `team-lead`, `worker`, and `verification`
- added question/resume suspension for agent tasks
- added hooks and policy records
- added project onboarding state
- added runtime event and audit logs
- added cost tracking buckets
- added MCP-like profile/connection/resource catalogs
- added chat forking and task branch metadata
- added cloud task output, message, update, and resume endpoints

This file summarizes the major changes that moved LocalAI Code from a simple LM Studio chat extension toward a persistent, sandboxed agent runtime.

## 1. Persistent Chat State

- replaced volatile single-session chat state
- added multi-chat persistence
- restored active chats after restart

## 2. Memory And Summaries

- added rolling summaries
- added workspace memory
- added global memory
- moved the prompt builder away from raw-history-only behavior

## 3. Hybrid Retrieval

- added lexical workspace indexing
- added semantic reranking through LM Studio embeddings
- added persistent chunk storage and rebuild logic

## 4. Agent Tasks

- added autonomous multi-round agent execution
- added background task management
- added persisted task logs and checkpoints

## 5. Patch Review

- stopped applying autonomous edits straight to the host workspace
- introduced patch records and artifacts
- added review, accept, and reject flows

## 6. Docker Sandbox Runtime

- moved agent tools into Docker sandboxes
- blocked silent host fallback when the sandbox runtime is required
- added sandbox health reporting to the UI

## 7. Remote Executor Durability

- added cloud executor persistence
- added executor restart recovery
- switched the executor to LM Studio base URLs instead of HF token forwarding

## 8. Documentation Refresh

- rewrote docs around the real architecture
- added agent and sandbox documentation
- updated testing and cloud executor documentation

## 9. Instruction Layers

- added global instructions in settings
- added workspace instructions in settings
- added chat-specific instructions in persistent chat metadata
- surfaced an in-app editor for `Global`, `Workspace`, and `Chat`
- injected instruction layers ahead of memory and retrieval during prompt assembly

## 10. April 4, 2026 Polish Pass

- redesigned the sidebar composer to feel closer to ChatGPT/Codex, with a larger prompt surface and compact controls
- applied the same composer redesign to the Hugging Face and LocalAI variants
- packaged fresh VSIX artifacts after the UI and runtime changes
- reinstalled the packaged extensions in VS Code
- resynced installed copies into `.vscode/extensions` and `.antigravity/extensions`
- made web lookup a default agent behavior for time-sensitive questions such as security advisories, CVEs, dependency versions, release notes, and recent documentation changes
- added a dedicated config switch to keep that behavior explicit and reversible
- kept shell-driven automation enabled for agent execution, with PowerShell on Windows host paths and sandboxed `run_shell` for isolated task work

See the detailed worklog in [docs/WORKLOG_2026-04-04.md](/c:/Serveurs/localai-code-1.0.0/docs/WORKLOG_2026-04-04.md).
