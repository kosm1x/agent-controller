# V8.3 §14 — Seam Origin Stratification (reflection on the "SDK Hook Seam" plan)

> **Date:** 2026-08-17
> **Supersedes:** `jarvis/feat/v8-3-sdk-hook-seam` → `docs/planning/v8-3-sdk-hook-seam-plan.md`
> (untracked on that branch; KB copy `jarvis-kb/projects/agent-controller/docs/`)
> and cookbook candidate #1 in `cookbooks-adoption-candidates.md`.
> **Audience:** Jarvis. This is a reflection on your own plan. Read §1 before §2.
> The plan you wrote was structurally sound as a document; its diagnosis was
> unverified, and every downstream design choice inherited the error.

---

## 1. Reflection — the assumptions your plan rested on, and what the code says

Each item is a claim you wrote, the check that would have refuted it in one
call, and what the check returns. The pattern across all five is the same:
**a diagnosis was asserted from a KB summary and never run against `main`.**
None of these needed more than a grep or a `SELECT`.

### 1.1 FALSE — "the operator-agent does not pass through `ToolRegistry.execute`"

You wrote: `Claude (chat) → Anthropic SDK → tool_use block → handler directo`.

Check: `grep -rn 'registry.execute(' src --include=*.ts`. The operator's chat
turn is a task like any other:

```
router.handleInbound            src/messaging/router.ts:2190
  → submitTask({title:"Chat: …", tags:["messaging", channel, …]})   :2101
    → dispatcher → enterRunToolContext(taskId, …) → runner.execute  src/dispatch/dispatcher.ts:668
      → fast-runner → createTaskExecutor(toolRegistry, ctx)          src/runners/fast-runner.ts:1146
        → registry.execute(name, args)                               src/tools/task-executor.ts:131
          → V8.3 background seam                                     src/tools/registry.ts:220-233
```

Every other route lands on the same method: Prometheus (`prometheus/executor.ts:407`),
the claude-sdk MCP bridge (`inference/claude-sdk.ts:157`), scheduled/ritual
tasks (task-executor), and the confirm-flow (`lib/v8-3/trigger.ts:59`, with
`{v83:"skip"}`). The only direct `tool.execute(args)` in the tree is inside
the registry itself (`registry.ts:260`); `mcp/manager.ts:297` is a lazy proxy
that _is_ the registered tool. The Claude Code-facing MCP surface
(`src/api/mcp-server/`) exposes 8 read-only tools — none of the four gated
ones. **There is no handler path that bypasses the chokepoint.**

Live proof (no code reading required): `curl :8080/metrics | grep mc_tool_latency`
after the 08-16 restart lists `exa_search web_search intel_query web_read
tweet_post browser__goto …` — chat-only tools. They can only reach that
counter through `executeDirect`.

### 1.2 FALSE — "0 rows for schedule_task / northstar_sync / jarvis_file_delete proves the seam misses them"

The predicate's population was zero. Those three tools **were not executed
at all** between 08-08 and today: `/metrics` shows no calls since the 08-16
restart; `journalctl -u mission-control --since 2026-08-08` has exactly one
hit each — your own diagnostic `grep` at 21:44 today (`[shell-guard] OK: grep
-rn "schedule_task\|northstar_sync\|jarvis_file_delete" …`). A `COUNT(*)=0`
on an empty population proves nothing about the seam. This is the
`gate-scored-an-impossible-population` class, third recurrence on V8.3 alone:
**run the predicate as `COUNT(*)` + `MIN()` on the population BEFORE reading
the gated count.**

### 1.3 FALSE — "gmail_send appears only because it passes through trigger.ts (interactive seam)"

The opposite. `SELECT thread_id, COUNT(*) FROM decisions GROUP BY 1` →
`background | 33`. `SELECT COUNT(*) FROM decisions WHERE thread_id != 'background'`
→ **0**. All 33 rows come from the **background** seam (scheduled sends);
the interactive confirm-flow has produced zero rows since 08-08. Your
evidence's provenance was inverted, which is why the conclusion drawn from
it was inverted too.

### 1.4 CONTRADICTORY — diagnosis vs fix

§"Diagnóstico": the operator never reaches `ToolRegistry.execute`.
§"Paso 2": add the operator seam **inside** `ToolRegistry.execute`.
If the diagnosis were true, the fix could not observe anything. The fix
"works" only because the diagnosis is false. A plan whose fix refutes its own
diagnosis has not been read back once after writing.

### 1.5 STALE — the branch predates the seam it plans to edit

`jarvis/feat/v8-3-sdk-hook-seam` was cut from `05d9965` (2026-08-02), 28
commits behind `main` and **before** `fd60a02` (2026-08-08) shipped the seam.
On your branch `src/lib/v8-3/gated-execution.ts` does not exist and
`registry.execute` has neither the seam nor the `opts` parameter. Two of the
files in your "Archivos a modificar" table cannot be edited on the branch
that table applies to. **Before writing a plan against a file, `ls` it on the
branch you will implement on** (`ls paths from any plan before acting` —
this rule already exists; it applies to your own plans).

### 1.6 MISNAMED — "SDK Hook Seam"

You correctly concluded the cookbook's `hooks.beforeToolCall` does not apply
(the claude-sdk runner already funnels through `buildMcpServer → wrapTool →
toolRegistry.execute`). The plan then implemented an ALS, not a hook, but kept
the title. Cookbook candidate #1 still asserts the wrong mechanism. Left as-is,
you will re-derive this same plan from your KB next month.

### 1.7 What was actually true underneath (the part worth keeping)

`registry.ts:228-229` hardcodes `source:"background", threadId:"background"`
for **every** non-confirm execution. A gated tool that is not
confirmation-gated and is called from an operator chat turn (today only
`schedule_task` — `northstar_sync` is `riskTier:"high"`, `jarvis_file_delete`
is `requiresConfirmation:true`, `gmail_send` is high; all three take the
interactive seam in chat) is **captured but mislabeled** as background.
Additionally, `source` is never persisted: `recordGatedExecution` passes it
into `DecisionTrigger.context` for ODD evaluation only; the `proposed` event
payload is `{route, baseLevel, effectiveLevel, cadence}` and the `decisions`
row keeps only `thread_id`. So the ledger's only surviving discriminant is the
literal string `"background"` in `thread_id`.

That is a **labeling + stratification** defect (the deferred R2 item from
08-08: "v83-gate should stratify shadow count by source"), not a capture gap.
It matters because the first L1→L2 promotion must not cite a §14 fill that is
100% background/single-capability. It does not require a new ALS, a router
refactor, or moving the seam.

### 1.8 Why your proposed ALS-in-router was the wrong layer even for the real defect

- The dispatcher **already** enters an ALS around every runner execution
  (`enterRunToolContext`, `dispatcher.ts:668/740`) and the seam already reads
  it (`priorRunTools`, `currentRunTaskId`). Origin belongs on that store.
- A second ALS seeded in `handleInbound` would leak: the container-queue drain
  fires from `releaseContainerSlot` inside a finishing run's frame and
  `outsideRunToolContext` (`rule-of-two.ts:454`) exits **only**
  `runToolContext`. An unrelated dequeued task would inherit the wrong
  operator thread — the exact bug qa W-A fixed on 2026-08-15. Riding the
  existing store inherits that fix.
- "ALS propagates automatically" is true in-process and false across
  `nanoclaw-worker` / `heavy-worker` (documented boundary,
  `rule-of-two.ts:419-435`). Your risk table overclaimed.
- Invariants 3 (no double-record via `{v83:"skip"}`) and 4 (fail-open) already
  hold today. Fine as regression tests; not new coverage.

---

## 2. Corrected plan — origin on the run context, source persisted, gate stratified

**Principle:** touch the seam only where it already reads context; add nothing
the dispatcher does not already know; persist the discriminant that the gate
needs; no router refactor.

### 2.1 `src/tools/rule-of-two.ts` — origin rides `RunToolContext`

```ts
export type RunSource = "operator" | "background";
export interface RunOrigin {
  source: RunSource;
  threadId: string;
}
export const BACKGROUND_ORIGIN: RunOrigin = {
  source: "background",
  threadId: "background",
};

export interface RunToolContext {
  readonly toolsSoFar: Set<string>;
  readonly taskId: string;
  /** Who initiated this run (V8.3 seam label). Inherited by nested dispatches. */
  readonly origin: RunOrigin;
}

export function enterRunToolContext<T>(
  taskId: string,
  fn: () => T,
  origin?: RunOrigin,
): T {
  const parent = runToolContext.getStore();
  return runToolContext.run(
    {
      toolsSoFar: parent ? parent.toolsSoFar : new Set(),
      taskId,
      origin: origin ?? parent?.origin ?? BACKGROUND_ORIGIN,
    },
    fn,
  );
}
export function currentRunOrigin(): RunOrigin {
  return runToolContext.getStore()?.origin ?? BACKGROUND_ORIGIN;
}
```

Inheritance rule: explicit origin (root submission) > parent's origin (nested
`submitTask` from inside a run — a swarm child of a chat turn is still
operator-originated) > `BACKGROUND_ORIGIN`. Outside any run (`getStore()`
undefined) → background, so the seam degrades exactly as today.

### 2.2 `src/dispatch/dispatcher.ts` — derive origin from the submission

- `TaskSubmission.threadId?: string` (new, optional). Semantics: "this run was
  initiated by an operator turn on this conversation thread".
- Both `enterRunToolContext(taskId, …)` sites pass
  `submission.threadId ? { source: "operator", threadId: submission.threadId } : undefined`
  (undefined → inherit-or-background).
- `threadId` is persisted in `tasks.metadata` next to tags/tools/ritualId so a
  reaction-retried operator task keeps its label (qa W4).
- Nested-child caveat (qa R1): a child submitted from inside an operator run
  inherits `operator` when a container slot is free (runs in the parent's ALS
  frame) but lands `background` when queued (the drain exits the store and the
  child carries no `threadId`). Direction is conservative; acceptable for a
  readout.

### 2.3 `src/messaging/router.ts` — two additive lines, owner-gated

The chat submit (`:2101`) and the background-agent spawn (`:1438`) already have
`tk` in scope: add `threadId: this.operatorThreadKey(msg, tk)`. Same key the
interactive seam already records (`executeGatedCapability(…, { threadId: tk })`,
`:1672-1676`), so operator rows from both seams stratify on the same thread key.
`operatorThreadKey` returns the key only for the OPERATOR's turn — owner channel
(`isOwnerChannel`; community-manager mailboxes excluded) and, in a WhatsApp
group, a sender whose JID is the owner's — else `undefined` ⇒ background (qa W1:
`handleInbound` serves allow-listed group members and community mailboxes too;
labelling them `operator` would show operator exercise no operator performed).

### 2.4 `src/tools/registry.ts` — read the origin instead of the literal

```ts
const origin = currentRunOrigin();
return recordGatedExecution(name, args, () => this.executeDirect(name, args), {
  source: origin.source,
  threadId: origin.threadId,
  priorToolNames,
  resolveToolAnnotations: (n) => this.annotationsOf(n),
});
```

### 2.5 `src/lib/v8-3/gated-execution.ts` — widen the union, keep the failure channel

- `source: "interactive" | "background" | "operator"`.
- The qa-W2 re-throw guard becomes `ctx.source !== "interactive"`: an operator
  chat run reaches the seam through task-executor, i.e. a **registry** caller
  that expects the original exception channel — same contract as background.
  Only the confirm-flow (router) keeps the JSON-error string contract.

### 2.6 `src/lib/v8-3/pipeline.ts` — persist `source`

`emit("proposed", { route, baseLevel, effectiveLevel, cadence, source: trigger.context.source })`.
Append-only event, JSON payload — additive, no DDL. Rows before this ship
have no `source` in the payload; the reader (2.7) treats absence as
`thread_id='background' ? 'background' : 'interactive'`.

### 2.7 `src/lib/v8-3/activation-gate.ts` + `scripts/v83-gate.ts` — stratify, don't re-gate

Add `shadowBySource: Record<"interactive"|"operator"|"background", number>`
to `V83GateResult` and render it in the `shadow volume` line. Query joins
`decision_events` (`event_kind='proposed'`, `json_extract(payload_json,'$.source')`)
with the legacy fallback above. **No new pass/fail check** — the R2 ask is
visibility so a promotion decision cannot cite an unstratified fill; a veto
here would be a gate that ranks nothing (`veto-needs-a-do-nothing-option`).

### 2.8 Tests (scoped runs — the full suite is hook-blocked on this box)

- `rule-of-two.test.ts`: origin default (outside run) · explicit on root ·
  inherited by nested `enterRunToolContext` · not inherited across `outsideRunToolContext`.
- `registry.test.ts`: gated tool inside an operator run → `source:"operator"`,
  `threadId:<tk>`; inside a plain run → background; outside any run → background.
- `gated-execution.test.ts`: `operator` re-throws like `background`; `interactive` returns JSON error.
- `pipeline.test.ts`: `proposed` payload carries `source`.
- `activation-gate.test.ts`: `shadowBySource` counts (with and without payload `source`).
- `dispatcher.test.ts` (if a cheap seam exists): `threadId` on the submission → operator origin.

### 2.9 Docs / KB (part of the ship, not after it)

- This file (repo) + overwrite the KB copy of your plan with a superseded
  banner pointing here — you read the KB, not `docs/planning/`.
- Cookbook candidate #1: rewrite to the verified mechanism (seam already
  covers every path; the defect was label + persistence).
- `next-sessions-queue.md`: close deferred R2 (stratify by source); note the
  first-promotion precondition now has the data it needs after ~7d.

### 2.9b Audit folds (qa-auditor, same session — PASS with warnings, 0 Critical)

- **W1** operator label gated on the owner (`operatorThreadKey`, §2.3).
- **W2** wiring tests: dispatcher (`submitTask({threadId}) → currentRunOrigin()` inside
  the runner; mutation-verified RED when the 3rd arg is dropped) and router (owner
  turn carries `threadId`, group member does not, owner-in-group does).
- **W3** `Object.hasOwn` on the bucket table (a `constructor`/`toString` label
  would have skipped the else-branch under `in`).
- **W4** `threadId` persisted in `tasks.metadata`; reactions retry paths pass it through.
- **S1** stale `trigger.ts` module doc updated.
- **R3** `proposed` payload shape pinned in `pipeline.test.ts`.
- Deferred: **R2** (no explicit background opt-out for a nested submission — add
  when a genuinely-background nested submitter appears) · **R4** (narrow the
  persisted `source` to the union at the write side — the reader already buckets
  unknown labels as background).

### 2.10 Non-goals (explicitly rejected)

- Moving the seam to any SDK hook layer.
- A second ALS in the router / extracting `handleInbound`.
- A per-handler seam inside `src/tools/builtin/`.
- Any change to what is **captured** — capture was never the defect.

---

## 3. Verification (what "done" means)

- `npx tsc --noEmit` clean; scoped vitest green for the files in 2.8.
- Deploy (`./scripts/deploy.sh`), then a chat-turn `schedule_task` (any
  no-op schedule, then delete) produces a `decisions` row with
  `thread_id='<tk>'` and a `proposed` event with `"source":"operator"`;
  the next scheduled `gmail_send` produces `thread_id='background'`,
  `"source":"background"`. `./mc-ctl v83-gate` prints the by-source line.
- Regression: 33 legacy rows still count in `shadowDecisions`, bucketed
  `background` by the fallback.

## 4. Doctrine to carry forward (yours to internalize)

1. A diagnosis is a **claim**; grep or `SELECT` it before a single line of plan.
2. `COUNT(*)=0` on a gated predicate → first prove the population is non-empty.
3. Read the plan back once: does the fix contradict the diagnosis?
4. `git log -1` on the branch you plan against; `ls` every file in the change table there.
5. Name the mechanism you are actually shipping, not the one you read about.
