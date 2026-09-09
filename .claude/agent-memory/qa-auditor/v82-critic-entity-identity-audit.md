---
name: v82-critic-entity-identity-audit
description: V8.2 §11 critic VERIFICATION DISCIPLINE prompt fix for sibling-name false-contradiction (judgment 19 vlcms/vlmp) (2026-06-27)
metadata:
  type: project
---

# V8.2 §11 CRITIC — entity-identity / deterministic-figure prompt fix (2026-06-27)

Verdict: PASS WITH WARNINGS. Files: src/lib/v8-2/critic.ts (CRITIC_SYSTEM_PROMPT_V1 +3 lines, 104-106), critic.test.ts (+describe block, presence-only toContain).

Bug class: a tri-state LLM verifier (approved/needs_revision/unfixable) marked a TRUE deterministic-detector figure ("VLMP absent ≥27d per stall detector") `contradicted`/unfixable because it read a "Very Light **CMS**" (vlcms) day-log row as evidence for "Very Light **Media Player**" (vlmp) — name-prefix sibling conflation, then overturned the exact figure with a fuzzy LIKE hit. Confirmed: day-log row has_vlcms=1, has_vlmp=0; vlmp real last-mention 2026-05-27 = exactly 27d.

DOCTRINE (entity-conflation in an LLM verifier):
- Fix at the REASONING/PROMPT layer, tool-agnostic — NOT by narrowing the query tool. The conflation happens AFTER the rows return (mis-attribution), so a perfectly-scoped query still needs the LLM to attribute correctly. Rule covers sql_check(LIKE) + recall_check(FTS) + any future over-matching tool. Narrowing sanitizeFtsQuery (OR→AND/phrase) would (a) not fix the demonstrated sql_check path, (b) regress recall_check's intended breadth. Leaving sanitizeFtsQuery untouched = DEFENSIBLE & correct layer. (`sanitizeFtsQuery` critic.ts:307-311 ORs alnum tokens → "very light media player" matches a vlcms row on very/light; both tools return path/title so the LLM HAS the info to discount — rule 1 is actionable.)
- ASYMMETRY is the right default for a verifier of a deterministic producer: "false contradiction of a TRUE claim is the costlier error." Bias toward trusting the deterministic figure over a fuzzy rebuttal.

HOLES found (all WARNING, none blocking):
1. HEADLINE > BODY scope creep. Rule 2 header "DETERMINISTIC FIGURES OUTRANK A KEYWORD SCAN" + "treat the deterministic figure as correct" is broader than its tightly-scoped body ("ONLY if it lands on the EXACT subject entity AND inside the claimed window"; "looser LIKE/FTS keyword scan"). Sits in mild tension with the prompt's own "you do NOT defer to its confident tone" (94) and "only the tool results are evidence" (113). A literal model may over-generalize the header to soften skepticism on NON-fuzzy checks. Body mitigates; reframe header as "a FUZZY hit does not outrank a deterministic figure" (discount-bad-evidence framing, not claim-outranks-tool ranking).
2. TEST PINS HEADLINE, NOT THE SAFETY CONDITIONAL. The 5 toContain assert presence of "VERIFICATION DISCIPLINE"/"ENTITY IDENTITY"/the vlcms-vlmp sentence/"DETERMINISTIC FIGURES OUTRANK A KEYWORD SCAN"/"costlier error" — but NOT "ONLY if it lands on the EXACT subject entity AND inside the claimed window," the clause that prevents blanket suppression (under-flagging real contradictions). A future "simplify" that strips the conditional → critic rubber-stamps → tests stay green. Add an assertion pinning the conditional.
3. Presence-only test = guards deletion, not BEHAVIOR. SDK is mocked everywhere (CLAUDE.md: never call real LLM in tests); fix efficacy unverified until an offline replay of judgment-19 asserts critic does NOT mark it contradicted. Recommend a scripts/validate-*.ts eval, not a unit test.

SCOPE: source clean — only the prompt string + its test (no tool/schema/loop/contradiction-write change). Working tree ALSO carries unrelated docs/EVOLUTION-LOG.md daily-log appends + qa-auditor MEMORY.md reformat → commit the critic fix surgically, don't bundle.

## Rule-3 addendum (2026-07-01) — "0-ROW QUERY IS NOT PROOF OF ABSENCE" + sql_check SCHEMA NOTE

PASS WITH WARNINGS. Prompt-only: added rule 3 to VERIFICATION DISCIPLINE (self-authored 0-row query ≠ absence; every ledger ref EXISTS by construction; tasks key on `task_id` TEXT UUID not integer `id`) + extracted `SQL_CHECK_TOOL_DESCRIPTION` const (byte-identical prefix + appended SCHEMA NOTE, verified via git diff) + presence-only tests. Fixes judgment 32 (critic queried `tasks` by int `id` for 10 real `task_id` UUIDs → 0 rows each → falsely called whole ledger nonexistent → unfixable).

OVER-SUPPRESSION CLEARED (the real risk): rule 3 does NOT rubber-stamp. Scoped to "0 rows" only — value-contradiction (status=blocked vs claim completed) and aggregate count=0 are both 1-ROW results (`runReadOnlySelect` critic.ts:233 prefixes `1 row(s):`), so rule 3 never fires on them → still catchable. "EXISTS by construction" VERIFIED against the producer decompose.ts:320-341 (`id: r.task_id` from `SELECT task_id FROM tasks`) → a correct `WHERE task_id=` always re-finds the ref → sound, not merely convenient. Safety valve present ("re-query with the right column, or let the ledger ref stand"). SCHEMA NOTE accurate vs live schema (`tasks.id INTEGER PK`, `task_id TEXT UNIQUE`); UUID literal isn't a well-formed number so `id='<uuid>'` → 0 rows (the exact j32 mechanism).

W1 (RECURRENCE of HOLE #2 above, now for rule 3): tests pin headline / `keys on "task_id"` / `EXISTS by construction` but NOT the scope-limiter `on the strength of a 0-row result` nor the valve `re-query with the right column, or let the ledger ref stand`. Drop those 6 words in a reword → blanket "never mark a cited task contradicted" → suppresses value-contradictions, suite stays green. Add `toContain("on the strength of a 0-row result")`. DOCTRINE CONFIRMED 2×: for a tri-state LLM verifier, always pin the scope-limiter clause, never just the headline.

Info: (I2) SCHEMA NOTE/parenthetical name only `tasks`; ledger ALSO carries `kb_entry` refs where ref.id=path but `jarvis_files.id` is a separate TEXT key (same key-column trap, LIVE now); `general_events`(id INT/event_id TEXT) + `recurring_blockers`(id INT/signature TEXT) same shape, not in ledger yet — rule 3's GENERAL clause "most often the KEY COLUMN" covers them, extend note when a phase widens the ledger. (I3, pre-existing) `northstar` in SQL_CHECK_TABLES + advertised in description but NO such table (NorthStar lives in jarvis_files/NorthStar/); `FROM northstar` → "no such table" error (not 0 rows, so rule 3 safe).

STALE-CORRECTION to the 2026-06-27 note above: critic is NO LONGER dormant — `produce.ts:262` wires `runCriticLoop` (V8.2 SHADOW). Verdicts are live in shadow (that's where judgment 32 came from); brief DELIVERY is still gated. So this prompt edit DOES change real shadow-critic behavior post-deploy (intended) + re-caches the tools-block prefix once (negligible).
