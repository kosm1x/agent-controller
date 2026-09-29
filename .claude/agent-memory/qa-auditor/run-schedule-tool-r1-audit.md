---
name: run-schedule-tool-r1-audit
description: run_schedule tool R1 (2026-09-29) - PASS-W-WARN verdict; requiresConfirmation is NOT enforced on the claude-sdk path; no bound on scheduled-task A->B->A run_schedule ping-pong
metadata:
  type: project
---

R1 audit of `run_schedule` (uncommitted, 2026-09-29): PASS WITH WARNINGS, tsc 0, 612/612 scoped, 5/5 mutants RED.

CLASS: `requiresConfirmation` is enforced ONLY in `task-executor.ts` (openai path `inferWithTools`). The claude-sdk path (`claude-sdk.ts wrapTool` -> `toolRegistry.execute`) ignores the executor, so on production a "confirmed" tool runs with no gate. Evidence: `tool_approvals` has had 0 rows ever since 09-12, while chat task 462227c7 (09-14) ran gmail_send in-task.

**Why:** a tool author who relies on requiresConfirmation for safety is relying on a gate that prod does not run.
**How to apply:** for any new high-risk tool, check which inference path production runs, then rule on the tool's safety without the confirm gate. Non-interactive runs (scheduled tasks, rituals) bypass the gate on BOTH paths, so a tool that dispatches work needs its own refusal of a background origin, or it can recurse. Related: [[multi-round-audit-until-pass]].
