# diag four-fixes bundle — R1 audit (2026-09-06)

**Verdict: FAIL, 1 Critical, 4 Warnings.** All 5 scoped suites green (218 tests),
`npm run -s typecheck` exit 0, all three requested mutation probes RED against
the pre-fix code. The Critical is not a broken fix — it is an unmeasured blast
radius the fix opens.

## The Critical: raising a budget CHANGED WHAT THE BUDGET ADMITTED

`src/db/user-facts.ts` — always-inject facts stopped counting against
`MAX_FACTS_CHARS = 3000`, so the scored half got a real 3,000-char budget for
the first time since 2026-05-24. Correct diagnosis (live: personal 3,321 +
preferences 405 = **3,726 > 3,000**, so 0/197 `projects` rows were injected).

But the scored loop has **no relevance floor** —
`src/db/user-facts.ts:158  if (totalChars + line.length > MAX_FACTS_CHARS) continue;`
— and the sort is `score DESC, updated_at DESC`. On a message that scores
ZERO the order collapses to pure recency, so the budget fills with the NEWEST
facts regardless of topic. Simulated against the live 197 rows: **18 rows /
2,988 chars admitted on an unrelated message**, of which 8 are credentials
(3× `espn_s2` session tokens at ~370 chars each, 3× SWID,
`doctoralia_password`, `mexiconecesario_auth_token`).

Pre-fix those reached the prompt on ZERO turns. Post-fix: every turn.

Compounding, at `src/messaging/router.ts:336`:
`  if (userFactsBlock) p4.push(userFactsBlock);`
— no `ownerChannel` guard, while the operator-private cohort in the SAME
function IS gated (`cohortSection(cohortMembers, ownerChannel)`).
`isOwnerChannel = !isEmailChannel(channel) || mode === "owner-only"`, so
WhatsApp GROUP members count as "owner" and community-manager mailboxes are
the only non-owner path (could not confirm one is configured — `.env` read is
denied, so that half is conditional, not proven live).

**CLASS — a cap is also a filter.** When a cap is the only thing bounding a
recency-ordered list, RAISING it does not just admit "more of the same"; it
admits a different POPULATION. Before shipping a budget change, replay the
selection against the LIVE table and print the KEYS admitted — never reason
from the count.

Remedy probe: `if (score === 0) continue;` passes BOTH new tests but breaks the
pre-existing "should format facts grouped by category" (it calls
`formatUserFactsBlock()` with no message, so every score is 0). Needs the
no-message case exempted, or gate the scored half on `ownerChannel` instead.

## Warnings that generalize

1. **A streaming guard latched STRICTER than its final-text twin.**
   `looksLikeScopeAsk` = `SCOPE_ASK_RE` on the 700-char tail MINUS the
   known-tool check; `holdScopeAsks` latches (`if (held) return;`) and never
   releases. Corpus replay over 3,986 live replies: **132 (3.31%) held with no
   final scope-miss**, 116 of them losing ≥30% of the reply's streaming
   (samples: `held@24/1364`, `held@24/2283` — an ask-shaped OPENER followed by
   the real work). Re-evaluating the predicate on the current accumulation
   instead of latching → **27 (0.68%) false holds, 115 → 115 correct holds
   kept, 0 lost**. No content is lost either way (`finalize()` rewrites, and
   `reset()` sets `finalized = false`), so it is streaming UX only.
   **CLASS: when a guard is a stream-time COPY of a final-time guard, the copy
   must mirror the original's release condition, not just its trigger.**
   Ordinary Spanish trips it: "necesito que me digas cuál prefieres",
   "Necesito acceso_directo a la carpeta" → HOLD, no MISS.

2. **An outline is emitted UNCONDITIONALLY; a slice read is deliberate.**
   `buildOutline` now surfaces a 60-char snippet of every timestamped entry.
   Across 157 day-logs / 10,941 entry-lines: **106 credential-shaped snippets
   that were NOT in the pre-fix 1,500-char preview**. Same file, same tool —
   but the exposure moves from "when the model asks for that range" to "every
   large-file read".

3. **FP fear was unfounded — the corpus said so.** Synthetic probe showed
   `- [10:30] reunión` matching `LOG_ENTRY_RE`. Live replay over 376 KB
   markdown files >8k: **0/260 non-day-log files gained a single entry line.**
   Max outline 12,035 bytes. Report the corpus number, not the synthetic fear.

4. `handleTaskFailed` (`src/messaging/router.ts:3327-3404`) never touches
   `pending.streamController` — after a hold the placeholder is orphaned at
   "⏳" and the failure line arrives as a separate message. Pre-existing path,
   newly visible because the placeholder is now empty instead of partial.

## Probe mechanics worth reusing

- **Pre-fix mutation without touching the tree**: `git show HEAD:<file> >
  <file>.OLDMUT.ts` + `sed` the test's import to match, run scoped vitest,
  `rm`. Untracked files never appear in `git diff`, so the byte-for-byte
  restore is free. Worked for a 3,394-line test file (router) unchanged.
- **`git show` in a Bash-tool thread**: cwd resets between calls — a bare
  `git show` from the scratchpad dies with "not a git repository" and the
  redirect still creates a 0-byte file, which then PASSES prettier/tests
  vacuously. Use `git -C <abs repo>` always.
- **prettier here is NOT a standard**: not in `package.json` deps, no config
  file, and `.git/hooks/pre-commit` runs only `npm run typecheck` + `npm run
  test`. HEAD is already prettier-dirty on 5 of the touched files, and every
  drifted line is pre-existing. Do not report it as a standards violation.
- `better-sqlite3` cannot be imported from the scratchpad (module resolution).
  Dump the corpus with `sqlite3 -readonly -cmd ".mode json"` to a file and
  read it with `fs`, or put the probe script at the repo root and `rm` it.
