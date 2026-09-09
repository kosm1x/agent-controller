# V8.5 Phase 5.2 — Rule of Two (R1, 2026-08-15): FAIL, 1 Critical

Scope: `src/tools/rule-of-two.ts` (new), `types.ts` structural rule, `registry.ts`
delegation + ALS record, V8.3 `pipeline.ts` step 2a / `seed.ts` / `promotion.ts`,
`dispatcher.ts` ALS wrap, `admin.ts` endpoint, `scripts/rule-of-two-audit.ts`.

## The doctrine crumb

**An "exact set" pinned over a registry the test never builds is a vacuous pin.**
The pinned trifecta test named itself "over the real registry" but `allHostTools()`
registered BUILTIN/WP/CRM/GWS + Google/Memory/Skills and **no `McpToolSource`**.
The audit script's `--offline` mode had the identical hole, and its LIVE mode
needs a deploy that hadn't happened (endpoint 404s pre-deploy). So every
verification surface in the ship was blind to the same 43 tools.

Corollary: when a ship classifies tools **by name prefix**, the prefix table is
the part that must be tested against the *config file*, not against a hardcoded
list of the prefixes it already contains.

## What that hid

`xpoz__xpoz_trigger_run` low→high + `requiresConfirmation:true`. Chain:
`mcp-servers.json` server `xpoz` → prefix default `["xpoz__", AB]` →
`annotations.ts` `DESTRUCTIVE_VERBS` includes `xpoz_trigger_run` ⇒
`readOnlyHint:false` ⇒ A∧B∧C ⇒ structural high ⇒ `task-executor.ts:93`
returns CONFIRMATION_REQUIRED on every interactive launch.
Verified against the live journal (43 MCP tools, boot Aug 14 20:39) — exactly
1 of 43 flips; the other 42 are safe because `browser__`/`playwright__` are
A-only and `graphify-code__` is B-only.

## Second doctrine crumb — ALS run-composition fails OPEN at every boundary

`enterRunToolContext` at `dispatcher.ts:619` is the ONLY entry point. Blind and
silent (empty prior = no demotion) across:
- container workers (`nanoclaw-runner.ts:113`, `heavy-runner.ts:181` — separate process)
- **swarm sub-tasks** (`swarm-runner.ts:588,763` re-enter via `submitTask` ⇒ a
  FRESH context) — the exact fan-out shape the doctrine targets
- `reflection/runner.ts:159` (its own comment says "ran outside the dispatcher")
- the dispatcher fast-fallback (`dispatcher.ts:694`) opens a new context

And it has **zero test coverage** — the e2e tests call `enterRunToolContext`
themselves, so deleting the dispatcher wrap turns nothing red and the whole
layer becomes dead code in the fail-open direction.
**Rule: when a layer's only wiring point fails OPEN, its absence must be
detectable — test the wiring point, not just the chain below it.**

## Third crumb — prototype keys defeat "unknown = riskier"

`RULE_OF_TWO_CLASSIFICATION[tool.name]` (line 304) + `name in TABLE` (line 316).
Empirically: `resolveRuleOfTwo({name:"constructor"})` ⇒ `{}` (A=B=undefined ⇒
falsy ⇒ **no** trifecta), while `isRuleOfTwoClassified("constructor")` ⇒ `true`.
So a prototype-named tool reads as "classified ✓" to BOTH the coverage test and
the audit script's `unclassified: 0 ✓` line, and gets no confirm.
**Any name-keyed safety table whose default is "riskier" must use
`Object.hasOwn` — bare `[]`/`in` inherit 8 falsy escape hatches.**

## What was verified CLEAN (don't re-audit)

- Host registry: exactly the 4 signed flips (`google_workspace_cli`,
  `kb_ingest_pdf_structured` low→high; `skill_run`, `wp_raw_api` medium→high);
  `jarvis_dev` already high; 0 unclassified over 191 host tools; `shell_exec`,
  `jarvis_file_read`, `gmail_send`, `memory_*` unchanged.
- No boot error from the `skill_run` seed 2→1 vs live row max_level 2:
  `assertSeedInvariants` runs on the SEED constant (cap 1, `1 > 1` false) and
  `INSERT OR IGNORE` returns `changes:0`. Row drift is *reported*, not thrown.
- Pipeline can never RE-RAISE: `out_of_odd`/`not_reversible`/linkage all guard
  on `>= 3`, unreachable once 2a clamps to 1.
- No consumer switches on the `autonomy_demoted` payload `reason` — the schema
  CHECK constrains `event_kind` only. New reason strings break nothing.
- No import cycle: `rule-of-two.ts:48` is `import type` (erased); the runtime
  edge is one-way `types.ts` → `rule-of-two.ts`; `rule-of-two.ts` imports
  nothing from `lib/v8-3`.
- ALS itself: no cross-task leak (fresh store per `run()`), composes correctly
  with `ritualContext` (outer/inner), `recordRunTool` cannot throw, Set bounded
  by distinct tool names.
- better-sqlite3 `readonly` open of the LIVE WAL mc.db: fine — ran against the
  running service, 880 runs / 6844 rows returned.

## Reporting bug worth remembering

`scripts/rule-of-two-audit.ts:136` dedups the call list **first-seen**, so a run
that calls `gmail_send` → `gmail_read` → `gmail_send` drops the post-arming
second call and never counts `gmail_send` as a terminal edge. The headline
"88 runs had a GATED capability as a terminal edge" is a LOWER BOUND presented
as the blast-radius number. **Dedup is safe for an OR-fold, wrong for an
ordering-dependent attribution — don't share one list between both.**
