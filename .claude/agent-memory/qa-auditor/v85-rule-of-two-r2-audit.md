# V8.5 Phase 5.2 — Rule of Two (R2 fold verification, 2026-08-15): PASS W/WARN

R1 was FAIL (C1) + W1–W5 + R1–R5. All ten folds verified correct. No Critical.
R1 detail: [[v85-rule-of-two-r1-audit]].

## The doctrine crumb — widening an ALS store from "fresh" to "inherit parent"
## turns EVERY in-context callback edge into a cross-task bleed surface

W2 changed `enterRunToolContext` to inherit `parent.toolsSoFar` when a store
exists. That is right for the swarm shape it targets (`submitTask` is
fire-and-forget but the CALL is synchronous, so ALS propagates into the child's
`dispatchWithSlot`). But the same ambient store is live at every other frame
that happens to run inside a parent run — including
`releaseContainerSlot()` → `drainContainerQueue()` → `dispatchWithSlot(queued)`
(`dispatcher.ts:184-236`). **Empirically proven** with a scratch probe
(maxContainers=1; parent records `gmail_read`, submits a container child, then
an unrelated task that queues): the UNRELATED drained task read
`priorRunTools() === ["gmail_read"]`.

Direction is fail-closed (over-demotion), and the shared Set means the queued
task's calls also flow BACK into the parent + siblings. Fix at the boundary:
`runToolContext.exit(() => dispatchWithSlot(...))` in the drain (and any
scheduler/queue seam), so a dequeued task gets the fresh context the header
already promises.

**Rule: when a context becomes inheritable, audit every callback that can run
inside it — not just the call site you meant to cover. Queue drains, slot
releases and `.then()` continuations inherit silently.**

Corollary: the BOUNDARY doc said the container-queue drain is "NOT covered"
(⇒ `undefined` ⇒ fail closed). It is worse than not covered — it gets a
FOREIGN non-empty prior. A boundary note that lists a seam as uncovered must
be checked against what the seam actually observes.

## Second crumb — a fixture pin needs a LIVE detector for the class it pins

The 43-name `LIVE_MCP_NAMES` fixture is exactly right (diffed against the boot
journal: browser 10 + graphify-code 7 + xpoz 5, plus 21 playwright names from
`mcp-servers.json`; 0 missing / 0 extra; zero "without hint overrides" warnings
⇒ every live MCP tool carries hints ⇒ the fixture's `getMcpToolHints` rebuild is
faithful). But it is hand-maintained: a NEW tool under an **A∧B prefix default**
(`xpoz__`) with no `annotations.ts` pattern gets `readOnlyHint` undefined ⇒ C ⇒
trifecta ⇒ the same unsigned high/confirm flip C1 was. Cheapest live detector:
in `manager.ts`'s unannotated-tools warning, also log `isTrifectaByName(name)`.

## Verified clean (don't re-audit)

- **B-only for both xpoz overrides is correct.** `xpoz_trigger_run` returns only
  echoed args + jobId (`xpoz-pipeline/src/api/server.ts:438-445`);
  `xpoz_get_job_status` returns the JobRecord whose `result` is `PipelineResult`
  — entirely numeric (`pipeline.ts:36-47`). Residual: `job.error` is an upstream
  error string. Neither MCP registration path (`bridge.ts:71-80`,
  `manager.ts:244-252`) sets `riskTier`/`requiresConfirmation`/the two RoT
  hints, so nothing shadows the override, and a typo'd override key would be
  caught by the trifecta pin (name falls back to the AB prefix).
- No `browser__`/`playwright__` name can be a trifecta: both prefixes are A-only
  ⇒ ceiling is A+C.
- W3 mutation-verified: deleting the dispatcher wrap in an isolated copy turns
  the new test RED (`expected undefined to deeply equal []`).
- Interactive seam demotes harmlessly today: step 2a only runs at
  `effectiveLevel >= 2`, and `route` is "confirm" for `effectiveLevel <= 2`
  (`pipeline.ts:398`) ⇒ `rule_of_two_no_context` is unreachable while every
  capability sits at L1.
- W4: `calls[]` undeduped, `edges` a Set (dedupe the EDGE names, not the call
  order) — live retrospective still 88/189, the number just didn't move.
- No `requiresConfirmation` consumer disagrees with the resolver: only
  `types.ts` itself plus two deliberate `declaredRiskTier` computations
  (`admin.ts:100`, `rule-of-two-audit.ts:93`); `task-executor.ts:93` reads
  `getEffectiveRiskTier`. `defineTool` spreads `...tool`, so the two new hint
  fields pass through.
- `registry.executeDirect` only LOGS on high/medium — blocking stays in
  task-executor, so the 4 signed flips add journal warns, not new blocks.
- No import cycle: `mcp/types.ts` has zero imports; `rule-of-two.ts`'s
  back-import of `Tool`/`ToolAnnotations` is `import type` (erased).

## Reinforced: `scripts/` is outside `tsconfig.json` `include` (`["src/**/*.ts"]`)

`scripts/rule-of-two-audit.ts` (350 LOC, new) is checked by NEITHER
`tsc --noEmit` NOR vitest. Its only gate is running it. Ran it: `--offline`
renders, `--days 0` / `--days 30d` exit 2. It also carries the prototype-key
pattern W1 removed from `rule-of-two.ts` (`n in SDK_NATIVE` :151,
`n in CAPABILITY_BY_TOOL` :189) — **a grep-sweep of a W-fix must include the
files the same ship ADDED, not only the ones it edited.**
