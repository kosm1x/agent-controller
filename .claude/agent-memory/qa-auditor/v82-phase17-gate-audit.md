# V8.2 §17 activation-gate audit (2026-06-19)

LENS: gate correctness for `src/briefing/v82-activation-gate.ts` + `scripts/briefing-gate.ts`.
Verdict: PASS WITH WARNINGS. The 6 checks themselves are mechanically correct and
divide-by-zero/empty-set guarded (safer than the spec SQL, which omits the guards).
Cadence trap honored (thin shadow → insufficient_data). critic_trail_json shape
`{verdict,iterations,critique}` matches produce.ts; terminal verdict always
approved|unfixable (runCriticLoop escalates 2nd needs_revision → unfixable).

## Real finds
1. WARNING — combined exit code regresses V8.1 §13 path. `combineVerdicts(pass,
   insufficient_data)=insufficient_data` → exit 2. V8.2 shadow is ALWAYS
   insufficient (6a needs promotions, delivery flag-gated off), so once wired,
   `mc-ctl briefing-gate` exits 2 for the whole shadow window even though V8.1
   is activated (was exit 0). V8.1-GUIDE.md documents 0/1/2 as the V8.1 contract;
   override not reflected. Live blast radius limited (systemd `| tee` swallows
   code) but breaks any operator `&&`/`$?` chain on the documented contract.
2. INFO — 6a acceptancePass unreachable in production multi-judgment briefs.
   Promotion is per-BRIEFING; promote_rate measured per-JUDGMENT via
   `judgments JOIN proposed_briefings`. runJudgmentAssembly writes green+red
   judgments onto the SAME brief → both colors inherit `status='promoted'` →
   ratio→1.0 < 1.5 gate. Test masks it by seeding 1 judgment/brief (1:1);
   prod is N:1. Latent gate-calibration bug inherited from spec but lives here.
3. INFO — combineVerdicts() untested. Only evaluateV82Gate covered; the
   worst-of-two exit contract has zero assertions.

## Doctrine — combined/worst-of-two exit codes
When a new gate is OR'd into an existing gate's exit code, the new gate's
DEFAULT/dormant verdict silently demotes the old gate's exit code for the entire
period the new one is dormant. Always: (a) check the new gate's verdict during
its dormant/shadow window (here: always insufficient_data because its headline
check needs a downstream flag that's still off), (b) confirm the combined code
still honors the OLD gate's documented contract during that window, (c) update the
doc that pins the old exit contract. Pattern-sibling of [[instrumentation-backend-coupling]].

## Doctrine — per-event metric measured per-child-row
A ratio gate keyed on `child JOIN parent` where the measured status lives on the
PARENT (here: promoted is per-briefing, color is per-judgment) collapses toward
1.0 when multiple children of differing class share one parent. The gate looks
calibrated in tests that seed 1 child/parent; verify the PRODUCTION fan-out
(here runJudgmentAssembly writes N judgments/brief) before trusting a ratio gate.
