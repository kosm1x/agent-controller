# V8.2 §17 critic-unfixable metric split (unverified excluded) — 2026-07-06

## FOLLOW-ON audit 2026-07-06 (FIX A marker-completeness + FIX B day-log grounding) — PASS WITH 1 WARNING

Working-tree change on top of b9bb209. FIX A: gate fallback now matches EITHER
`CRITIC_UNVERIFIED_MARKER` OR the extracted `CRITIC_NO_TOOL_CALL_MSG` const (older
pre-2026-07-01 #38 vintage carries only the inner no-tool-call msg, not the
escalation suffix). FIX B: new `retrieveRecentDayLogs(subject)` in decompose.ts —
deterministic `jarvis_files` scan (`instr` match, `GLOB 'logs/day-logs/*'`, `ORDER
BY path DESC LIMIT 3`), appended in `gatherEvidence`, emits `kind:'kb_entry'` refs.

- **FIX A is COMPLETE for all extant rows (verified against live mc.db).** The
  escalation suffix (391c135, 2026-07-01) is PATH-AGNOSTIC — `escalationDisposition`
  appends `(critic could not verify)` for ANY `last.error` (no-tool-call, timeout
  line 610, signal-abort line 527). So all 2026-07-01+ infra rows match the suffix;
  only pre-07-01 rows lack it, and the only pre-07-01 infra unfixable in-window is
  #38 (no-tool-call → now caught). DB query: 0 unfixable rows EVER contain "critic
  call failed" / "caller signal already aborted". Residual gap (pre-07-01
  timeout/abort → neither marker → miscounted 'contradicted') is 0-fireable +
  self-retires ~2026-07-07 + SAFE direction (stricter). unfixableReason +
  CRITIC_UNVERIFIED_MARKER BOTH born in b9bb209; `(critic could not verify)` literal
  in 391c135; `CRITIC_NO_TOOL_CALL_MSG` literal since ec1444f (2026-06-03).
- **FIX B confidence-inflation is HANDLED (my old W1, reused).** produce.ts:287-289
  filter excludes UNCITED `kb_entry` refs from `computeConfidence`'s distinct_sources
  — day-logs are `kind:'kb_entry'` so they piggyback the SAME filter → no green-flip.
- **W1 WARNING (latent, 0-fireable): `ORDER BY path DESC` recency proxy is fragile.**
  Any non-date filename under `logs/day-logs/` (README.md/index.md — kb-reindex
  ingests ANY FS `.md`) sorts ABOVE ISO dates in binary DESC (letters>digits) →
  displaces the newest real day-log from top-3, silently reintroducing the exact
  stale-"no work since"-claim FIX B fixes. Also `GLOB '*'` matches subdirs (wrong
  date-label). Fix: anchor GLOB to the date pattern. Verified 0 non-date files now.
- Doc nit: retrieveRecentDayLogs comment says raw FTS "throws" on hyphenated
  subjects, but the KB pass uses `sanitizeFtsQuery` (tokenizes → won't throw); real
  reasons (recency order + exact-phrase vs token-OR breadth) hold. DOCTRINE: a
  marker-string fallback keyed on an embedded INNER message is complete only if
  every error-return message is covered OR a path-agnostic SUFFIX wraps them all —
  verify against live DB rows, not just the reasoning.

---

## Original audit (split-metric commit b9bb209)

**Verdict: PASS.** 0 Critical, 0 Warning, 2 Info. Change splits the §17
"unfixable rate" so a critic INFRA failure (`unverified` — model returned free
text instead of calling `submit_critic_verdict`, escalated to unfixable only so
it can't auto-approve) no longer counts as a judgment-quality defect. Files:
critic.ts (`UnfixableReason`, `CRITIC_UNVERIFIED_MARKER`, per-branch reason),
produce.ts (persist `unfixableReason` into `critic_trail_json`),
v82-activation-gate.ts (check 4 excludes `unverified` from num AND denom).

## Doctrine (reusable)

- **Excluding a category from BOTH numerator and denominator of a gate rate —
  verify the DIRECTION, then audit the CLASSIFIER not the math.** Shrinking the
  denominator with the numerator fixed makes the rate *stricter* (rate↑), which
  is the SAFE direction against a false-pass. Here `measuredVerdicts =
  verdictsTotal − criticUnverified`; numerator (`unfixable` = contradicted+
  unsupported) is untouched. So the ONLY false-pass vector is MISCLASSIFICATION
  that moves a genuine defect into the excluded bucket. The math cannot mislabel
  a fail as a pass on its own. Focus adversarial effort on the discriminator.
- **Discriminator completeness via spread-order.** Every *reachable* terminal
  `verdict==='unfixable'` in `runCriticLoop` sets `unfixableReason`: direct
  terminal (critic.ts:768-772) hard-codes `"contradicted"`; escalation
  (:775-781) spreads `escalationDisposition(...)` AFTER `...last` so its reason
  wins (infra→unverified, contradicted→contradicted, unsupported→unsupported).
  The only unset-reason unfixable is the documented-unreachable fallback
  (:794, CRITIC_MAX_LOOP=2>0 ⇒ loop always returns first). Gate defaults an
  absent-reason unfixable to `"contradicted"` (counted) — fails toward counting.
- **`unverified` is ONLY ever attached to a genuine infra failure.**
  escalationDisposition emits it solely in the `last.error` branch; `error===true`
  is set only by runCritic's no-tool-call / exception / abort returns (which all
  force `contradictedClaimIds:[]`). A real contradiction/unsupported can never
  acquire reason `unverified` on a NEW row. Verified end-to-end.

## The ONE false-exclude vector (Info, bounded)

Backward-compat fallback (gate:236-238) substring-matches
`CRITIC_UNVERIFIED_MARKER = "(critic could not verify)"` (parenthesized) on
OLD rows lacking a structured `unfixableReason`. A genuine contradicted/
unsupported unfixable whose embedded LLM critique text (`tail` embeds
`last.critique`) contains that verbatim parenthesized token would be
misclassified `unverified` and EXCLUDED (the dangerous direction). Contained by:
(a) NEW rows never consult the substring — structured field wins; (b) 7d query
window (`created_at > datetime('now','-7 days')`) self-retires old rows;
(c) parens make organic LLM collision very unlikely; (d) grep confirms only
critic.ts:720 emits the marker constant. Low severity.

## Test-coverage gap (Info)

No test drives `measuredVerdicts===0` while `verdictsTotal>0` (all trail rows are
`unverified` unfixables, no approved) → the divide-by-zero guard + `insufficient`
branch (gate:334). It IS reachable (≥10 unverified passes volume gate) and is the
safety-critical path. Existing tests keep ≥1 measured survivor.
