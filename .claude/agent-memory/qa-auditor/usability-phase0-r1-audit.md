# Usability plan Phase 0 — R1 audit (2026-08-23)

Bundle: `deliverable-filter.ts` + router wiring (3 seams) + `rituals/delivery-policy.ts` +
cron moves + `dynamic.ts` pause sentinel + `prompt-sections.ts` WA-conditional +
`scripts/usability-metrics.ts`. Plan: `docs/planning/jarvis-usability-plan-2026-08-22.md`.

**Verdict R1: FAIL — 3 Critical.** tsc clean, 82/82 new tests green. The tests are green
*because every fixture is hand-written*; running the SAME functions over the real
`mc.db` corpus flips three of them.

## Doctrine earned

1. **A text-sanitizer must be scored against the CORPUS it was built from, not fixtures.**
   379 real chat replies (30d) through `sanitizeDeliverable`: 153 altered (40 %), 116
   narration peels, **7 mid-token truncations** (`"Voy a leer el index.html para…"` →
   delivered `"html para tener el nav…"`). The sentence regex ends at the first `.` and
   `index.html` contains one. A `[^.!?\n]` sentence terminator over Spanish tech prose is
   a filename bomb. Corpus-replay is cheap: `sqlite3 -json` + a 20-line tsx script.
2. **A "reserve" that disables a guard is not a guard.** `reserve = failureKind ? 100 : 0`
   with the break test `rest.trim().length + reserve < 80` makes the "≥80 chars of content
   must remain" rule VACUOUS on exactly the replies that carry a partial answer — the
   whole partial gets peeled and only the generic Spanish line ships. Guard constants that
   appear on BOTH sides of a comparison need a case where the guard still fires.
3. **A change-only gate must be run over the real reports before shipping.** All 6 live
   PM reports (08-17→08-22) return `deliver=true`: 3 via `reason:"error"` because the
   report says *"Sin stale-position abort"* (the ERROR_RE word `stale` is in the ritual's
   own prompt: "Alertas: (stale markets, …)"), 3 via `reason:"changed"` because the
   fingerprint scrapes prices/dates (`0.02|0.98`, `2028`, `-08|-20`) out of the Alertas
   line. Suppression rate on the population it was built for: **0/6**.
4. **A sentinel with no producer is a dormant row.** `[PAUSAR-SCHEDULE]` exists in the
   consumer (`dynamic.ts:712`), the stripper and two tests — and in NO prompt. `sqlite3
   "SELECT description LIKE '%PAUSAR%' FROM scheduled_tasks"` = 0 for Química. 4th
   recurrence of the producer-token class.
5. **A cleanup filter placed on the delivery seam eats router-authored diagnostics.**
   `broadcastToAll` now sanitizes: a scheduled-task FAILED alert carrying the real
   `API Error: 400 Output blocked by content filtering policy — …` is truncated to
   `FAILED:` + a generic Spanish retry line. `API_ERROR_RE` / `AUTH_FAILURE_RE` eat to
   end-of-line (`[^\n]*`), so they delete the CAUSE and keep the code.
6. **When a filter moves between producer and consumer, the KPI must move with it.**
   `scripts/usability-metrics.ts` reads `tasks.output.text` (pre-filter) for
   `harness_strings_delivered` → the number can never reach its target 0 even when the
   filter works perfectly. The post-filter text lives in `conversations` (`Jarvis:` half).
7. Double-subtraction check on any "minus the suppressed" metric: `delivered` already
   excludes the suppressed titles by regex, then `- silenced` removes them again.

## Stable facts (verified 08-23)

- `getDatabase()` THROWS when uninitialised → importing `src/rituals/delivery-policy.js`
  from a scratch tsx script is safe (pure fns usable, no DB opened).
- `vitest.config.ts` has `globals: true` — an unimported `afterEach` still runs.
- `tsconfig.json` include is `src/**/*.ts` only → **`scripts/*.ts` is never type-checked**
  (confirms the older `v82-combinator-r3` note).
- Real ritual task titles are `"Evolution log — YYYY-MM-DD"`, `"Day log narrative — …"`,
  `"PM daily rebalance — …"`, `"Nightly close — …"`.
- Unfiltered LLM delivery seam that Phase 0.1 did not cover: `sendBriefingToOwner`
  (briefing/delivery.ts, scheduler notifyRitualFailure, prometheus-alert-poller,
  x-poster probe-cron).
