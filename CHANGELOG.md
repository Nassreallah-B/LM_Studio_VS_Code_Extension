# Changelog

## Unreleased

### UI And Runtime Polish
- Redesigned the chat composer to a cleaner ChatGPT/Codex-style layout with a larger text area, compact pill controls, cleaner spacing, and improved mobile behavior.
- Enabled automatic web-first behavior for time-sensitive requests through agent prompt guidance, without adding a visible web toggle to the UI.
- Added `localai.agent.preferWebForFreshInfo` with a default of `true`.
- Tightened system prompt guidance and tool-playbook rules so the agent grounds itself first, validates after edits, and escalates to workflows or subagents for broader work.
- Improved perceived responsiveness with clearer progress updates during context building, sandbox preparation, rounds, tools, and patch creation.
- Reduced patch friction by surfacing better patch summaries, live task progress text, and explicit chat messages when patches are applied or rejected.
- Rebuilt the installable VSIX and resynced installed copies for VS Code and Antigravity.
- Documented the full April 4, 2026 worklog in [docs/WORKLOG_2026-04-04.md](/c:/Serveurs/localai-code-1.0.0/docs/WORKLOG_2026-04-04.md).

### Advanced Agent Runtime
- Added named subagents with spawn, send-message, wait, stop, resume, and fork flows.
- Added team orchestration with `team-lead`, `worker`, and `verification` roles.
- Added runtime hooks, onboarding memory, event logs, audit logs, and cost tracking.
- Added MCP-like profiles, connections, resources, and tool catalogs.
- Added question/resume task suspension and chat forking.
- Added cloud task output, update, message, and resume endpoints.

### Packaging and Marketplace
- Added publication hardening for packaging and secrets hygiene.
- Added `LICENSE`.
- Cleaned README packaging issues so `vsce package` now completes.
- Remaining metadata step:
  - repository URL for `localai-code-1.0.0`
  - homepage URL for `localai-code-1.0.0`
  - bugs/issues URL for `localai-code-1.0.0`
- As soon as the real repository URL is available, add `repository`, `homepage`, and `bugs` to `package.json`, then rerun packaging to confirm zero warnings.
