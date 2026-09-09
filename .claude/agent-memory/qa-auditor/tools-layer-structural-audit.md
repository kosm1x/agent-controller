---
name: tools-layer-structural-audit
description: src/tools structural/duplication audit (2026-07-05) — tool skeleton, no shared HTTP/error helpers, name redundancy, checks-framework single-consumer
metadata:
  type: project
---

# Tools layer structural audit — 2026-07-05 (READ-ONLY)

Scope: src/tools/ (39,398 non-test LOC, 108 files, 189 production tools). Verdict: ~10-15% (4-6k LOC) eliminable via shared infra; rest justified by BREADTH (189 tools across dozens of external services), not feature bloat. Smell = MISSING shared infrastructure, not gratuitous code.

## Tool contract (verified)
- `Tool` (src/tools/types.ts): `name` + `definition` (raw OpenAI JSON-schema, NOT Zod — `z.object`=0, `.describe()`=0 in builtin; CLAUDE.md's ACI "add .describe()/z.enum" describes an approach the layer does NOT use — it uses JSON-schema `description:`/`enum:[]`, functionally equivalent) + `execute(args):Promise<string>`.
- registry.ts:39 registers keyed by `tool.name`; getDefinitions (119-132) sends `t.definition` → LLM sees `definition.function.name`; execute (186) looks up by that name. **189 tools declare their name TWICE** (top-level `name:` @ ~L66 + `definition.function.name` @ ~L75). NO test asserts they're equal. Scan 2026-07-05: 0 live mismatches → LATENT drift risk (mismatch → "Unknown tool" unless findClosest fuzzy-saves).

## Measured duplication (grep counts, not guesses)
1. **fetch+AbortController+setTimeout+!ok+catch/clearTimeout skeleton** — 13 files hand-roll it (weather.ts:76-118 canonical). NO shared `fetchJson()` helper anywhere in src (verified). Two timeout idioms coexist: manual AbortController (13 files) + AbortSignal.timeout (15). `src/lib/with-timeout.ts` exists but wraps promises, not fetch.
2. **`err instanceof Error ? err.message : String(err)`** — 153 occ / 58 files (weather.ts:114). No `errMsg(e)` helper.
3. **Three error conventions coexist**: `return "Error:..."` (27) + `{error}` JSON (505) + `{success:false}` (72). task-executor.ts:136-160 must check ALL THREE to detect failure for mutation logging. LLM sees inconsistent error shapes.
4. **637 `return JSON.stringify`** — no shared `ok()`/`err()` response formatter.
5. **`type:"function", function:{...}` wrapper nesting** ×189 = ~380 structural lines a `defineTool()` factory would erase.

## Single-consumer "framework"
- `ads-references/checks-framework.ts` (1096 LOC) — imported by exactly ONE file (ads-audit.ts:21). Framework with one consumer → inline or demote to module.

## Duplicated sibling clients / parallel engines (merge/extract candidates)
- wordpress.ts vs wordpress-admin.ts each independently define `getSites`/`resolveSite`/`wpFetch` (admin does NOT import wordpress.ts) → extract wp-client.ts (~40-60 LOC).
- paper-trading.ts vs pm-paper-trading.ts (363+383) share fmt/fmtPct/positions/fills/balance/summary/initialCash/adapter symbols → equity vs Polymarket engines, ~60% shared skeleton. Same for alpha.ts vs pm-alpha.ts.

## What is NOT a problem (verified negatives)
- N+1/unbounded SQL: this layer is HTTP-bound not DB-bound. SELECT * = 1 (video.ts:90, job-store), .all() = 7, 46 prepare total. No systemic N+1.
- Big files are genuine: video.ts (1764, 91 ffmpeg/compose markers), northstar-sync.ts (1552, real REST sync engine), market.ts (1695, 14 THIN tools delegating to finance/data-layer.js — the RIGHT pattern, 0 fetch). Volume = verbose JSON schema, not logic bloat.
- Description governance EXISTS: registry.test.ts DESC_THRESHOLD=1500 + 16 documented over-long exceptions + drift-cap tests.

## DOCTRINE
- A tools layer's LOC is dominated by (a) irreducible per-service integration + (b) ACI schema/description prose (the product). Judge bloat by MISSING shared infra (fetch/error/response/tool-factory helpers), not by raw LOC. 189 tools × hand-rolled skeleton is the tax.
- "name declared twice, synced by hand, no test" is the cheapest high-value guard to add: one registry.test assertion `tool.name === tool.definition.function.name` for all ALL_TOOLS.
