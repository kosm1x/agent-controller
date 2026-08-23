---
name: usability-phase3-r1-audit
description: R1 audit of usability plan Phase 3 (numbers with provenance) 2026-08-23 — FAIL, 6 Critical. Bug classes: a text-detector shipped without a corpus replay; a gate whose corpus is any tool result launders figures; a metric whose numerator is 0 by construction; SSRF via model-authored URLs.
metadata:
  type: project
---

# Usability Phase 3 R1 — "Numbers with provenance" (2026-08-23)

**Verdict: FAIL.** 7 Critical, 12 Warning. Uncommitted working tree at audit time
(`provenance-gate.ts`, `citations.ts`, `data-summarize.ts` untracked; 0 rows of
`provenance.checked` in the DB — nothing observed in production yet).

## Bug classes worth carrying forward

### 1. A text detector is only as good as its CORPUS REPLAY (recurrence #3)
`auditNumbers` over 189 real deliverables (`created_at > 2026-08-18`,
`status LIKE 'completed%'`, corpus `[]`): **357 of 358 claim-figures flagged**,
**94/189 (49.7 %) of deliverables** would carry ≥1 `(sin verificar)`.
Mechanically-confirmed structural FP floor **83/357 = 23.2 %** across 9 classes
that are FPs *even with a perfect corpus*: work-plan counts (`las 4 páginas`,
`3 archivos` — 31), ports/PIDs (11), the harness's OWN read-back evidence
(`sha d6474a8e, 10619 chars` — 4), the model's own CSS px deltas (5), idiomatic
`100 % garantizada` (6), ritual criteria thresholds (`<40 % success on 5+ uses`
— 13), quoted web copy (2), self-authored content counts (9), spec ids
(`ISO 27001` — 2).
**Rule:** score a claim-class detector against the LIVE deliverable corpus
before shipping, and classify every hit — not against fixtures.
(Same class as `corpus-replay-before-shipping-a-text-filter`, 3rd recurrence.)

### 2. A corpus built from EVERY tool result is a laundering channel
`recordToolEvidence` (registry.ts:277) records every tool result unfiltered, and
support is `haystack.includes(digitKey)` (substring). Two proven bypasses:
- `file_write` (UNGATED) → `file_read` → the invented figure is now "sourced".
- An unrelated ERROR string laundered it: `"connection refused to 10.0.94.0
  after 9400000 ms"` made `9400000` pass.
**Rule:** an evidence corpus must be provenance-typed (which tool, read vs
write), not "anything the run emitted".

### 3. The gate's promise names a field it never reads
Rejection text says "ni en el mensaje del usuario"; the corpus is
`tasks.description`, which for a chat task is the **24 KB persona system
prompt** (verified: `length(description)=24224`, starts `## Identidad`). The
user's message lives in `tasks.title`, truncated to ≤69 chars, and is never
read. Every operator-supplied figure is therefore unsourced.
**Rule:** for each clause of a gate's error message, name the code line that
implements it.

### 4. A metric whose numerator is 0 by construction (recurrence)
`unsourced_figures_in_artifacts` sums `attrs.unsourced` only `WHEN rejected = 0`.
Under the default `enforce`, `rejected` is true whenever `unsourced > 0` ⇒ the
metric is identically 0, and the plan's exit criterion ("0 unsourced figures in
artifacts over 14 days") reads GREEN on day 1.
(Same class as `gate-scored-an-impossible-population`.)

### 5. Model-authored URLs fetched by the harness = SSRF + exfil
`citations.ts` HEAD/GETs every URL in a `## Fuentes` section with **no host
guard**, while `src/lib/url-safety.ts` exists and is used by wordpress /
gemini-research. Verified the harness issues requests to `127.0.0.1:8098`
(opensandbox), `169.254.169.254`, `localhost:8100` (supabase),
`127.0.0.1:40001` (unauthenticated execd). Verdict (resolved/missing/
unreachable) is a blind port-scan oracle; query strings are an exfil channel.

### 6. One-character bypasses of a payload gate
Backticks (`` `$9,400,000` ``), a code fence, the word `ejemplo`/`objetivo`/`~`
anywhere on the line, ANY URL in the paragraph, ONE `fuente:` cell anywhere in
a sheet, or `fuente: "memoria"` (7 chars ≥ the 4-char floor) all pass the gate.
The rejection message itself teaches the `fuente` bypass.

### 7. `applyDrops` edits `[n]` globally — corrupts code
`const x = arr[3] + arr[1];` → `const x = arr + arr[1];` inside a fenced block.
And `titleOf` picks the LONGEST sentence of a reference entry, so
"Attention Is All You Need" queries Crossref for
`"Advances in Neural Information Processing Systems, vol"` ⇒ real papers get
dropped as fabricated.

## What is CLEAN (do not re-flag in R2)
- Finance routing end-to-end: `finance` ∈ VALID_GROUPS → `scope.ts:1482` →
  14 registered `market_*` tools; `groupsForTool("market_quote") = ["finance"]`;
  `detectScopeMiss("Necesito \`market_quote\`…")` fires. Auto-widen works.
- The new prompt section does NOT contradict Phase 1 — `prompt-sections.ts:103`
  already instructs "name the exact tool in one line", which scope-miss consumes.
- Metrics `ts` format: `strftime('%Y-%m-%dT%H:%M:%fZ')` matches the table default.
- `annotateUnverified` is idempotent (verified over 20 shapes); cap-8 slice
  picks the first 8 in text order and edits descending so offsets stay valid.
- `jarvis_file_update` metadata-only path is ungated (gate is inside `if (append)`).
- 113/113 scoped tests green; tsc clean.

## Mutation-verify gaps found
Deleting `p2.push(figuresProvenanceSection())` from router.ts:312 leaves
**148/148 tests GREEN**. No wiring test for the always-on prompt section.
