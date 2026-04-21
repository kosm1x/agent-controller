---
name: v7.3 P4a Digital Marketing Buyer audit
description: v7.3 Phase 4a ads tooling (ads_audit/brand_dna/creative_gen + checks/frameworks/benchmarks refs) round-1 audit findings
type: project
---

**Verdict: PASS WITH WARNINGS.** 0 critical, 3 MAJOR, 8 MINOR, 5 warnings.

Commit adds 3 deferred tools + ads-references library (~70 checks, 6 copy frameworks, ~70 benchmark rows), additive schema (`ads_audits`, `ads_brand_profiles`, `ads_creatives`), scope regex + classifier group.

**Why:** clean-room port of claude-ads; first real LLM-content-in-LLM-prompt attack surface in this codebase; scope regex extended bilingual EN+ES with intentionally excluded `PAS`.

**How to apply:** when ads tools come back for P4b (credentialed API clients) or when any tool loads untrusted fetched content into a persist-then-consume pipeline, re-check:

1. **Scope regex 3-letter acronyms need trailing `\b`** — bare `|AIDA|BAB|FAB|` in an alternation inside `\b(...)` with `/i` flag fires on `fab`/`bab`/`aida` as substrings of common English (`fabric`, `fabulous`, `baby`, `babysitter`, `aidalicious`). Author comment said "negligible collision risk" — wrong. This would have silently burned the 52% prompt-token cut from deferral on common chat turns.

2. **Prompt-injection laundering** — `ads_brand_dna` fetches untrusted URL → LLM → persisted `profile.keywords_lexicon`/`avoid_lexicon` → `ads_creative_gen` reads by `brief_id` → injected verbatim into downstream prompt as `"USE these words: {list}"`. Hostile site can write attacker-controlled instructions that arrive in the 2nd LLM call as system-level directives. Fix at storage boundary (per-entry length cap, drop `:`/`"`/`\n`/`http`/imperative verbs) not the prompt — same lesson as feedback_extractor_self_reflection_loop.

3. **`String.prototype.replace` `$`-substitution footgun** — `template.replace(/\{\{X\}\}/g, value)` interprets `$&`, `` $` ``, `$'`, `$1..$9` in `value`. No captures → `$1..$9` collapse to empty (silent data loss); `$&` re-inserts the literal placeholder. `offer` commonly contains `$` (prices: "$49/mo"). Fix: replacer function `() => value` OR `replaceAll("{{X}}", value)` with string needle (neither interprets `$`).

**Positive confirmations (no regression of prior patterns):**

- `validateOutboundUrl` used correctly — direct return-value check, no try/catch wrapper (per feedback_validate_outbound_url_pattern)
- SQL all parameter-bound via `better-sqlite3` `.run(?, ?, ...)` — no interpolation
- `foreign_keys = ON` enabled globally → `ads_creatives.brief_id REFERENCES ads_brand_profiles(id)` enforced
- `scoreAudit` divide-by-zero guarded (`max > 0 ? ... : 0`) and verified by test "excludes not-applicable checks from the denominator"
- `coerceAxis` / `coerceStringList` defensively narrow LLM output axes to 0-10 and lists to 20 entries

**Missing test coverage surfaced:**

- Zero scope-regex tests for the new `ads` group in `scope.test.ts` — m5 in report. Ship-blocker pattern per F9: enforcement mechanism needs a test that fires on the trigger event.
- No test that `ADS_TOOLS` emerges from `scopeToolsForMessage` when the ads regex matches — dead-wiring class bug.

**Other patterns worth remembering:**

- Double-counted checks across cross-platform + per-platform (`xp_audience_exclusions` vs `m_audience_exclusions` — identical logic, same severity). Fix: scope cross-platform check to exclude the per-platform'd platforms, or drop the per-platform duplicate.
- Hardcoded numeric thresholds (LinkedIn $150 CPA ceiling, Apple $5 CPA ceiling) shipped alongside an `industry-benchmarks.ts` table that could calibrate them per-industry. Leaving hardcoded is acceptable for v1 but document the calibration vs benchmark-driven tradeoff.
