---
name: usability-phase3-r4-audit
description: R4 verify-only audit of usability Phase 3 (numbers with provenance) 2026-08-23 — FAIL, 1 Critical. Bug classes: an ANCHORED verifier regex paired with an UNANCHORED admitter regex (any prefix skips the check); the gate's own rejection text is formatted in the exact shape that defeats it; 11 of 23 folds still unpinned.
metadata:
  type: project
---

# Usability Phase 3 R4 — R3 folds verified (2026-08-23)

**Verdict: FAIL.** 1 Critical (new), 4 Warning. 5 of 6 R3 Criticals fold
correctly and are mutation-pinned; C-3's fold is defeated by one `^`.

## Bug classes worth carrying forward

### 1. An ANCHORED verifier behind an UNANCHORED admitter
`provenance-gate.ts:133` `TOOL_NAME_RE = /^(shell_exec|gsheets_read|…)\b/i`
decides "does this `fuente` name a tool I must check ran?"; `CHECKABLE_SOURCE_RE`
(numbers.ts:394) admits the SAME names UNANCHORED (`\b(?:shell_exec|…)\b`).
Any prefix → `!tool` → `return true` → whole payload exempt with the tool never
run. Proven on the model's OWN live style (sampled from 243 `jarvis_files`
carrying `fuente:`): `**Fuente:** \`shell_exec wc -l ventas.csv\``,
`fuente: \`gsheets_read Ventas!A:F\``, `fuente: salida de data_summarize x.csv`
all ACCEPTED; only the bare `fuente: shell_exec …` is rejected.
**Rule:** when a guard classifies a string that a SECOND regex already admitted,
diff the two patterns' anchors/boundaries — a stricter anchor on the verifier is
a hole, not a tightening.

### 2. The rejection text is formatted in the shape that defeats the check
`provenance-gate.ts:159` tells the model to pass
``(p. ej. `shell_exec wc -l ventas.csv`, `gsheets_read Ventas!A:F`)`` — the
backticks are markdown, and a leading backtick defeats the `^` anchor. R3 C-3's
own rule ("the rejection text becomes the exploit manual") recurred through the
FORMATTING of the message rather than its content.
**Rule:** feed the rejection message's own examples back through the validator
as a test. If any example fails to validate, the message is wrong or the
validator is.

### 3. Fold-without-a-pin, 3rd consecutive round (11 of 23)
Mutation → 0 RED: C-2 SHA exemption · C-4 rows `jarvis_file_move` /
`kb_batch_insert` / `kb_ingest_pdf_structured` / `file_convert` / `gdrive_upload`
· W-4 min-length guard · W-1 `corpusValues` 2.500 second reading · W-5 persona
exclusion · W-7 `priorContent` (both the corpus line and BOTH wiring sites).
Pinned ✓: C-1, C-3, `createdKeys`, `keyVariants`, C-5, W-8, W-6, W-2/W-3,
R2 C-3a, R2 C-3b, R1 C-3, R2 W-7 (the four R3-unpinned ones are now pinned).
**Pattern:** a `switch` of per-tool rows gets ONE row tested; the other N-1 are
free to be deleted. Test the ROW SET (table-driven), not one example.

### 4. `targetsRunWrite` cannot match an ARGUMENT THAT IS ABSENT
`grep {pattern:"filas"}` — `path` optional, defaults to `"."`
(`code-search.ts:52-55,77`) — args JSON holds no path, so the containment check
finds nothing and the model's own just-written file becomes evidence. R3 named
this sub-case; the fold (ancestors/basename/stem) can only widen what a present
string matches.
**Rule:** a containment check over serialized args is blind to defaulted
parameters. Enumerate every optional path/target param whose DEFAULT is broad.

## What is VERIFIED CLEAN in R4 (do not re-audit)
- **C-1**: `Revista Expansión, 45(2), pp. 12-18` → `confident:false` →
  `unreachable`, text unchanged ✓; `Revista del Consumidor` ✓; newspaper ✓;
  INEGI tabulado not even extracted ✓; `Proceedings of Fake Conf` and
  `Journal of Imaginary Research` still DROP ✓. Pinned.
- **C-2**: 142 KB files / 30 d, corpus `[]` → **89 rejected (62.7 %)**, was
  93/144 (64.6 %). SHA exemption uniquely covers 825 inline spans over 44 files
  (33 all-digit / 792 hex, 264 distinct); the 14 distinct all-digit values are
  13 git short SHAs + one 19-digit tweet id — **0 real figures swallowed**.
- **C-3** core: `fuente:"shell_exec wc -l ventas.csv"` with no run → REJECT;
  after `recordRunTool("shell_exec")` → ACCEPT ✓ (both the param and the
  in-text `fuente:` paths). Pinned. Defeated only by prefix — see class 1.
- **C-4**: 4 of 5 R3 bypass rows CLOSED (parent-dir grep, `gslides_create`→read,
  `memory_store`→`memory_search`, `jarvis_file_move`→read). `find|xargs cat`
  open by design; `grep` with no path open (class 4).
- **C-5**: allow-list only; `humanize_text`/`video_script`/`video_storyboard`/
  `seo_content_brief`/`seo_meta_generate`/`memory_search`/`market_watchlist_*`/
  `market_chart_*`/`northstar_*` all excluded; `shell_exec` included ✓. Pinned.
- 298/298 scoped tests green; `tsc --noEmit` exit 0.

## Live measurements (2026-08-23)
- 149 builtin tools; 32 match `EVIDENCE_TOOL_RE`. ~28 real `readOnlyHint:true`
  observe-the-world tools are NOT allow-listed (`git_status`, `git_diff`,
  `vps_status`, `vps_logs`, `jarvis_file_search`, `paper_portfolio`,
  `paper_history`, `whale_trades`, `macro_regime`, `market_calendar`,
  `sentiment_snapshot`, `alpha_latest`, `backtest_latest`, `seo_page_audit`,
  `seo_telemetry`, `tweet_mentions`, `project_list`, `list_schedules`,
  `evolution_get_data`, …) — over-rejection, fail-safe direction.
- Dead branches in `EVIDENCE_TOOL_RE`: `mcp__\w+` (real MCP names are
  `<serverId>__<tool>` per `MCP_NAMESPACE_SEP="__"`, servers are `browser`,
  `playwright`, `graphify-code`, `xpoz`) and `gdrive_search` (no such tool).
  `xpoz__\w+` and `graphify-code__\w+` are absent from the allow-list.
- KB writes in 30 d: 122 NEW paths vs 20 overwrites — `priorContent` (W-7)
  covers only 14 % of writes, so 62.7 % is a realistic enforce-mode ceiling.
- Bareword data sources (`inegi`, `denue`, `banxico`, `fred`, `yahoo`,
  `polygon`, `crossref`, `pubmed`) pass `CHECKABLE_SOURCE_RE` alone and exempt
  the WHOLE payload — while the rejection text says "un nombre suelto … no
  cuenta". Same for a model-authored URL/path never fetched (declared design).
- C-1 residual: `\bet al\b` in `CROSSREF_VENUE_RE` (citations.ts:156) is an
  AUTHOR signal used as a VENUE signal — `García, M., et al. (2022). … Revista
  Expansión, 30, pp. 5-9.` still DROPS. Citation population ≈ 1/1655, so ~0 blast.
