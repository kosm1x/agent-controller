# Plan: settleable gate expectations (Honest-Done write-time refusal)

**Date:** 2026-09-12 · **Origin:** YOINK review (DefiLeoo/YOINK, "refuse a claim that
cannot be graded at the moment it is written") · **Status:** SHIPPED 2026-09-12 (see `v8.4-honest-done-spec.md` §15 for the as-built, incl. the R1 folds: stored-payload abandon mode, declareGates floor, lens-A bypass families). Deviation from §6: the counter lives in `src/lib/v8-4/gate-metrics.ts` (default registry), not in `prometheus.ts`, so `gates.ts` does not pull the observability module.

## The hole, measured on the live ledger (read-only, 2026-09-12)

`task_gates`, last 30 days: 41 plan shell gates, 20 ritual shell gates, 229 harness
readback gates (no `expect`, unaffected). The `expect` column is free text: a
substring or `/regex/` (`src/lib/v8-4/gate-check.ts:113 expectMatches`). The planner
prompt tells the LLM exactly that (`src/prometheus/planner.ts:42`), so it writes:

| expect | check | met by |
|---|---|---|
| `/[0-9]/` | `grep -c 'MODEL OUTPUT' …/w37.md` | the failure value `0` |
| `/[1-9]/` | `grep -h '^title' …/w3*.md` | any title containing a digit (w36 too) |
| `/[3-9]/` | `grep -cE 'Number of the Week\|…'` | count 3, or any 3–9 anywhere |
| `/^[1-9][0-9]*$/m` | `SELECT COUNT(*) …` (4 ritual rows) | any positive count |
| `/[4-9]\|1[0-9]/` | count check | 4, or the digit 1 followed by a digit |

25 of the 41+20 predicate-bearing gates use a digit-class-only regex. Five of those
were recorded `met`. This is the "verification that cannot fail" class
([[feedback_verification_that_cannot_fail]]) reaching the ENFORCE ledger:
`isLiteralSourcedCheck` already refuses `echo ok`-style checks at write time
(`gates.ts:173`), but nothing refuses an expectation that the failure output satisfies.

## The idea adopted

YOINK's `test:` field is a closed grammar (`gte N · gt N · lte N · lt N · eq N · neq N ·
between A B`) validated when the claim is written, with the refusal naming the rule
and the word that broke it. Port that shape onto `expect`, keep substring/regex for
text checks, and refuse the digit-only regex family. Allow-by-membership, not a
deny-list ([[feedback_flag_deny_list_never_converges]]): a regex is admitted only if
it names at least one literal non-digit token; a count is admitted only as a comparator.

## Scope (one session, ~250 lines + tests)

### 1. Grammar + evaluator — `src/lib/v8-4/gate-check.ts`
- `parseExpect(expect)` → `{kind:"cmp", op, a, b?} | {kind:"regex", rx} | {kind:"substring", s}`.
  Comparator regex: `/^(gte|gt|lte|lt|eq|neq)\s+(-?\d+(?:\.\d+)?)$|^between\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)$/i`.
- Comparator evaluation reads the **last non-empty line** of the check output; it must
  parse as a bare number (`Number()` on the trimmed line, finite). Anything else ⇒ gate
  `failed`, evidence `output is not a number: "<last line ≤80 chars>"`. Never a pass on a
  non-number, never a silent skip.
- `expectMatches` keeps substring/regex behaviour byte-for-byte for existing rows.

### 2. Write-time refusal — `src/lib/v8-4/gates.ts`
- `isUnsettleableExpect(expect): string | null` returns the reason or null:
  1. regex whose pattern, with anchors, quantifiers, groups, alternation, `\d` and
     digit-only character classes removed, contains no literal character ⇒
     `"expect /…/ is satisfied by any digit — for a count use gt 0 / gte N"`;
  2. regex or substring that matches the canonical failure outputs `""` or `"0"` ⇒
     `"expect matches the failure output 0"` (mutation-at-declaration);
  3. comparator that fails `parseExpect` (e.g. `goes up`, `gte`, `between 3`) ⇒
     `"'…' is not a test. Use gte 10, lte 3.5, gt 0, eq 1, neq 1, between 2 4, a substring, or /regex/"`.
- Wire it where `isLiteralSourcedCheck` is wired, same semantics per source:
  - `parseGateSpecs` (submission/ritual path): **throw** with the reason (caller already
    surfaces parse errors to the runner).
  - `gateSpecsFromGoal` (plan path): **abandon** the gate with `abandonReason` = reason,
    logged `[gates] … plan gate N abandoned — …`, so the surrender is visible in the ledger.
- Confirm in `ledgerVerdict` that an `abandoned` row neither passes nor demotes (it is
  the existing literal-sourced behaviour; pin it with a test).

### 3. Prompts — the producers, not just the validator
- `src/prometheus/planner.ts:42`: replace `"substring or /regex/ its output must contain"`
  with the grammar and the rule *"for a count (grep -c, wc -l, COUNT(*)) use gt/gte N;
  a /regex/ must name a literal word; /[0-9]/ is refused"*. Include one good and one
  refused example, YOINK-style.
- Ritual gate author: locate with `grep -rn "expect" src/rituals src/reactions` (the four
  `/^[1-9][0-9]*$/m` rows came from `source=ritual`); apply the same wording.
- Runner completion prompt that renders `[manual — state the evidence…]` (`gates.ts:481`)
  is unchanged.

### 4. Corpus replay before shipping ([[feedback_corpus_replay_before_shipping_a_text_filter]])
- `scripts/replay-gate-expects.ts`: opens `data/mc.db` read-only, runs
  `isUnsettleableExpect` over every `task_gates.expect`, prints `would refuse / would keep`
  per row with reason. Expected on today's ledger: the 5 plan rows above + the 4 ritual
  rows refused; every `Plan de Acción`, `200`, `verify`, `/Avg Δ/`, `/[0-9a-f]{7}/` row
  kept; 229 harness rows untouched (no expect). Any other refusal = the rule is wrong,
  fix the rule, not the row.
- Re-evaluate the 5 `met` weak rows' recorded check output (if `evidence` kept it) with
  the comparator the planner should have written; report which would have failed.

### 5. Tests (scoped runs only; pre-commit hook is the one full run)
- `gates.test.ts`: refusal table (the 5 live patterns RED, 6 legitimate patterns GREEN),
  plan path abandons with reason, submission path throws, abandoned row neither passes
  nor demotes.
- `gate-check.test.ts`: every comparator op, `between` inclusive, last-line rule,
  non-number output ⇒ failed with evidence, float/negative, `1e3` rejected or accepted
  (decide: accept only plain decimals).
- Mutation pin: `expect /[0-9]/` + output `0` must be **refused at write time**, and
  `gt 0` + output `0` must be **failed** at check time.

### 6. Observability
- Counter `mc_gate_refusals_total{source,reason}` in `src/observability/prometheus.ts`
  incremented from the two refusal sites. No alert rule yet.

### 7. Docs + memory + commit
- `docs/planning/v8.4-honest-done-spec.md`: addendum "expect grammar" + refusal table.
- `docs/PROJECT-STATUS.md` row, `docs/planning/next-sessions-queue.md` (close the item),
  `CLAUDE.md` gate-authoring note if one exists.
- Memory: extend [[feedback_verification_that_cannot_fail]] with the class
  "digit-class regex on a count"; `reference_agents_best_practices` sibling note pointing
  at YOINK as the origin.
- Ship via /ship-it: implement → scoped tests → qa-auditor (R1, 3 parallel) → fold →
  docs → commit → push. Deploy is operator-only:
  `cd /root/claude/mission-control && ./scripts/deploy.sh`.

## Blast radius ([[feedback_structural_rule_blast_radius]])
Populations served by `expect`: plan gates (~1.4/day), ritual gates (~0.7/day), submission
gates (0 in 30 days). A refusal converts a can't-fail gate into a visible `abandoned`
row; it never fails a task by itself. (R1 found the ritual path would have dropped the whole
array silently — folded, see spec §15.) Harness readback gates carry no `expect` and are
untouched. Rollback = revert the two wiring lines; the grammar evaluator is additive.

## Not in scope (queue if wanted)
- A `confidence` on gates + Brier per runner/variant (YOINK's scoreboard). Needs the
  producer to emit a probability first; separate decision.
- Dead-note metric on jarvis-kb from task-trace file reads. Probe first.
- Settleable claims for williams-entry-radar / JME signals — different repos.

## Verification after deploy
1. `journalctl -u mission-control --since "10 min ago" | grep '\[gates\]'` shows a
   refusal with reason on the next planned goal that writes a digit-only regex.
2. `sqlite3 -readonly data/mc.db "SELECT expect, abandon_reason FROM task_gates WHERE created_at > datetime('now','-1 day')"`
   shows no new `/[0-9]/`-class row in state `met`.
3. `curl -s localhost:8080/metrics | grep mc_gate_refusals_total`.
