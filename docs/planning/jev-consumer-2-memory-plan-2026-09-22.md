# Jev consumer 2 — memory relevance, redesigned (2026-09-22)

Parent plan: `docs/planning/jev-consumers-plan-2026-09-21.md` (§2 DEFERRED,
operator ruling A). This plan brings consumer 2 back additively: the
`jev_shadow` CHECK already holds `memory`, the client, the table, `ask()`
and the readout bars are unchanged.

## Why the first design was wrong

The first consumer hooked inside `logRecall`, the one place every bank's
recall is logged, and took `query` from there. On the JME leg `query`
arrives already cut to 2,000 chars (`src/runners/fast-runner.ts`,
`JME_QUERY_MAX_CHARS`, an embed-latency cap), so the vendor filter could
never read the whole message: a credential keyword past char 2,000 stays
behind, the value in front of it leaves. That is the class four audit rounds
found (a transform before the filter reads the text), in a layer outside
that ship's diff. Moving the cut into `embed()` was route B — rejected as a
fifth patch of the class.

## Design — take the text from the source that has it whole

The runner already holds both things the consumer needs, uncut, on the chat
path: `lastUserMsg` (`fast-runner.ts` ≈ line 844 — the same value consumer 1
`shadowKbRows` reads and a wiring test pins as uncut) and `jmeFacts`, the
recalled items after `orderForInjection`. The hook goes there, after the
JME block is pushed into `messages` and inside `if (jmeFacts.length > 0)`,
so a throw from the shadow cannot delete the block (audit R1 W6); it mirrors
consumer 1's guard:

```ts
if (!isReadOnlyTask && typeof lastUserMsg === "string")
  shadowMemoryRecall(input.taskId, lastUserMsg, jmeFacts);
```

- `shadowMemoryRecall(taskId, message, facts)` in `src/jev/shadow.ts`:
  `deferShadow("memory", taskId, { message }, () => items)`; one item per
  fact (`item` = the fact id, `positive` = `factText` whole — `ask()`
  filters each item whole, then cuts to 400 chars; `incumbent` = the
  fact's category); `instructions` = the registered question, "Is the
  memory quoted in the criteria relevant to answering the user's
  `message`?" (pinned by a test — bar 2 thresholds a relevance number);
  negative "The memory has nothing to do with the message." The consumer
  drops items beyond 8 (`MAX_MEMORY_ITEMS`), so a wider recall `k` cannot
  widen what leaves.
- `ShadowConsumer = "kb" | "memory" | "feedback"`; `JEV_SHADOW_CONSUMERS`
  accepts `memory` again.
- `ref` = task id. `recall_audit` has no task id at recall time;
  `markRecallUtility` writes `task_id` + `was_used` when the reply lands.
  Readout join: `jev_shadow.ref = recall_audit.task_id AND recall_audit.bank
= 'jme'`; a recall never claimed (`was_used IS NULL`) is not scored.
- Nothing is read from inside `logRecall`; `recall-utility.ts` stays at
  HEAD. The text path is: user turn → `conversationHistory` → `lastUserMsg`
  → `deferShadow` → `ask()` (filter whole, then cut). No cut between source
  and filter — the router prepends a `[Hoy: …]` time line to the last user
  turn, which is additive and cannot remove what the filter keys on — the
  same path consumer 1 ships on today.
- Leaves the box (once armed): the user message (already leaves for scope
  and `kb`) + up to 8 JME facts of ≤ 400 chars — personal facts about the
  operator. Arming `memory` is the operator's ruling on that text; the
  parent plan's arm order stays `kb` → `feedback` → `memory`.

**Scope: the JME leg only.** The other recalls (`enrichContext`: `mc-jarvis`,
`mc-operational`, pgvector) run in the router and return a rendered block,
not the items; scoring them needs `EnrichmentResult` to carry the recalled
items back. Queued as Phase 2, not built here. JME is the largest bank by
volume (662 of 1,538 marked recalls in 30 d; 71 used) and the one whose
`was_used` is measured per task.

## Registered bar (unchanged from the parent plan, bar 2)

Readout after **7 days and ≥ 150 scoreable recalls** (a recall = one task
with ≥ 1 fact sent and `was_used` not NULL); fewer = INCONCLUSIVE. Threshold
picked on the first half by date, judged on the second half: at the
threshold that keeps ≥ 95 % of used recalls on the first half, the second
half keeps ≥ 90 % of used and drops ≥ 40 % of unused. A recall is scored by
its highest item noul. Volume check: ~22 JME recalls/day with facts over
30 d, 14/day over the last 7 → 150 in 7 days is on the edge; the readout says
INCONCLUSIVE rather than stretching the window.

Readout query rules (audit R1, measured on 30 d of `recall_audit`):

- `markRecallUtility` claims every unclaimed `recall_audit` row in a 60 s
  window for the task whose reply landed, so a concurrent turn can claim
  another task's JME row: 5.5 % of claimed task ids carry two `bank = 'jme'`
  rows (a task recalls once). The readout drops every task id with more
  than one `jme` row and prints the count; a task whose row was claimed
  elsewhere joins nothing and drops out (n shrinks, no corruption).
- `_withheld` / `_failed` rows (`noul IS NULL`) are not decisions and are
  excluded before the highest-noul step; their counts are printed.
- The noul judges the first 500 chars of the turn (after the time line);
  `was_used` reads the whole reply. On long turns this depresses the noul
  of used recalls — the direction that makes the bar harder, not easier.

Known weakness (unchanged): `was_used` is a token-overlap heuristic and
under-counts memories that shaped a reply without being quoted.

## Tests (RED first, then the code)

- `src/jev/shadow.test.ts`: `shadowMemoryRecall` — sends the facts and the
  whole message; drops a sensitive fact alone (null-noul row, the rest
  scored); withholds the request on a sensitive message with a fact list
  that is clean (`late(chars)` fixture — the keyword after char 2,000, the
  value in front: this is the round-4 reproduction, now RED-then-GREEN in
  the consumer's own suite); no facts = no request; `memory` arms and is
  dormant by default; a body never contains more than 8 questions.
- `src/runners/fast-runner.integration.test.ts`: a chat turn whose JME recall
  returns facts calls `shadowMemoryRecall(taskId, <the uncut user message>,
facts)` with a message longer than 2,000 chars — the assertion is on the
  whole text; a read-only turn and a turn with no facts do not call it.
- Mutation checks: remove the `!isReadOnlyTask` guard; pass the cut
  `lastMsg` instead of `lastUserMsg`; drop the filter on items; drop the
  `≤ 8` guard — each must turn one test RED.

## Docs and deploy

- Parent plan §2: DEFERRED → "REDESIGNED 09-22, see this file"; phases
  table arm order back to `kb` → `feedback` → `memory`; cost line + ≈ 1k
  tokens per JME recall (< $0.02/day).
- `docs/CLAUDE-REFERENCE.md` knob line: valid values `kb`, `feedback`,
  `memory`; the source rule ("from the runner's uncut message, never from
  `logRecall`").
- `docs/PROJECT-STATUS.md` header + sessions row; queue row.
- qa-auditor gate before commit (round 1 scoped to this diff; the class to
  look for is named above). Commit (hook = full suite), push, docs commit
  citing the hash, deploy line for the operator, arming line
  `JEV_SHADOW_CONSUMERS=kb,feedback,memory` after `kb`/`feedback` rows exist.

## Not in this ship (queued)

- Phase 2: `enrichContext` legs — return recalled items in
  `EnrichmentResult`, hook in the router beside `shadowFeedback`.
- Readout harness `scripts/validate-jev-readout.ts` for bars 1–3.
- The `looksSensitive` gaps (`clave del wifi`, dot-split token, ≥ 32-run
  rule on paths) — separate change with a corpus-replay fixture.
