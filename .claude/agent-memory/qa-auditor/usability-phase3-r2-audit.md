---
name: usability-phase3-r2-audit
description: R2 audit of usability plan Phase 3 (numbers with provenance) 2026-08-23 — FAIL, 5 Critical. Bug classes: readOnlyHint is a RISK annotation, not an EVIDENCE class; a detector tightened out of its own motivating shape; a two-step launder through a gated writer; SSRF via DNS names + redirects.
metadata:
  type: project
---

# Usability Phase 3 R2 — folds verified (2026-08-23)

**Verdict: FAIL.** 5 Critical, 10 Warning. All 7 R1 Criticals were folded and
each fold is mutation-pinned (removing it turns a test RED). The new Criticals
are what the folds broke or missed.

## Bug classes worth carrying forward

### 1. `readOnlyHint` is a SIDE-EFFECT RISK annotation, not an EVIDENCE class
R1-C4 narrowed the evidence corpus from "every tool result" to
`tool.readOnlyHint === true`. That excludes `shell_exec` (`shell.ts:760
readOnlyHint:false` — correct: it can write) — the codebase's **#2 tool**
(1,034 calls/30d) and the primary numbers producer. Proven: a run where
`shell_exec` returned `94 filas procesadas` still had the write REJECTED with
"Ninguna aparece en los resultados de herramientas de lectura de esta corrida".
The same gate's rejection text tells the model to write `fuente: shell_exec …`
and `CHECKABLE_SOURCE_RE` accepts it — three files disagree with the filter.
Also excludes `http_fetch` and EVERY MCP-bridge tool (mcp.ts sets no hints).
**Rule:** when narrowing a set by an existing annotation, enumerate the members
the annotation drops and check them against the feature's OWN doc/message text.

### 2. Tightening a detector can remove its motivating shape
The C1 fold cut FPs from 23.2% to ~2–3% (68/189 marked, 294 figures — replay
reproduces the claimed numbers) — but bare counts in a MARKDOWN TABLE are now
invisible: `| Filas | 34 |` → `found: []`, while `Filas: 34` → `["34"]`.
"34 stat rows where 17 exist" is the incident quoted in the gate's own header.
Sheets are fine (`cellsToText` renders a numeric cell as `<n> registros`);
KB/Docs text is not. **Rule:** after tightening, re-run the ORIGINAL incident
through the detector, not just the FP corpus.

### 3. A gate whose label is unchecked launders through its own artifact
`jarvis_file_write` with `fuente: shell_exec wc -l ventas.csv` (label never
verified) → `jarvis_file_read` (readOnly ⇒ corpus) → `gsheets_write` of the
same figure with NO fuente → ACCEPTED. The "documented residual"
(`file_write`→`file_read`) is not the only one: every readOnly reader of a
model-authorable target is a vector (`jarvis_file_read`, `grep`, `glob`,
`code_search`, `gdocs_read_full`, `gdrive_download`).

### 4. SSRF: the sync validator + default redirect-follow
`citationUrlBlocked` → `validateOutboundUrl` (string/regex). The async
`validateOutboundUrlResolved` exists in the same file and is unused. Literal
IPs are solid (`2130706433`, `0x7f000001`, `017700000001`, userinfo all
normalize+block). Live-proven holes: a public DNS name resolving to loopback
(`localtest.me`, `spoofed.burpcollaborator.net`) and a 302 from a public host
to `127.0.0.1` — `fetch` is called with no `redirect` option.

### 5. Style-family recurrence in a title parser
R1-C7 added an APA-first branch to `titleOf`; the fallback
(`parts.sort((a,b)=>b.length-a.length)[0]`) still returns the AUTHOR LIST for
Vancouver: `titleOf("He K, Zhang X, Ren S, Sun J. Deep residual learning.
Proceedings…")` → `"He K, Zhang X, Ren S, Sun J"` → live Crossref verdict
`missing` → the real paper is DELETED with "⚠️ Quité 1 referencia que no
existe". **Rule:** fixing a parser for ONE citation style pins that style; probe
the family (APA/Vancouver/Chicago/Spanish) before claiming the class is closed.

## What is CLEAN (do not re-flag in R3)
- C2 grammar: all 29 probes correct (`1,5 millones`, `3.800 millones`,
  `1.234,56`, `1,234.5`, `-45,000`, `−12%`, `USD 1.2B`, `MXN$ 2,500`; correctly
  skips `12:30`, `10.0.94.7`, `v1.2.3`, `2026-08-23`, `50/50`, `3x`, `1/2`).
- C5 folds: `fuente: api|memoria`, `calc: nada`, `supuesto: .`, "Por ejemplo",
  backticked currency, HTML `<td>`, URL on another line — all still flagged.
  Sheet per-row `fuente:` scoping, numeric `values`, Docs `content_file` gated.
- `applyDrops` no longer corrupts code (`[2]` stripped in prose, kept in fences
  and inline code). `REF_HEADING_RE` rejects `**Fuentes escaneadas:** 18`.
- C3 ordering: no realizable race (`recordUserEvidence` on the microtask after
  `await submitTask`; no tool call without a network await). `takeToolEvidence`
  runs before the citation check and the gates; no late writes.
- W1 metric folded (sums `unsourced` regardless of `rejected`); `days` is
  `/^\d+$/`-validated so the raw `sinceIso` interpolation is safe.
- W9/W10 `withDeterministicGroups` pure + no-op on empty/destructive;
  `NOT_TICKER` probed on 45d of `scope_telemetry.message` → only `$TV` ×2,
  already stoplisted.
- `digitsSupported`'s RegExp cannot throw (`/^\d+(\.\d+)?$/` guard rejects
  `1e+21`); 262/262 scoped tests green; tsc clean.

## Mutation-verify (all three folds pinned)
- remove `p2.push(figuresProvenanceSection())` → router.test RED.
- remove `tool.readOnlyHint === true` → registry.test RED.
- stub `citationUrlBlocked` → `null` → citations.test RED.
