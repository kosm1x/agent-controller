# V8.3 Phase 7 — §14 v1 activation gate audit (2026-07-06)

**Bundle**: `src/lib/v8-3/activation-gate.ts` (`evaluateV83Gate`), `scripts/v83-gate.ts` + `mc-ctl v83-gate`, `activation-gate.test.ts`. Read-only readiness gate (mirrors V8.1 §13 / V8.2 §17). Gates operator's first L1→L2 promotion decision. NOT an execution-path gate.

**Verdict: PASS — 0 Critical, 0 Warning, 3 Info.** tsc clean; 7/7 gate tests green.

## DOCTRINE (new, load-bearing) — SYMMETRIC datetime() wrapping is the CORRECT fix
The 3 decision queries use `datetime(proposed_at) > datetime('now','-7 days')` — BOTH sides wrapped. `proposed_at` is stored ISO (`new Date().toISOString()` → `...T..Z`, decisions-store.ts:77). This is the OPPOSITE of the asymmetric-datetime FP class in prior audits (v83-phase6, v82-section17): here symmetric wrapping is REQUIRED and correct.
- Empirically verified: the spec's LITERAL query (line 439, `proposed_at > datetime(...)`, proposed_at UNWRAPPED) is BUGGY for ISO storage — a same-date-earlier-time decision (`2026-06-29T08:00Z` vs cutoff `2026-06-29 19:20`) returns in_window=1 (WRONG) because ISO `T` (0x54) > space (0x20) at char index 10 beats the time comparison. The impl's `datetime()` wrapping normalizes both to `YYYY-MM-DD HH:MM:SS` UTC → correct in_window=0. **The implementation is MORE correct than the spec SQL it implements.**
- TZ-safe: SQLite `'now'` is always UTC regardless of `TZ=America/Mexico_City`; `toISOString()` is UTC. Both sides UTC. No skew.

## Focus answers
1. **Verdict precedence CORRECT.** Breach (checks 5/6 fail) → fail even on thin shadow — correct because checks 5/6 count ACTUAL in-window bad rows (L≥3 with judgment_id NULL / reversal_op NULL); one existing bad row = real regression of the Phase-6/Phase-3 gates, volume-independent. Missing substrate (schema/dep/seed) → fail (misconfig, not "keep waiting"). No low-data state misclassifies as fail: empty/quiet ledger → checks 5/6 count 0 bad rows → trivially pass → falls through to shadowVolume<7 → insufficient_data. Cadence-trap honored.
2. **Six queries faithful to spec (lines 427-449).** Shadow floor `>= 7` (no off-by-one: ===7 pass, 6 insufficient). Boundary `autonomy_level >= 3` correct (L≤2 allowed operator-pull/irreversible per R2 #9 — not flagged). Check 6 reduces spec's GROUP BY to `COUNT(level≥3 AND reversal_op_json IS NULL)===0` — faithful to intent.
3. **datetime windowing CORRECT** (see doctrine). Today counts, 8-days-ago doesn't. No lexical bug.
4. **Empty-ledger false-pass PREVENTED.** 0 decisions → checks 5/6 trivially true (intended: no bad decisions ⇒ no breach) but shadowVolume floor blocks pass → insufficient_data. Live-verified fresh ledger → insufficient_data.
5. **Tests exercise every verdict path** (insufficient / pass / substrate-fail / linkage-breach-fail / reversibility-breach-fail / windowing×2). Breach tests properly ISOLATED (test 5 links a REAL judgment via seedJudgmentId so linkage passes, isolating the §7 reversibility breach). None pass for the wrong reason.

## INFO (non-blocking)
- **I1 — substrate-fail path partially throws instead of clean-fail.** If `capability_autonomy`/`decisions` tables are ABSENT, `evaluateV83Gate` throws at the seeded/shadow queries (activation-gate.ts:90/99) BEFORE the verdict — the docstring's "missing schema → fail" (lines 135,140) is unreachable-as-designed. In practice ZERO risk: `ensureV83Tables` runs unconditionally at `initDatabase` (db/index.ts:1092) + `seedV83Capabilities` at index.ts:239, so tables always coexist; `schemaPass`/`depPass` are effectively always true in any DB that went through initDatabase. Only `seededPass` (table present, wrong count) realistically flips. Decorative defensive checks, not a live bug.
- **I2 — test-coverage**: no test independently flips `schemaPass=false`/`depPass=false` (only `seededPass=false` covers the substrate-fail branch). Same OR-branch, and schema/dep can't be made false in `:memory:` post-initDatabase without dropping tables. Low value.
- **I3 — benign teardown noise**: `[jarvis-index] Failed to regenerate INDEX.md: Database not initialized` prints during the run — pre-existing `closeDatabase()` side-effect in all v8-3 tests, cosmetic.

Gate script = same `initDatabase(DB_PATH)` pattern as established `briefing-gate.ts` (idempotent CREATE IF NOT EXISTS + user_version-gated migrations; writes nothing new on the live DB). Exit codes 0/1/2 = pass/fail/insufficient, match docstring.
