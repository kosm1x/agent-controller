# perf/usefulness batch D6/D13/D5/U10/U16/U7 — R1 (2026-09-10)

**Verdict: FAIL — 3 Critical.** tsc exit 0; 7 files / 235 tests pass. HEAD 4b353ac, uncommitted.

## C1+C2 — U7 `isFailureNotice` is INVERTED on the live corpus
`src/rituals/delivery-policy.ts:326-328` + call site `:489`.
Replayed the regex over ALL 36 `ritual_deferrals` rows with `reason='budget'` (all inside 30d).
- **0 of 5 genuine failure notices rescued.** The motivating case named in the fix's own JSDoc
  (id=64, @MexicoNecesario tweet, `❌ Error al publicar` + `post failed on all backends` + `code 226
  flagged_automated`) is stored at **179 words** → `countWords<=120` FALSE → still deferred.
  Same for id=44 (❌,243w), id=40/35/17 ("ERROR",199/195/213w).
- **The 1 row that flips is a false positive**: id=47, a `signal-intelligence` SUCCESS digest
  ("✅ Inteligencia del día completada … 9 señales") whose narration says "The digest storage
  **failed** because 'intelligence' isn't a valid category — I'll store it under 'projects'".
- **Why**: the budget check runs AFTER `capWords(text, EMAILED_PUSH_WORD_CAP=120)`. On the emailed
  path `text` is ≤120w BY CONSTRUCTION, so the word bound can never bind and the predicate degenerates
  to "contains error|falló|failed|❌ anywhere". id=47 was a long digest capped to 114w, then matched.

**CLASS (new): a length bound placed DOWNSTREAM of a truncator is inert.** Before trusting
`countWords(x) <= N` as a discriminator, find every cap/truncate that rewrites `x` earlier in the
same function and compare N to that cap. Here N=120 == EMAILED_PUSH_WORD_CAP=120 exactly.

**CLASS (reconfirmed, 3rd time):** fixtures lie — the shipped test used a hand-written 15-word
Spanish string that resembles no live output. The live corpus inverted the verdict.

## C3 — D5 docstring "every consumer reads ≤90-day windows" is FALSE
`src/db/retention.ts:92-93`. recall_audit spans 2026-04-29 → now (134d); first sweep drops
**2,284/7,101 (32%)**. Unbounded (NO window) readers:
- `mc-ctl:2875-2877` `recall-modes`: `FROM recall_audit GROUP BY mode` — all-time.
- `mc-ctl:1809-1812` `jme-stats`: 4× `COUNT(*) WHERE source='jme'` — all-time. jme min=2026-07-14
  so 0 rows lost TODAY; starts losing **2026-10-12**.
- `mc-ctl:1753` `jme-signals`: weekly GROUP BY over all history, and its printed success criterion is
  "4-week rate >= 30% below **the first 4 weeks**" — the denominator is recall_audit (pruned), the
  numerator `jme_signals` is NOT pruned ⇒ baseline weeks become signals-over-nothing.
- `parseWindow` (`src/audit/self-audit.ts:270`) accepts any N ⇒ `audit-claim --window=180d` is >90d.

**CLASS: "every consumer reads ≤Nd" is a CLAIM about a shell script too.** grep mc-ctl/scripts, not
just src/. The dangerous readers are the ones with NO window clause at all — they don't grep as "days".

## Verified-good (don't re-litigate)
- **D6 correct.** OLD `splitSystemMessagesByCache` (fast-runner.ts:48-61) put the catalog in
  `stable` ⇒ it sat at the TAIL of systemPrompt, exactly where the SDK's single `cache_control`
  marker goes ⇒ any scope change busted the 45K KB prefix. NEW: joins the 4 existing `cacheable:false`
  blocks, prepended to userParts (`:1304`), still before every conversation turn.
- **D13 boot-set guaranteed** by `embedCountSampledAt = 0` (prometheus.ts:384); timestamp assigned
  AFTER the query so a throw retries next scrape.
- **D5 write-lock is a non-issue — MEASURED.** `sqlite3 -readonly mc.db ".backup copy.db"` then timed
  both DELETEs on the 369 MB copy: **114 ms** for 6,845 rows. Both use the created_at index
  (EXPLAIN QUERY PLAN → `SEARCH … USING INDEX idx_recall_audit_created`). No batching needed.
  Real shares: recall_audit 32%, scope_telemetry 4,561/8,264 = 55% (brief guessed ~70%).
- Budget-exempt delivery still calls `recordRitualDelivery(deliver:true)` ⇒ words counted, no ledger
  drift. Mute is checked BEFORE the budget branch (`:479`) ⇒ failure notices still muteable.
- `mc-ctl:56-63` `api()` DOES send `-H "X-Api-Key: ${key}"`.

## Unpinned folds (all 3 revert GREEN)
- D6: deleting `cacheable:false` at fast-runner.ts:1010-1013 → 235/235 still pass. Worse,
  `fast-runner.test.ts:1346-1350` still asserts `result.stable).toEqual(["essentials","deferred tool
  catalog"])` — it passes only because its fixture omits the flag, and now documents the OPPOSITE.
- D13: `prometheus.test.ts` (22 tests) has zero `collectMetrics`/embeddings coverage.
- U10: `source.test.ts:70/:88` expect `totalTools` 3 and 1 — mock sources report the same count the
  mock registry holds, so BOTH implementations pass. Vacuous w.r.t. the change; no new test.
  Also `void totalTools;` (source.ts:100) silences a var instead of removing it (umbrella CLAUDE.md
  orphan-cleanup); better: log the `totalTools !== registry.list().length` delta — that IS the U10 signal.
