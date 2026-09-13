# observability + tuning batch (a4a55d0, de3d7e7) — R1, 2026-09-12

Surface B of a 3-surface R1. Scope: `src/runners/termination.*`, `types.ts`,
fast/heavy runners, `dispatch/dispatcher.ts`, `observability/prometheus*`,
`messaging/scope.ts` (CODE_SCOPE_PATTERNS), `tuning/{fingerprint,schema,types,
overnight-loop,activation}.ts`.

**Verdict: FAIL — 2 Critical.** tsc not run (out of scope); scoped suites
158/158 green (16 files, 3.9 s); 2 mutations RED then restored; tree clean.

## C-1 — a fingerprint that certifies the WRONG payload (tuning)

`overnight-loop.ts` `applySandbox()` builds a candidate's
`scopePatternOverrides` from `[...DEFAULT_SCOPE_PATTERNS]` — the array
`activateBestVariant()` **already mutated** at boot. So every persisted
variant is a full 35-group snapshot of *code merged with the previously
active variant*, not a delta over the code. `insertVariant` then stamps
`code_fingerprint = scopeFingerprint(overriddenGroups(...))`, computed over
the pristine `CODE_SCOPE_PATTERNS`.

Both sides of the comparison use CODE — which is what the scope.ts comment
promises — but the thing being certified is not code-derived. Next boot:
code unchanged ⇒ verdict `match` ⇒ activate ⇒ the previous variant's stale
regexes ride forward wearing a green fingerprint. **Drift is laundered, and
the guard can never fire again.**

Live proof: the one valid archived variant (`var-tune-1775545200807`,
2026-04-07, 17 groups) replaces **14 current code patterns** across 11
groups — `coding` 3→1, `google` 2→1, `northstar_write` 7→6 — including the
`creo(?!\s+que\b)` homograph fix. Tuning is ARMED (`tune-1789023600074`,
09-10, 5 experiments / 0 wins): the first win writes the laundered row.

**CLASS: when a guard hashes a "pristine" reference, verify the PAYLOAD is
also derived from that reference. Comparing code-to-code while the artifact
came from the live mutated singleton is a green light over stale content.**

## C-2 — the producer is unreachable under the live provider

`fast-runner.ts:1284` early-returns the whole claude-sdk branch; the
`terminationReason: terminationFromExit(...)` added at :2361 sits on the
OpenAI branch below it. Live config is `claude-sdk` (24 h cost_ledger: 456
rows, all `claude-*`, zero openai-path rows), so the new field is never set
on the dominant path and the dispatcher fallback
(`terminationFromTaskStatus`) emits only completed/needs_context/blocked/
error. Worse than absent: the SDK path detects caps itself
(`sdkCapped` = `/\[(error_max_turns|error_max_budget_usd)\b/`) and the SDK
emits `STATUS: DONE_WITH_CONCERNS` on those, so `success=true` ⇒
**`termination_reason: "completed"` for a turn/budget exhaustion.**

Latent twin: `queryClaudeSdkAsInferWithTools` returns `exitReason: "stop"`
on SUCCESS (claude-sdk.ts:1719). `"stop"` is not in `TERMINATION_REASONS`,
so if the :1284 early return is ever narrowed, every successful SDK run
folds to `"error"`.

**CLASS: a new field added to a runner's return must be added at EVERY
return in that runner — check the early returns FIRST, they are usually the
live path.**

## Enum coverage gaps (fold-to-`error` loses the class)

adapter-openai emits 4 strings absent from the enum: `compaction_exhausted`
(1408), `think_exhaustion` (1540), `escalation_wrapup` (1910),
`escalation_abort` (1915). Two are capacity/budget classes. Currently
unreachable (see C-2) — reachable the moment the provider flips back.

## Terminal-path census

Carry `termination_reason`: dispatcher :906, :958, :1077, :1127 (all 4).
MISSING: `reactions/manager.ts:401` `task.watchdog_failed` (enum member
`aborted` exists and fits). NO trace event at all: `index.ts:164` orphan
reconcile — bus-only `task.failed`; checkpoint uses `exitReason:
"orphaned_restart"`, which the enum lacks.
Zero consumers read `termination_reason` anywhere (src/, scripts/, docs/),
yet termination.ts's header names three ("mc-ctl trace, the eval gate,
Honest Done"). `ATTRS_MAX_CHARS=2000` drops the WHOLE attrs object on
overflow, taking the reason with it.

## Prometheus ratio

adapter-openai NEVER populates `cache_read_tokens` (only the type decl at
:1237) — the dispatcher's optional spread leaves the column at its DEFAULT
0. So `mc_inference_cache_read_ratio_24h` is a hard 0 for every openai-path
model, indistinguishable from a real cache collapse. No live FP today (all
24 h rows are claude), but the documented provider rollback arms it.

## Checks that PASSED (with the proof)

- `:memory:` migration: the `cache_read_tokens` ALTER sits under
  `if (schemaVersion < 1)` in db/index.ts:100; a fresh `:memory:` DB has
  `user_version=0`. Proven by the test's own stdout — `[db] schema
  migration v1 applied: legacy column probes applied (marker only — the v0
  blocks above ran)`.
- `ensureTuningTables`: `CREATE TABLE tune_variants` is in the SAME
  `db.exec()` template immediately above the `PRAGMA table_info` — the
  ALTER can never hit a missing table.
- `getValidVariants(20)` SQL is byte-identical to `getBestVariant()` bar
  `LIMIT ?` ⇒ row[0] is the old best. (`getBestVariant` is now dead —
  no non-test caller.)
- `CODE_SCOPE_PATTERNS` pristine: runtime probe via `tsx` importing
  activation.ts → 35 groups / 56 patterns, `Object.isFrozen` true at both
  levels, byte-identical to DEFAULT at load and unchanged after mutating
  DEFAULT. Only `activation.ts:110-111` mutates, and only at call time.

## Recommendation on the legacy default (operator's open decision)

`fingerprintVerdict` returns `legacy` (activate + warn) for a NULL
fingerprint. The archive holds exactly ONE valid row and it is the April
variant — provably stale (scope.ts: 89 commits since 2026-04-07; `google`
1→2 code patterns, `coding` 1→3). So the shipped default makes the feature
inert on 100% of its motivating population. Recommend flipping the default
to block (or invalidating the April row) — but only AFTER C-1, because
regenerating today produces a laundered replacement.
