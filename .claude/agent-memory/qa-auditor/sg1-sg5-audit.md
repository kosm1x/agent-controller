---
name: SG1-SG5 Safeguard Audit
description: Audit of 5 autonomous improvement safeguards — 3 critical bypasses found (file_delete, path traversal, sqlite3 cooldown reset)
type: project
---

## SG1-SG5 Safeguard Audit (2026-04-06)

**Verdict: FAIL** — 3 critical bypass vectors, 1 ESM violation, incomplete immutable core list.

### Critical Findings

1. **file_delete has no immutable core check** — can destroy any protected file including immutable-core.ts itself (file.ts:280-328)
2. **isImmutableCorePath does no path normalization** — shell.ts:173 passes raw regex-captured paths, traversal sequences bypass check
3. **Cooldown bypass via sqlite3** — `shell_exec` doesn't block `sqlite3`, agent can DELETE FROM safeguard_state
4. **ESM violation persists** — shell.ts:88 still uses require("child_process"), listed as "fixed" but wasn't

### Immutable Core Gaps

Missing from protected list: package.json, tsconfig.json, classifier.ts, heavy-runner.ts, autonomous-improvement.ts, shell.ts, file.ts, code-editing.ts

### Kill Switch Weakness

process.env doesn't survive service restart. Should persist to safeguard_state table.

### Key Files

- Immutable core: src/tools/builtin/immutable-core.ts (10 files + src/api/ prefix)
- Kill switch: src/api/routes/admin.ts
- Cooldown: src/tools/builtin/jarvis-directives.ts (COOLDOWN_KEY in safeguard_state)
- Pre-cycle tags: src/rituals/scheduler.ts (createPreCycleTag, pruneOldTags)
- Diff digest: src/rituals/diff-digest.ts (weekly cron 0 20 \* \* 0)
