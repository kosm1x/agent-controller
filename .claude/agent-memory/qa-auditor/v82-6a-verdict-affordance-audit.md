# V8.2 §17 6a — explicit-verdict affordance audit (2026-07-10)

Change: `classifyOperatorVerdict()` (promote.ts) makes a morning brief resolve
ONLY on an explicit verdict token; footer (render.ts) advertises "sirve/descarta";
6a gate (v82-activation-gate.ts) scores only status IN ('promoted','discarded'),
adds MIN_ACCEPTANCE_BRIEFS=3, redRate===0→Infinity, ACCEPTANCE_SINCE cutover.

VERDICT: FAIL (1 Critical). 0 model-prompt touch (eval:gate not needed — footer is operator-facing, regex deterministic).

CRITICAL — residual FALSE ACCEPT survives. `ACCEPT_RE = /\b(sirve|[uú]til|confirmo|ok|okay|dale|listo)\b/i`. Tokens `ok|dale|listo|confirmo` are everyday Spanish in messages unrelated to the brief. resolveBriefingOnOperatorReply runs on EVERY owner msg while a brief is pending+delivered → the first msg containing any token promotes it. Verified via node: "dale prioridad al CRM hoy", "listo, ya subí el sitio", "ok, mando el correo", "confirmo la reunión de las 3" ALL → promoted. This is the EXACT bug the change claims to kill; docstring "Deterministic…cannot false-positive" is FALSE. Tests deliberately pick token-free unrelated payloads ("subir el sitio de EurekaMS") so the path is untested.

DOCTRINE: "narrow the trigger to an explicit-token allow-list" only helps if the tokens are RARE outside the intended act. Generic confirmation/instruction words (ok/dale/listo/confirmo) recur in unrelated chatter → allow-list still over-fires. Same class as the verb-regex author-exclusion misses (code-read-explain-guard, phase0-1a-concern-buildauth). The right fix binds resolution to a REPLY-TO-THE-BRIEF signal (promoted_by_message_id / in-reply-to / a brief-scoped confirm affordance), not a keyword scan of arbitrary messages.

INTERACTION (Warning, Q7): §13 morning promote-rate check (activation-gate.ts:224-248) = promoted/generated over 7d, threshold ≥60%. Stricter promotion → most briefs expire/pending → promoted count collapses → §13 flips PASS→FAIL (measurable because expired>0, so NOT insufficient_data). The ONLY thing propping promote-rate up now is the finding-1 false-accepts. Fixing Critical worsens §13. Root: §13's 60% threshold was calibrated under old "any reply promotes" semantics; both metrics measured engagement, not endorsement. Live DB 2026-07-10: morning 7d = 6 promoted/1 discarded (85.7%, passes today); regresses over next 7d.

Warning — accented "útil" standalone → null. ASCII `\b` before non-ASCII ú never fires (no u-flag), so `\b[uú]til` can't match "útil" at a space boundary. "útil la info" → null (stays pending). The orthographically-correct spelling silently fails to accept; "util" (no accent) works. `\b`-vs-accent miss, recurring class.

CLEARED: Q3 expiry order correct (expiry branch precedes verdict gate, promote.ts:249; sweep covers never-replied). Q4 SINCE sound — symmetric datetime() both sides, no permanently-empty set, non-binding after 2026-08-09. Q5 Infinity: no Prometheus/API consumer (grep clean); only scripts/judgments.ts:67 prints "Infinity×" (cosmetic); briefing-gate detail handles ∞. Q6 insufficient_data (not fail) on promoteRatio===null confirmed honest. Q2 per-msg classify call is pre-existing (old code same), 0 calls in prod (countJudgments===0).

## R2 (2026-07-10, after fixes) — PASS WITH WARNINGS

Fix replaced substring allow-list with WHOLE-MESSAGE anchoring: VERDICT_STRIP_RE(\p{P}\p{S},u)+COURTESY_RE strip, DISCARD_WHOLE_RE / ACCEPT_WHOLE_RE anchored ^...$, dropped ok|dale|listo|confirmo. §13 promoteRatePct now promoted/ruled (ruled=promoted+discarded), expired no longer measurable→all-expired=insufficient_data not fail. útil fixed via u-flag+anchoring. judgments.ts renders ∞.

VERIFIED CLOSED: C1 original mode dead — "dale prioridad al CRM"/"listo, ya subí"/"ok, mando"/"confirmo la reunión" ALL→null (empirical). W2 — "útil"/"es útil"→promoted. W1 all-expired→insufficient_data (live DB today 6prom/1disc=85.7% pass).

NEW W1 (interrogative false-accept): VERDICT_STRIP strips ¿ and ? so a bare interrogative verdict-word promotes: "¿sirve?","útil?","¿es útil?","sí sirve?" ALL→promoted (verified). A QUESTION is not an endorsement; reachable when operator sends bare "¿sirve?" about some other thread while a brief is pending. NARROWER than C1 (needs whole msg≈verdict word) so Warning not Critical, but genuine. Fix: don't strip trailing ?/leading ¿; treat interrogatives as null.

NEW W2 (§13 small-sample volatility): promoted/ruled has NO minimum-sample floor (unlike §17 6a's GATE_V82_MIN_ACCEPTANCE_BRIEFS=3). ruled=1/promoted=0 (single discard, no accept)→0%→§13 check2 FAIL on n=1; single accept→100%→pass. Verified. Add a min-ruled floor to §13 for symmetry. Also §13 likely sits at insufficient_data (not pass) in steady state until operators actually type verdicts → mc-ctl combined exit may move 0→2 (honest, silence-is-ambiguous, but a state change to watch).

INFO: scripts/briefing-gate.ts:82 still labels the value "promote-rate" but denominator silently changed generated→ruled; raw counts adjacent so low-harm.
