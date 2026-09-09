# Jarvis exec-improvement Phase 0 + 1a audit (2026-07-04)

PASS WITH WARNINGS. 370/370 scoped tests green. Change = `concern_reason` enum column
on `task_outcomes` (Phase 0) + `BUILD_AUTHORING_RE` verb→build-noun scope rule (Phase 1a).

## Verified CLEAN
- INSERT 9-col/9-param positional map EXACT (task-outcomes.ts:52-67). Migration idempotent
  (try/catch on ALTER, index.ts:191-197) + fresh :memory: DB gets col (schema.sql exec at
  index.ts:46 runs BEFORE ALTER at :193). Physical order id..created_at,model_tier,concern_reason;
  OutcomeRow interface lists them before created_at — HARMLESS (better-sqlite3 keys by NAME, INSERT
  named). No ReDoS: BUILD_AUTHORING_RE `(?:\W+\w+){0,3}\W+` — \W/\w disjoint + bounded {0,3} = linear
  (8000-word pathological = 1.2ms). Final tools deduped `[...new Set(tools)]` (scope.ts:1491) so extra
  coding pattern entry can't dup CODING_TOOLS (activeGroups is a Set anyway).

## DOCTRINE (reusable)
1. **Verb-alternation homograph FP**: a Spanish verb regex built by stemming picks up common
   homographs. `cre[oa]` (added for "creo la DB"=I-create) ALSO matches "creo que"=I-BELIEVE — the
   most common ES discourse marker. `corr[eo]\w*` (for "corre"=run) ALSO matches "correo"=email.
   Both then fire coding when any build noun (migración/schema/base de datos/código/sql) sits within
   {0,3} words. VERIFY every stemmed verb alt against its homograph before shipping.
2. **Polysemy noun without a domain anchor**: `código|code` in a build-noun set fires on código
   postal/de barras/de descuento/de verificación/de conducta, promo/QR/area code. On the SEMANTIC
   safety-net path (codingHit, scope.ts:1225) this is NEW over-fire (codingNounRe lacks bare
   código/code) and OVERRIDES a correct LLM negative. On the regex-fallback path código/code/sql
   already fire via the big coding regex (scope.ts:747) so no new FP there — always diff the NEW
   activation against what the SIBLING patterns already match before rating severity.
3. **A classifier that "runs regardless of status" pollutes the metric it exists to clean**:
   classifyConcernReason (concern-reason.ts:56) tests markers BEFORE the status gate, so a CLEAN
   `completed` success whose OUTPUT merely discusses "maximum number of turns" (chess Q) or
   "no tengo ... el scope del sprint" gets tagged max_turns/tool_scope_block. Natural-language alts
   (not the SDK-specific `error_max_turns` marker) are the FP surface. Phase 0's whole point is a
   trustworthy signal — content-FPs on success rows undermine it. Gate NL alts behind concern-status;
   keep the SDK marker unconditional.
4. **Both-path wiring, one-path test**: BUILD_AUTHORING_RE wired into BOTH the DEFAULT_SCOPE_PATTERNS
   regex-fallback entry (scope.ts:728) AND codingHit semantic path (scope.ts:1225), but every new
   test uses `scope()` = NO 5th arg = regex-fallback branch ONLY. The semantic path (PRIMARY in prod;
   router passes preClassifiedGroups) has zero BUILD_AUTHORING_RE coverage — a regression dropping it
   from codingHit stays green. Pattern recurs: when a shared const is referenced in 2 seams, the test
   helper usually exercises only one.

## Coverage boundary (Info, pre-existing)
recordOutcome/trackTaskOutcome called ONLY from router.ts (messaging). Rituals/scheduled tasks never
get a task_outcomes row → concern_reason baseline is messaging-only; Phase-0 "baseline reason
distribution for a week" is blind to ritual/scheduled concerns.
