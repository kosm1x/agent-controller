---
name: denue-guard-literal-r1-audit
description: 09-29 DENUE guard literal-mention rule (denueGuardText/mentionsDenue + detectionText forward) + heavy failure toolCalls from run context; PASS-W-WARN.
metadata:
  type: project
---

Verdict PASS WITH WARNINGS, 0 Crit, tsc 0, 281/281 (6 files), 2/2 mutants RED (detectionText precedence; calledSoFar context merge).

- Replay (30d, read-only): chat guard 891 -> 12 (scope_telemetry.message joined by task_id = the raw inbound); schedule 42 + ritual 72 -> 0. 12 DENUE mentions, 8 next turns within 30 min without the word.
- `\bdenue\b` misses `denue_api`, `DENUEs`, `denue2026`, accented `denué`/`DENÚE`; matches `DENUE's`, `Denue.`, `DENUE-Analyzer`, `/denue`.
- Telegram msg.text of a FILE message embeds the extracted file content, so a forwarded file naming DENUE fires the guard (user-supplied, not user-typed).
- `directives/denue-access-card.md` is a `conditional|coding` KB row: DENUE content reaches every coding-scope chat independent of the guard.
- runToolContext Set is SHARED by nested dispatches (swarm children + parent); heavy failure rows now carry siblings' names. Live env: SWARM_SUBTASK_RETRY_ENABLED and HEAVY_RUNNER_CONTAINERIZED absent -> swarm effect = shadow telemetry only; reaction manager skips subtasks.

**Why:** CLASS: a "what the user wrote" field is only as clean as the channel adapter that fills msg.text; and an ALS run-context Set scoped to a SESSION over-reports per TASK.
**How to apply:** for any user-text gate, read the channel adapters' text composition (file/voice paths); for any per-task list sourced from runToolContext, trace nested submitTask sites.
