# TODO

## Priority 1
- Add secure provider secret handling parity with the HF extension using VS Code `SecretStorage` where sensitive provider credentials are involved.
  Why: LocalAI usually relies on local endpoints rather than a token, but the extension should still have a secure path for any future secret-bearing configuration.
- Add automatic cleanup for live test temp folders created by the VS Code live test runner.
  Why: temporary workspaces, user-data directories, extension directories, and logs should not remain after the run unless explicitly requested.
- Add CI automation for the existing checks.
  Why: local scripts exist, but there is no GitHub Actions workflow enforcing them on every change.

## Priority 2
- Strengthen anti-hallucination from heuristic post-validation to claim-by-claim validation.
  Current state: `lib/antiHallucination.js` validates structure and evidence markers heuristically, but does not fully prove each factual claim against the code or runtime evidence.
- Add unit tests for `lib/antiHallucination.js`.
  Focus areas:
  - false positives
  - false negatives
  - strict audit formatting
  - security response validation
  - documentation-vs-implementation confusion
- Expand non-regression coverage for:
  - patch review / apply / reject
  - Docker auto-start and fallback to direct chat
  - task orchestration and subagent flows
  - persistence of response metadata in the UI

## Priority 3
- Replace the current activity-bar icon with a dedicated simplified asset designed for small monochrome or near-monochrome rendering in VS Code.
  Why: direct reuse of a photo-style asset may render as a white square or an unreadable icon in the Activity Bar.
- Add release automation around VSIX packaging and validation.
  Why: packaging works locally, but release validation is still manual.
- Add a documented test matrix for:
  - no Docker
  - Docker available
  - direct chat mode
  - agent tools mode
  - cloud executor mode
  - LM Studio reachable vs unavailable

## Notes
- The anti-hallucination system is present and useful, but it should not be described as a full fact-checking engine yet.
- The current runtime is strong enough for a pragmatic v1, but some guarantees are still heuristic rather than deterministic.
