# Jev consumers 1–3 — shadow plan (2026-09-21; consumer 2 DEFERRED 09-22)

Follows `jev-decision-layer-plan-2026-09-21.md`. Jev is live as the first scope
classifier (`3c33771`, operator ruling). That use replaced a step that already
worked. This plan puts Jev where Jarvis has **no model judgment today** — a
priority order, a similarity floor, a regex — and measures it in shadow before
it may change a single turn.

Operator request 2026-09-21: "Prepare a plan from 1 thru 3. Then /ship-it".

## What the code does today (verified 09-21)

| #   | Decision                                                                                                                                     | Today                                                                                                                                             | Problem size                                                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Which `conditional` KB rows get the 8,000-char variable budget (`collectVariableSections`, `src/messaging/kb-injection.ts`)                  | Gate = scope GROUP of the row's `condition` (not the message). Rows that pass are packed in `priority ASC` order; the rest become a pointer line. | 12 rows, 39,448 chars. Five rows are `coding` (20,226 chars) and `coding` is in scope on most turns, so the same rows lose every time. By today's order `code-generation-sop` (priority 90) is pointer-only on every coding turn. Nothing records which rows were injected. |
| 2   | DEFERRED (§2). Which recalled memories are injected (`enrichContext`: `mc-jarvis` 5, `mc-operational` 3, pgvector 5; `fast-runner`: JME k=8) | Similarity floors (0.12 / 0.15 / 0.25)                                                                                                            | `recall_audit` 30 d: 253 used of 1,538 marked = 16.5 % (JME 71/662, `mc-operational` 6/224). Most injected memory text is never used.                                                                                                                                       |
| 3   | The follow-up message's feedback label (`detectFeedbackSignal`, `src/intelligence/feedback.ts`)                                              | Regex + 40 % word overlap; positive = "excelente" only                                                                                            | 30 d: 5 negative, 6 rephrase, 13 positive in ~1,500 turns. The label feeds the case miner and tier calibration.                                                                                                                                                             |

Replay on history is **not possible** for any of the three with equal inputs:
no record of injected KB rows, `recall_audit` keeps 50–80-char snippets instead
of the recalled text, and the follow-up message is never persisted. The lesson
of the first scope replay applies (a candidate scored on different inputs than
the incumbent). So: **forward shadow**, not replay.

## Design

One shared client, one shadow table, two consumers that only log (consumer
2 deferred — see "Rulings" below).

- `src/jev/client.ts` — `askJev(state, questions, deadlineMs)` → nouls or a
  throw; `mustNotLeave` moves here. The scope classifier uses it (no behaviour
  change; its tests stay).
- `jev_shadow` table (migration v6, additive): `id, created_at, consumer, ref,
item, noul, latency_ms, incumbent`. One row per question answered, per
  item dropped, and per request withheld or failed.
- Every shadow call is `setImmediate` + never awaited + own try/catch. No
  turn waits on it, no prompt changes, no label changes.
- **Ships dormant.** `JEV_SHADOW_CONSUMERS` (comma list of `kb`, `feedback`;
  default empty) arms each one. Arming is the operator's ruling on
  the text listed under "Leaves the box" for that consumer.
- `mustNotLeave` runs on every string that carries run-time data, **on the
  whole text, before anything is cut** (question wording, state keys and the
  classifier's rules are repo constants, reviewed in the diff). Callers hand `ask()` text uncut; only `ask()` cuts
  (500 chars of user text, 400 per item), after the filter. Audit round 3
  showed why: a cut is a rewrite too — made first, it can drop the word that
  makes the filter object and keep the value in front of it. The same order
  now holds on the live scope path: the router's 150-char context turns are
  also handed over whole, and the filter reads those. A hit on the user's
  text skips the whole request (one `_withheld` row, no vendor call); a hit on
  one item drops that item alone (row with `noul` NULL — only a consumer
  that builds items from run-time text can trip it; held for consumer 2's
  return). A failed request
  leaves one `_failed` row, so loss is countable.
- The live scope path also writes one `jev_shadow` row per call (`consumer =
scope`: outcome, latency and the group names chosen — no text; written
  deferred, off the turn's path). This closes the open audit item that
  the Jev branch had no telemetry, and makes the 7-day latency watch a query.

### 1 — KB row relevance (`kb`)

- Question per candidate row (passed the scope gate AND is registered in
  `KB_SHADOW_ROWS`, below): "this directive is needed to handle the message".
  Criteria = the row's **committed one-line description**, not its content. A
  row that is not registered cannot be scored, so it is never sent: exposure
  with no measurement is not bought.
- `incumbent` = `budget` or `pointer` (what priority order did).
- Label at readout = per-row **evidence predicate** over the tools the turn
  really called (same ground truth as the scope retest). Predicates are
  committed with this ship, before any shadow row exists. Rows with no tool
  evidence are excluded from the score and named.
- **Phase 0, free, in this ship:** `scripts/validate-jev-kb.ts` (dry run)
  replays 30 d of `scope_telemetry.tools_in_scope` through today's gate and
  reports the overflow rate and the pointer-only count per row. If fewer than
  5 % of turns overflow, consumer 1 has no problem to solve and ends here.
- Leaves the box: the message (already leaves for scope) + 7 fixed English
  sentences written in `src/jev/shadow-kb.ts` and reviewed in the diff. **No
  KB text leaves.** Two audit rounds showed why: KB rows are editable at run
  time, the vendor filter false-positives on directive prose (3 of 12 rows:
  ids, long slash-lists), and every rewrite that made such text pass also cut
  the label that made the filter object (`Password: x` → `x`; then a
  path-shaped label → ` : x`). `npx tsx scripts/validate-jev-kb.ts --show`
  prints the 7 sentences. Cost of the route: Jev judges our summary of a row,
  so a PASS says "a described row can be ranked", and enforcement would need
  a description per row.

**Phase 0 result (09-22, 1,502 turns with a scope, today's rows; the figures
move with the 30-day window — re-run the script):** 1,049
turns (69.8 %) push at least one applicable row into the pointer. Four rows
with real volume are pointer-only on 100 % of the turns they apply to (plus
`active-plans`, 1 of 1 turn — registered, but too rare to move the score):
`code-generation-sop` (1,028), `long-running-tmux` (1,028), `preview-publishing` (1,028; its
guardrail bypasses the budget when the message names a preview),
`x-posting-card` (74). `intelligence-depot-live-sources` loses on 69.8 %,
`protocolo-publicacion` on 71.6 %. Consumer 1 has a problem to solve.

**Registered evidence predicates** (row was needed iff the turn called one of
these tools; `jev_shadow.ref` = task id → `scope_telemetry.tools_called`). The
binding copy is `KB_SHADOW_ROWS` in `src/jev/shadow-kb.ts` (description +
evidence per row), committed with this ship; it is also the send allow-list:

| Row                                       | Evidence                                                         |
| ----------------------------------------- | ---------------------------------------------------------------- |
| `code-generation-sop`                     | `file_write`, `file_edit`, `git_commit`, `jarvis_dev`            |
| `x-posting-card`, `protocolo-publicacion` | `tweet_post`                                                     |
| `data-doc-authoring`                      | `gdocs_write`, `gdocs_replace`, `gsheets_write`, `gdrive_create` |
| `northstar_recurring_tasks`               | `northstar_sync`, `schedule_task`, `list_schedules`              |
| `intelligence-depot-live-sources`         | `intel_query`, `intel_alert_history`                             |
| `active-plans`                            | the six `learning_plan_*` tools, `learner_model_status`          |

Excluded from the score, named here so the readout cannot add them later:
`long-running-tmux` and `denue-access-card` (the evidence is in `shell_exec`
arguments, which telemetry does not keep), `preview-publishing` (the guardrail
already injects it), `fede-reference`, `gotchas` (no tool evidence). Two of
the four always-losing rows are therefore scoreable, two are not.

Known imprecision: the shadow reads the rows one tick after the prompt was
built; a KB write in between would label a row set the turn never saw.

### 2 — Memory relevance (`memory`) — DEFERRED (operator ruling A, 09-22)

Not in this ship. The design stays here for the redesign:

- Question per recalled item: "this memory helps answer the message".
  Criteria = the item text as recalled (filtered whole, then cut to 400
  chars; measured 30 d: ~92 recalls/day, 5.8 items each, max 10).
- Was to hook inside `logRecall`; `ref` = the `recall_audit` row id; label =
  `was_used` (per RECALL, not per item; a token-overlap heuristic).
- Leaves the box: **recalled memory text** — personal facts about the
  operator. The most sensitive of the three.
- Why deferred: the JME leg's recall query reaches `logRecall` already cut to
  2,000 chars (`src/runners/fast-runner.ts`, an embed-latency cap), so the
  filter cannot read the whole message there. The redesign feeds the consumer
  from the router, where the uncut message exists, keyed to the recall row.
  The `jev_shadow` CHECK keeps `memory` so it returns additively.

### 3 — Feedback label (`feedback`)

- Two questions per follow-up inside the feedback window: "the user is
  correcting or complaining about the previous reply" and "the user is
  restating the same request". **No positive question** — operator directive:
  "excelente" is the only eval word.
- `incumbent` = the regex label. No ground truth exists, so the readout is a
  disagreement table the operator labels (≤ 40 rows, ~10 min).
- Leaves the box: the follow-up and the previous user message, cut to 500
  chars each. The regex detector reads the same two texts uncut, so on turns
  longer than 500 chars the comparison is not equal; the readout names how
  many. The previous reply is NOT sent.

### Rulings (audit round 4, 09-22) — RESOLVED

Four audit rounds found the same class four times: a transform applied to
text before the vendor filter reads it. Rounds 1–3 were in this ship's own
code and are closed structurally (descriptions only; `ask()` cuts after it
filters). Round 4 found the class in a **pre-existing** line outside this
diff: `src/runners/fast-runner.ts` cuts the JME recall query to 2,000 chars
before `queryMemory` → `logRecall` → consumer 2 ever sees it. Reproduced: a
2,596-char message whose only credential keyword sits past char 2,000 would
leave in `state.message` once `memory` was armed. Only consumer 2's JME leg
was affected; `kb`, `feedback` and the live scope path read the whole text.
Under the 3-strike rule no fifth patch of this class was made.

- **Ruling 1 — A, narrow the ship**: consumer 2 is dropped (its hook in
  `logRecall`, `shadowMemoryRecall` and its tests removed); `kb` +
  `feedback` + the scope telemetry row ship. The `memory` value stays in
  the table's CHECK. Routes not taken: B (move the cut to the embedding
  only — a fifth fix of the class in a layer no audit had listed) and C
  (hold everything until the whole recall path is traced).
- **Ruling 2 — accept whole-turn filtering** on the live scope path. It
  withholds **50.5 %** of turns measured over the last 500 conversations,
  against 32.2 % before (the 32 % was never reported: a third of live turns
  already fell to Sonnet). 96 of the 130 new withholds are the
  `[A-Za-z0-9+/_-]{32,}` rule firing on paths in assistant replies. The
  7-day watch therefore runs on about half the turns, and not a random
  half: long, path-heavy exchanges are the ones withheld. Tuning that one
  rule is a separate change with a corpus-replay fixture (queued).

## Registered bars (fixed before any shadow row exists)

Readout after **7 days and ≥ 150 scoreable decisions** per consumer; fewer =
INCONCLUSIVE, not a pass. Threshold picked on the first half by date, judged
on the second half. No post-hoc rescue.

| #   | PASS needs                                                                                                                                                                      | Otherwise                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1   | Packing the budget in Jev-score order puts ≥ 90 % of evidence-positive rows in budget AND beats priority order by ≥ 15 points                                                   | Ends; the row order is fixed by operator ruling instead (two are already pending: coding-SOP priority, 2 unconditioned rows) |
| 2   | DEFERRED with consumer 2 (ruling A). Was: at the threshold that keeps ≥ 95 % of used recalls on the first half, the second half keeps ≥ 90 % of used and drops ≥ 40 % of unused | Ends; input to the 09-30 5-layer readout either way                                                                          |
| 3   | On operator-labelled disagreements Jev is right ≥ 70 %; and its corrections have precision ≥ 80 % on a labelled sample of 20                                                    | Ends                                                                                                                         |

Bar 1, made computable: the 5 unregistered rows are not scored and are not
re-ordered. The simulation holds them at their current priority position and
packs only the 7 registered rows, in Jev-score order, into the space that
remains. Both figures are measured over registered rows only; "points" are
percentage points of the same in-budget share of evidence-positive rows.

A PASS unlocks a proposal to enforce, one consumer at a time, each with its
own kill switch and operator ruling. Nothing in this plan enforces.

## Cost and risk

- Spend: per request ≈ 0.5k tokens (`kb`: the message + up to 7 one-line
  descriptions), ≈ 0.5k (`feedback`). At ~50 turns a day that is
  < $0.01/day, < $0.10 for the window. Unledgered, like the scope spend.
- Never on a safety boundary (deliverable filter, shell gate, completion
  ledger): the vendor says adversarial text moves the answer.
- Vendor down = shadow rows missing, turns unaffected.
- Whole-turn filtering on the live scope path sends more turns to Sonnet
  (measured +18 pp, above); each is the previous incumbent's latency, not a
  wrong answer.

## Phases

| Phase | What                                                                             | Who             |
| ----- | -------------------------------------------------------------------------------- | --------------- |
| 0     | KB overflow dry run (free)                                                       | this ship       |
| 1     | Shared client, `jev_shadow` (migration v6, deploy gate → 6), scope telemetry row | this ship       |
| 2     | Two shadow consumers (`kb`, `feedback`), dormant; evidence predicates committed  | this ship       |
| 3     | Deploy; arm `kb` → `feedback`                                                    | operator        |
| 4     | Readout harness run at day 7 against the registered bars                         | next session    |
| 5     | Enforcement proposal per PASS                                                    | operator ruling |
