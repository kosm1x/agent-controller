# gate-settleable-expect R2 — Honest-Done settleable `expect`, R1 folds verified (2026-09-12)

Uncommitted working tree, /root/claude/mission-control. Verdict **PASS-WITH-NOTES** (0 Critical,
2 Warning). Baseline 136/136 green over the 5 scoped files; tree restored byte-identical.

## What held (all verified by running, not reading)

- **8/8 R1 bypass patterns refused.** `/^(?:[1-9][0-9]*)$/m` `/(?=\d)\d+/` `/(?<n>[0-9]+)/` `/\D/`
  `/[^0-9]/` `/[\s]/` `/^[1-9][0-9]*$/m` `/[0-9]/` → all `isUnsettleableExpect` non-null.
- **Regex branch is closed BY CONSTRUCTION, not by luck.** The write-time probe and `expectMatches`
  call the SAME `safeRegexTest` over the SAME `FAILURE_OUTPUTS`. So for any regex expect,
  admitted ⟹ not matched by any of the 6 failure strings ⟹ cannot be MET on `"0\n"`. Proving that
  once beats fuzzing. Backed anyway: 70 hand-built candidates + 1,415 random compilable patterns
  (optional-literal `/x?[0-9]/ /a{0}[0-9]/ /x*[0-9]/`, `\x30 0 \060 \p{Nd}`, `[0-9_] [\d-]`,
  `[^]`, `.` with `s`, `\B`, empty alternation) → **0 bypasses**.
- Live ritual e2e on the REAL stored payload (schedule `9e06a237…`): `scheduleGates` → 1 spec with
  `abandonReason` + expect kept → `declareGates` → 1 `abandoned` row → `evaluateLedger` ran 0 checks,
  exec invoked 0 times.
- Replay `scripts/replay-gate-expects.ts data/mc.db`: `rows 297 · no expect 236 · kept 27 · would refuse 34`.
- Mutations: (a) drop group-prefix strip → 4 RED · (b) `FAILURE_OUTPUTS=["","0"]` → 1 RED ·
  (c) `scheduleGates` without the option → 1 RED · (d) drop `declareGates` floor → 1 RED ·
  (e) bare `RegExp` in the probe → **0 RED** (hardening with no behavioural pin; and no input can
  distinguish it — line 176 refuses nested quantifiers first and the haystacks are ≤4 chars).
- W1 metric ticks live: spec=1, stored re-parse=unchanged, plan=1. W2 real 2nd module identity
  (`?second=1`) reuses the Counter; removing the `getSingleMetric` guard throws (no test pins it).
  W3 evidence marker `not a number: ` only on the non-numeric case.

## The two Warnings

1. **The comparator branch returns BEFORE the failure-output probe.** `expect.ts:162`
   `if (parsed.kind === "cmp") return null;` — the loop is at :188. So `gte 0`, `gt -1`, `neq -1`,
   `GTE 0`, `gte +0`, `gte 0.0` are ADMITTED and MET on `"0\n"`. Proved through the real CLI door:
   `gates-validate.ts` exits 0 on `expect: "gte 0"`. The module docstring scopes the claim to
   "every NON-comparator expectation" — the exemption is exactly the family it cannot see.
   Minimal fix, verified clean on 9 vacuous + 11 legitimate forms:
   `compareNumber(p,0) && compareNumber(p,Number.MAX_SAFE_INTEGER)` ⇒ refuse. Keeps `eq 0`,
   `lte 0`, `between 0 0`, `lte 999999999`.
2. **A refusal REASON can be false while the refusal is defensible.** `/^[1-9][0-9]*$/m` is
   refused as "names only digits, so any count satisfies it". Ran the live check both ways:
   `./mc-ctl db "SELECT COUNT(*) AS n …"` emits `n\n-\n0` (count 0) and `n\n-\n2` — the expect
   matches the second and NOT the first. All 12 live MET rows carry evidence `- | 1`; zero false
   METs. expect.ts:7-8 says `/[1-9]/ /[3-9]/ /^[1-9][0-9]*$/m` "pass on any count" — all three
   fail on `"0\n"`. The spec doc elsewhere calls the same gate "the gate that catches a day with
   no tweet". Cost: the ONE live gated ritual reads `Gates: 0/1 met · ABANDONED` nightly until the
   operator runs the (prepared, door-validated) `mc-ctl gates set-ritual … expect: gt 0`.

## Doctrine crumbs

- **An early-return branch in a layered validator is a hole in every layer below it.** Enumerate
  the `return null` sites before trusting a probe's "everything is tested against X" claim.
- **A shared matcher + a shared corpus closes a branch by construction** — say so instead of fuzzing.
  The residual is the corpus, not the matcher: real failure outputs the set omits
  (`file:0`, `0 file`, `COUNT(*)\n----\n0`, `sh: 1: x: not found`).
- **A documented operator migration is a claim**: `ls` the file it names and push it through the
  real write door (`gates-validate.ts` exit 0), don't just read the sentence.
- **A "cannot fail" rule needs the check's OWN output shape**, not the regex in isolation.
  `-column` sqlite pads the value line; `lastNumber` trims, so `gt 0` works on `mc-ctl db`.
- A backup taken "at session start" can race a concurrent author write. Settle causation with
  mtime + who could have authored the drifted text, and md5 only the files you actually mutated.
