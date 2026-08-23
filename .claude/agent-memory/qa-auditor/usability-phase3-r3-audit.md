---
name: usability-phase3-r3-audit
description: R3 audit of usability plan Phase 3 (numbers with provenance) 2026-08-23 — FAIL, 6 Critical. Bug classes: a "not academic" gate whose own alternation admits every Spanish magazine; an un-exemption that only ever fires on all-digit git SHAs; a one-parameter label that exempts a whole payload; a containment check whose substring direction is backwards for directory reads; 6 of 8 folds unpinned.
metadata:
  type: project
---

# Usability Phase 3 R3 — R2 folds verified (2026-08-23)

**Verdict: FAIL.** 6 Critical, 11 Warning. Every R2 Critical was folded and 2 of
the folds are mutation-pinned; the SSRF fold is behaviourally PERFECT (10/10
live probes blocked) but pinned by nothing.

## Bug classes worth carrying forward

### 1. A "this is academic" gate whose own alternation admits the excluded class
`ACADEMIC_RE` (citations.ts:93) exists so Crossref's "no match" can never drop a
non-academic source — its comment says "Crossref does not index INEGI tabulados
or a newspaper". But `revista` and `\bpp?\.\s*\d` are IN the alternation, and
every Spanish periodical citation carries both. Live against real Crossref:
`Ramírez, J. (2023). Panorama del retail mexicano. Revista Expansión, 45(2),
pp. 12-18.` → `confident:true` → no Crossref match → **DROPPED** with
"⚠️ Quité 3 referencias que no existen". `confident` pins the PARSER's
confidence, not the SOURCE's indexability.
**Rule:** when a guard's comment names the class it protects, grep the guard's
own pattern for that class's vocabulary.

### 2. An un-exemption that only ever fires on the thing it meant to skip
`numbers.ts:316` — `if (includeCode && /\d{2,}/.test(m[1]!) && !/[a-f]/i.test(m[1]!)) continue;`
The `!/[a-f]/i` was meant to skip commit hashes; ~3.7 % of 7-char SHAs are
all-digit. Replay over 144 KB files written in 30 d: **16/16 figures created
only by that line are all-digit git short SHAs** (`6486327`, `3120416`,
`5131739`, `9705377`…), across 8 files (day-logs, day-narratives, project
READMEs — Jarvis's core KB shapes); it flips 3 files from accept to reject. The
model cannot source a commit hash as a figure; the only compliant move is to
delete it.
**Rule:** measure a new exemption/un-exemption by what it UNIQUELY changes on
the live corpus, and read all of those hits.

### 3. A one-parameter label exempts a whole payload
`provenance-gate.ts:169-173`: `unsourced = fuente ? [] : audit.unverified` with
`fuente` validated only by `CHECKABLE_SOURCE_RE` (a regex on the STRING).
Proven: `gsheets_write` with 4 fabricated figures + `fuente: "shell_exec wc -l
ventas.csv"` (never called) → `{ok:true, figures:4, unsourced:[]}`. The
rejection message the model just received prints that exact string as the
example. `priorRunTools()` (rule-of-two.ts:496) already tracks which tools ran —
the tool-name branch of the label is checkable and is not checked.
**Rule:** a gate that accepts a self-declared label must verify the branch of
the label that IS verifiable, or the rejection text becomes the exploit manual.

### 4. Substring containment is one-directional — parent-dir reads escape
`targetsRunWrite(taskId, JSON.stringify(args))` asks "does the read's args
contain the written key". A read scoped to the PARENT never does. Proven
through the real registry: write `proyectos/notas.md` → `grep {pattern:"filas",
path:"proyectos"}` (or `grep` with NO path — it defaults to `"."`) → the
model's own figure is evidence. Same for `shell_exec "find … | xargs cat"`
(path never appears in args). Also: `gslides_create`, `gdrive_create`,
`kb_batch_insert`, `wp_publish`, `gtasks_create`, `file_convert`,
`memory_store`, `jarvis_file_move`, `google_workspace_cli` are absent from
`writeTargetKeys` — `memory_store`→`memory_search` and `jarvis_file_move`→read
were both proven. And the check over-excludes in the other direction:
`gdrive_upload {name:"data"}` (min key length 3) killed a legitimate
`gsheets_read {range:"data!A:C"}`.

### 5. `readOnlyHint:true` re-imports MODEL-AUTHORED text as evidence
R2 C-1 fixed the false-negative arm (shell_exec excluded); the union's OTHER
arm (`|| readOnlyHint === true`) admits LLM-GENERATION tools, which are
correctly readOnly (no side effects) but whose output IS the model's own words:
`humanize_text` (writing.ts:39, returns `{result: <LLM rewrite of args.text>}`),
`video_script`, `video_storyboard`, `seo_content_brief`, `seo_meta_generate`,
`memory_search`. Proven: `humanize_text({text:"94 filas"})` → corpus.
**Rule:** an EVIDENCE class needs a third axis beyond read/write —
"observes the world" vs "generates text".

### 6. Fold-without-a-pin (recurrence)
6 of 8 folds survive deletion with 0 RED:
| fold | mutation | result |
|---|---|---|
| R2 C-4 `targetsRunWrite` | → `true` | 37/37 GREEN |
| R2 C-1 `EVIDENCE_TOOL_RE` | → `readOnlyHint` only | 61/61 GREEN |
| R2 C-3a DNS resolver | → `validateOutboundUrl` | 15/15 GREEN |
| R2 C-3b `redirect:"manual"` | deleted | 15/15 GREEN |
| R1 C-3 `recordUserEvidence` | deleted | 112/112 GREEN |
| R2 W-7 tail cap | reverted to start-anchored | 101/101 GREEN |
| R2 C-5 table cell | disabled | **1 RED** ✓ |
| R2 C-2 `!c.confident` | dropped | **1 RED** ✓ |

## What is CLEAN (do not re-flag in R4)
- **SSRF fold is behaviourally complete** (10/10 live): 127.0.0.1 · 169.254.169.254
  · localhost · `[::1]` · `2130706433` · `0x7f000001` · `017700000001` · `127.1`
  · userinfo · `[::ffff:127.0.0.1]` · `127.0.0.1.nip.io` · `localtest.me`
  (DNS→::1) · `spoofed.burpcollaborator.net` (DNS→127.0.0.1) all blocked; a 302
  to loopback is NOT followed (1 request only); relative `Location` followed and
  re-validated; `ftp:` and protocol-relative `//127.0.0.1/` Locations blocked; a
  redirect loop stops at 4 hops → 399 → `unreachable` (never `missing`);
  405→GET escalation re-enters the guard; DOI uses `follow=false` and a doi.org
  3xx = registered without visiting the publisher. Residual: documented TOCTOU.
- `titleOf` family: APA ✓, Vancouver ✓, Chicago italic ✓, Spanish «» ✓ all
  `confident:true`; Vancouver-with-period-in-title, Chicago-plain, no-initials
  → `confident:false` (never droppable) ✓; Harvard → `null` (never checked).
- W-4 `CHECKABLE_SOURCE_RE`: 27 probes correct (`memoria`/`notas`/`data`/
  `abc.def`/`Excel`/`v1.2.3` fail; paths, `~/`, `./`, data extensions, URLs with
  a dotted host, tool+query pass). W-5 ×100 widening off for currency ✓.
  W-1 `includeCode` ✓ (fenced + inline ≥2 digits audited in artifacts only).
  W-7 tail cap keeps the END ✓. W-2 `2.500 clientes`→2500, `MDP`/`MDD`→1e6 ✓.
- Corpus/write hygiene that DOES hold: `file_write`→`file_read` same path,
  `./`-prefixed re-read, `shell_exec cat <path>`, `gdocs_write`→
  `gdrive_download` same id — all correctly excluded. A REJECTED write
  (`{"error"…`) does NOT register its key (correct: nothing was written).
  `takeToolEvidence` frees `writtenByTask` in the dispatcher's `finally` — no
  growth on failed/abandoned runs.
- `data_summarize` correct: quoted-comma CSV, rows/sum/mean, `group_by`,
  `/etc/shadow` blocked, ENOENT as `{"error"}`.
- 209/209 scoped tests green; `tsc --noEmit` exit 0.

## Live measurements (2026-08-23)
- Chat replay, 189 deliverables, corpus `[]`: **62/189 marked (32.8 %)**, 260
  figures, 255 unverified (R2 was 68/189 · 294).
- Table-cell branch uniquely creates **13 figures; 12 are model-computed
  priority scores** in the daily-signals ritual tables (`| … | 13.5 |`). Bold
  cells escape it (`| **8.0** |` silent, `| 20.0 |` flagged).
- `tasks.description` (median 23,560 chars = the persona prompt) "rescues"
  22/255 unverified figures; 3 of those from a ≥23 KB persona.
- KB replay, 144 files written in 30 d, corpus `[]`: **93 (64.6 %) would be
  REJECTED** by the artifact gate.
- Citation population: **1 of 1655** deliverables since 2026-07-01 carries any
  citation — the checker's exit criteria are unmeasurable in a 14-day window.

## Other confirmed defects
- Spanish thousands asymmetry: text `2.500 clientes` → 2500, but `corpusValues`
  parses the SAME literal `2.500` in a tool result as 2.5 (no count-noun
  context) and `digitsSupported` looks for `"2500"` — the figure is UNVERIFIED
  although the corpus literally contains it.
- `1250 filas` / `1500 registros` are NOT claims: the `year` rule
  (`/^(1\d|20)\d{2}$/`) runs inside the counted branch, so every bare 4-digit
  count in 1000–2099 with a count noun is exempt.
- Second-column ranks and IDs are claims: `| Puebla | 11 |`, `| Acme | 40912 |`
  flagged; only the FIRST cell is exempt.
- Plain-string errors still enter the corpus — `isError` is
  `/^\s*\{\s*"error"/` only, so `"Error: connection refused to 10.0.94.0 after
  9400000 ms"` lands (R1 C-2's second bypass, half closed).
- `market_watchlist_add|remove|reseed`, `market_chart_render`,
  `market_chart_patterns` are `readOnlyHint:false` WRITES admitted by
  `market_\w+`; `northstar_\w*read\w*` matches no registered tool (dead branch).
