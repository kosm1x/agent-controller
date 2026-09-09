# V8.3 §14 seam-origin stratification (R1, 2026-08-17): PASS W/WARN, 0 Critical

Scope: `rule-of-two.ts` (RunOrigin on the existing ALS), `dispatcher.ts`
(`TaskSubmission.threadId` → `runOriginOf`, both `enterRunToolContext` sites),
`router.ts` (`threadId: tk` ×2), `registry.ts` (seam reads `currentRunOrigin()`),
`gated-execution.ts` (`GatedExecutionSource` + re-throw guard `!== "interactive"`),
`pipeline.ts` (`proposed` payload carries `source`), `activation-gate.ts`
(`shadowBySource`), 3 test files. Plan: `docs/planning/v8-3-seam-origin-plan.md` §2.
tsc clean; 16 files / 270 tests green.

## Doctrine crumb — a LABEL whose semantics the producer cannot enforce

`threadId: tk` is set in `submitInboundTask`, which serves EVERY inbound sender:
public community-manager mailboxes (`mode !== "owner-only"`) and WhatsApp GROUP
participants in allow-listed groups — not just the operator. The label is
therefore "an inbound conversational turn", not "an operator turn". Community
email is shielded only by `COMMUNITY_EMAIL_TOOLS` (5 tools, none in
`CAPABILITY_BY_TOOL`); WhatsApp group members get the full scoped toolset, so a
group participant's `schedule_task` books as **operator exercise** — the exact
number the first L1→L2 promotion is supposed to cite. `isOwnerChannel(channel,
mode)` (router.ts:~625) already exists and is the ready-made guard.
**Rule: when a new field renames traffic ("operator"), check the WIDEST
population that reaches the site that sets it, not the one the plan describes.**

## Second crumb — both wiring points of a label layer are untested

`dispatcher.ts:692/699/771` (pass `runOrigin`) and `router.ts:1455/2121`
(`threadId: tk`) have ZERO test coverage: every origin test calls
`enterRunToolContext` with an EXPLICIT origin, so deleting either wiring line
leaves the suite green and the §14 by-source line silently reads 100%
background — indistinguishable from "operator never exercised it".
Same class as v85-rule-of-two R1 ("a layer whose only wiring point fails OPEN
must have that point tested"), now with a metric on the other end.

## Third crumb — prototype keys, third recurrence

`activation-gate.ts:162 if (row.source in shadowBySource)` +
`:163 shadowBySource[row.source as ShadowSource] += row.n`. `in` walks the
prototype, so a source label named `constructor`/`toString`/`valueOf` skips the
"unknown ⇒ background" else-branch and writes a STRING own-property (verified:
`o.constructor + 5` → `"function Object() { [native code] }5"`), defeating the
comment's own "buckets still sum" invariant. `Object.hasOwn` is the fix.
Unreachable today (only 3 producers), but this is the third `in`/`[]` finding on
a name-keyed table in this repo.

## Verified clean (don't re-audit)

- Inheritance `origin ?? parent?.origin ?? BACKGROUND_ORIGIN` matches the spec;
  `outsideRunToolContext` = `runToolContext.exit` drops the WHOLE store, so the
  container-queue drain leaks no operator thread (tested both in
  rule-of-two.test.ts and end-to-end in gated-execution.test.ts).
- Explicit origin SURVIVES the container queue (the drain rebuilds from
  `submission.threadId`) even though ALS inheritance does not — so a queued
  operator ROOT keeps its label; only a nested child loses it (label
  nondeterminism by queue timing, Info).
- `runOrigin` is in scope at BOTH `enterRunToolContext` sites (same `try` block).
  The dispatcher is the ONLY `enterRunToolContext` caller in src.
- Re-throw guard change is a NO-OP behaviorally: registry callers were already
  `background` ⇒ re-throw; only `trigger.ts` passes `interactive`. No caller
  passes `operator` expecting a string.
- No ODD predicate keys on `context.source` (live DB: 6 capabilities, none) ⇒
  widening the union cannot flip an ODD evaluation.
- The correlated subquery is index-backed by `sqlite_autoindex_decision_events_1`
  (from `UNIQUE(decision_id, sequence_no)`): live EQP = SEARCH e USING INDEX,
  126 µs over 33 decisions / 99 events. Live regression check passed: all 26
  in-window legacy rows bucket `background` via the CASE fallback.
- Nothing else in src/scripts reads the `proposed` payload or filters
  `decisions.thread_id` ⇒ the additive key and the new non-`background` thread
  values break no consumer. No test asserts `proposed` payload equality.
- Gated tools are NOT registered in `heavy-worker`/`nanoclaw-worker` (shell/http/
  file/coding only) and those write `/tmp/mc.db` ⇒ the container ALS boundary
  costs no ledger rows today.
