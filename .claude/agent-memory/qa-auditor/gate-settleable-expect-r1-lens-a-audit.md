# Honest-Done settleable `expect` grammar — R1 lens A (CORRECTNESS of the grammar)

2026-09-12 · uncommitted working tree · `src/lib/v8-4/expect.ts` + `gates.ts` + `gate-check.ts`
+ `scripts/replay-gate-expects.ts`. Sibling lens file: `gate-settleable-expect-r1-audit.md`
(wiring/verdict layer). Verdict: **FAIL — 2 Critical**. 85/85 scoped tests GREEN, so every
finding below is an UNPINNED hole, not a broken test.

## The two Criticals (both verified e2e through the real `runShellCheck` + `expectMatches`)

**C-1 — group syntax counts as a "literal".** `regexNamesALiteral` strips
`[\^$()|*+?.\d\s]` but NOT `:`/`=`/`!`/`<n>`, so the `(?:` `(?=` `(?!` `(?<n>` prefixes
survive the strip and read as a named literal. `/^(?:[1-9][0-9]*)$/m` — the live top expect
(20/61 rows) plus two characters — is ADMITTED and MET on `echo 3`. `/(?:[1-9])/`,
`/(?=[1-9])/`, `/(?<n>[1-9])/` likewise.

**C-2 — `FAILURE_OUTPUTS = ["", "0"]` is not what the shell emits.** The executor buffers
raw chunks, so `grep -c NEVERMATCH f || echo 0` hands over `"0\n"`. Every complement class
is admitted AND matches it: `/\D/`, `/[^0-9]/`, `/[^\d]/`, `/[^0]/`, `/[\s]/`, `/\n/` —
each MET on the canonical failure output, i.e. satisfied by ANY non-empty output.
(`/\s/` IS refused; `/[\s]/` is not — the `\\[dbBsSwW]` strip empties the class to `[]`,
whose brackets then count as a literal.)

## Fix validated against the corpus (zero cost)

Prepend `.replace(/\(\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>)/g, "")`, allow `^` in the class
strip (`\[\^?...\]`), add `D` to `\\[dbBsSwW]`, and widen FAILURE_OUTPUTS to
`["", "0", "0\n", "\n", " 0\n", "0\r\n"]`. Replayed over the live ledger: refusals stay
**34/61 rows — identical** — and all six bypasses flip to REFUSE while `/(?:ok|fail)/`,
`/[0-9a-f]{7}/`, `/Avg Δ/`, `/active|caddy/`, `/200.*json/`, `/v\d+/` stay kept.

## Warnings

- **The 256 KB output cap is HEAD-keeping; the comparator needs the TAIL.** `runShellCheck`
  stops appending at `MAX_OUTPUT_BYTES`, so `yes noise | head -60000; echo 12` truncates the
  number away → `lastNumber`=null → gate FAILED with a real count of 12. Regex/substring use
  `slice(-64KB)` of what survived, so only comparators are starved.
- **Any stderr line after the number fails the gate**: stdout+stderr share one buffer;
  `echo 12; echo 'Warning: deprecated' >&2` → `"12\nWarning: deprecated\n"` → FAILED. Loud
  (evidence says "last line is not a number"), but a false-negative producer for chatty checks.
- **One trailing space silently downgrades a regex to a substring** and bypasses the whole
  regex validator: `parseExpect` trims for cmp/between but matches `REGEX_RE` on the RAW text.
  `"/[0-9]/ "` → substring → ADMITTED → a gate that can never pass. Same class:
  a trailing `\n`, an uppercase flag (`/x/I`), and `gateSpecsFromGoal`'s
  `o.expect.slice(0, MAX_EXPECT)` truncating a >500-char regex past its closing `/`.
- **No-space comparator typos slip the `\b` guard**: `gte5`, `eq200`, `lt10` — the next char
  is a word char so `CMP_WORD_RE` never fires; admitted as never-matching substrings.
- **Write-time regex evaluation has no sandbox and no deadline** (unlike `safeRegexTest`'s
  vm + 250 ms + `NESTED_QUANTIFIER_RE`). A 1-char haystack is NOT safe: a fresh
  `/(a|a|a|a|a|a|a|a|a|a){×20}/` (420 chars, inside `MAX_EXPECT=500`) costs **451 ms** in
  `isUnsettleableExpect`. Cost plateaus ~200 ms/test from n=10 (n=3 = 0.16 ms), so it is
  bounded, not a hang — but `parseGateSpecs` caps neither the gates array nor this work,
  and `/api/*` (api-key + 300 req/min) reaches it.

## What is SOLID (probed, no finding)

- `lastNumber` over 32 shapes: CRLF, bare CR, `+5`, `007`, `-0`, tabs, form feed, blank last
  line, NBSP, 400-digit → Infinity → null. Rejects hex/exponent/`1,234`/`97%`/`4.0K`/`٣`/
  `wc -l file.txt`. Huge-int precision loss cancels (both sides go through `Number`).
- **Live-corpus precedence: 0 collisions.** No distinct live expect (32) starts with a
  comparator word, and none carries leading/trailing whitespace — the grammar changes no
  existing row's meaning. Corpus verdict: 34/61 refused, 27 kept.
- g-flag statefulness across the two FAILURE_OUTPUTS is safe: a failed `test()` resets
  `lastIndex` to 0, and a successful one refuses immediately.
- Comparator skipping `MATCH_WINDOW_BYTES` is harmless (the last line is in the tail either
  way; 3 ms per call on 120 KB).
- False refusals are few and defensible: `/[-]{3}/`, `/[ ]/`, `/[01]/`.

## Method note

Mid-audit the tree carried live planted mutations (`// M1 MUTATION` in `regexNamesALiteral`,
`// M2 MUTATION` on the FAILURE_OUTPUTS loop) from a sibling lens' mutation run — the replay
script's KEPT/REFUSE headline was polluted (kept 56 vs the true 27). **When several lenses
audit one bundle in parallel, `grep -c MUTATION src/**` before trusting any replay number**,
and probe against a frozen scratchpad copy of the module.
