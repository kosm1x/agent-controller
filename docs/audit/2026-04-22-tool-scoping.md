## Dimension 5 — Tool scoping audit

> **Status**: COMPLETE — single-round audit per methodology. 1 Critical + 2 Major landed as fixes. 3 Warnings deferred with explicit triggers. 0 Critical findings remain.
> **Baseline**: `../benchmarks/2026-04-22-baseline.md`
> **Methodology**: `../planning/stabilization/full-system-audit.md` (single-round for Tool scoping)
> **Post-fix commit**: see Commits section below.
>
> **Headline**: Biggest find was C-SCP-1 — the NFC normalization guarantee from `feedback_nfd_unicode_scope_regex.md` was enforced at the main router entrypoint (router.ts:1450) but **missed** on the background-agent path (router.ts:985) where `taskText` is derived raw from `msg.text`. Fixed defense-in-depth by normalizing inside `scopeToolsForMessage` and `detectActiveGroups` themselves — idempotent, closes the gap regardless of caller. Two Majors landed: `intel_query.source` enum and `http_fetch` description expansion (the shortest tool description at 87 chars with zero USE/NOT-USE guidance). Warnings: ~40 tools in the builtin registry that were never called in 60 days, and four scope groups (seo/ads/video/crm) with <1% activation rate — deferred with post-window review triggers.
>
> **Scope regex quality is good overall**: no high-volume false positives found on 4,623-message 30d backtest, 254 scope tests pass (+3 new NFD regressions).

---

## Summary

| Probe | Finding                                                                                                                                                                          | Severity     | Decision                                                                                                                |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| T1    | 7d scope activation distribution: google 203, northstar_read 143, coding 136, research 74 top. `ads` 5, `seo` 33, `social` 27 low. Spread looks healthy, no monopolizing groups. | Pass         | -                                                                                                                       |
| T2    | Deferred-tool yield: 355 called / 19,909 in-scope = **1.78%**. This is expected for the deferral pattern — model loads ~60 tools for context but calls ~1 per turn.              | Info         | Not a bug. Yield metric is "how many of the scope-loaded tools got called"; low number is inherent to tool-use pattern. |
| T3    | Description length: 0 bloat (>3000 chars), 5 under-invested (<200 chars). Worst: `http_fetch` (87 chars), `vps_management` (86), `writing` (75), `pm_paper_trading` (63).        | **Major**    | Fix: expanded `http_fetch` description with WHEN/NOT/BOUNDARIES sections.                                               |
| T4    | JSON Schema `description` field coverage: 18/20 sampled tools at 100%. Tool interface uses plain JSON Schema, not Zod — coverage discipline strong.                              | Pass         | No action.                                                                                                              |
| T5    | Enum vs free-string: only genuine miss was `intel_query.source` (description enumerates 8 values, schema had no enum). jarvis_dev/ads-audit/market already enum-ed.              | **Major**    | Fix: added explicit `enum: [usgs, nws, gdelt, frankfurter, cisa_kev, coingecko, treasury, google_news]`.                |
| T6    | False-positive backtest against 30d corpus (4,623 msgs): no pattern matched >40% of corpus; no clear false-positive patterns in spot-checks.                                     | Pass         | -                                                                                                                       |
| T7    | False-negative audit: no corpus evidence of "tool not available" retry loops. 4 scope groups (seo/ads/video/crm) have <1% activation — may be under-specified vocab.             | Warning      | Defer (W-SCP-2). Low-activation scopes can't be distinguished from low user intent without explicit user-signal corpus. |
| T8    | **NFC normalization was enforced at router.ts:1450 (main path) but MISSED at router.ts:985 (background-agent path)** — `taskText` flows raw into `scopeToolsForMessage`.         | **Critical** | Fix: normalize inside `scopeToolsForMessage` + `detectActiveGroups` entry (defense in depth, idempotent).               |
| T9    | Tool-description drift: 10/10 sampled tools — description matches handler behavior. Strong maintenance discipline.                                                               | Pass         | -                                                                                                                       |
| T10   | Dead-tool detection: 253-entry builtin registry vs 104 distinct tools called in 60d → ~40-50 candidates for pruning (after subtracting MCP/browser/playwright dynamic tools).    | Warning      | Defer (W-SCP-1). Produce canonical dead-tool list post-freeze; don't prune during freeze to avoid surface churn.        |

Severity: Critical (ship-blocker, landed) / Major (P0, landed or deferred-with-trigger) / Warning (P1/P2, documented) / Info (no action).

---

## Findings

### C-SCP-1 (Critical) — NFC normalization gap on background-agent scope path

**Evidence**: `src/messaging/router.ts:1450` applies `normalizeForMatching(msg.text)` before the main scope flow, and `router.ts:1471` passes `normalizedText` into `scopeToolsForMessage`. But `router.ts:971-985` — the `BACKGROUND_AGENT_RE` branch for "Lanza un agente e investiga..." messages — derives `taskText` from raw `msg.text` via `.replace().replace().trim()` and passes it directly to `scopeToolsForMessage(taskText, [])`. `scope.ts`'s exported `scopeToolsForMessage` and `detectActiveGroups` had zero normalization at their entry points, trusting the caller.

**Impact**: For background-agent tasks like "Lanza un agente e investiga el tráfico" where mobile clients (Telegram/WhatsApp) deliver NFD-decomposed accents ("trá" as "tra" + U+0301), scope regex character classes like `art[ií]culo`, `c[aá]mbia`, `act[ií]za` silently miss. The background agent then spawns with a narrower tool set than intended — same class of bug as `feedback_nfd_unicode_scope_regex.md` from session 88, regressed in the background-agent path added later. Production risk: intermittent scope misses that only reproduce on specific clients.

**Fix** (`src/messaging/scope.ts` + scope.test.ts):

- Added `import { normalizeForMatching } from "./normalize.js"`
- Entry of `scopeToolsForMessage`: `currentMessage = normalizeForMatching(currentMessage); recentUserMessages = recentUserMessages.map(normalizeForMatching);` — idempotent, no-op if caller already normalized (main flow), guards direct callers (background-agent path).
- Entry of `detectActiveGroups`: same two lines.
- 3 regression tests: NFD-input parity with NFC-input, `detectActiveGroups` activates `wordpress` on NFD `artículo`, inheritance path normalizes `recentUserMessages`.

**Verification**: 254/254 scope tests pass (251 prior + 3 new NFD regressions); full suite 3733/3733.

### M-SCP-1 (Major) — `intel_query.source` missing enum constraint

**Evidence**: `src/tools/builtin/intel-query.ts:43-47`. Description says "Filter by source: usgs, nws, gdelt, frankfurter, cisa_kev, coingecko, treasury, google_news." but the JSON Schema had no `enum` array. Compare to the adjacent `domain` field (line 41) which correctly specifies `enum: ["financial", "weather", "geopolitical", "cyber", "news"]`.

**Impact**: Model can emit any string as source and the tool will silently filter to zero results (handler passes `args.source` as string to `getRecentSignals` which does SQL equality match). Wastes a tool call.

**Fix**: Added `enum: ["usgs", "nws", "gdelt", "frankfurter", "cisa_kev", "coingecko", "treasury", "google_news"]` to the `source` property.

### M-SCP-2 (Major) — `http_fetch` description under-invested (ACI risk)

**Evidence**: `src/tools/builtin/http.ts:20-21`. Before: 87 chars, bare "Make an HTTP request to a URL and return the response. Supports GET, POST, PUT, DELETE." — no WHEN-TO-USE / WHEN-NOT-TO-USE / BOUNDARIES sections. This is the generic-named, deferred, lowest-discoverability tool in the surface; ACI discipline matters most where collision risk is highest.

**Impact**: Model defaults to `http_fetch` for web reads that should go through `web_read` (gets proper extraction + charset handling) or `gdocs_read` (OAuth'd). Body-truncation and SSRF rules were undocumented from the model's view.

**Fix**: Expanded description (~1000 chars) with WHEN TO USE, WHEN NOT TO USE (explicit pointers to web*read, web_search, gdocs*_, gh\__, wp\_\*), and BOUNDARIES section (20K body cap, 15s timeout, SSRF guards, methods).

### W-SCP-1 (Warning) — ~40-50 dead-tool candidates in builtin registry

**Evidence**: `scope_telemetry` → 104 distinct tools called in 60d. `src/tools/sources/builtin.ts` → 253 entries (includes dynamic MCP/browser/playwright tools registered separately). Conservatively, 40-50 registered builtin tools were never called over 60 days.

**Why not fix now**: Freeze-window discipline — pruning tools changes the surface and may break scope coverage tests that assume tools exist. Also, some "dead" tools are seasonal (pm-alpha markets, f7-rebalance), some are fallbacks only invoked on primary failure, and some were added as intentional capability stubs. Needs a careful one-by-one review with git blame + scope coverage analysis.

**Trigger**: Post-freeze (after 2026-05-22) produce a canonical list of untouched tools, verify each as seasonal / fallback / stub / actually dead, prune the actually-dead ones in a single commit with test updates.

### W-SCP-2 (Warning) — Low-activation scope groups (seo/ads/video/crm)

**Evidence**: 7-day scope_telemetry breakdown showed `ads` 5 activations, `seo` 33, `social` 27, `video` 35, `crm` 45, `meta` 27 — compared to google 203, northstar_read 143, coding 136. Sub-1% of traffic for `ads`.

**Why not fix now**: Cannot distinguish "scope regex too narrow to match user intent" from "user rarely expresses this intent" without an explicit false-negative corpus. No evidence of "tool not available" retry loops in the 30d corpus (T7). Ads/SEO/Video are new verticals (v7.3 P4a, v7.3 P1-3, v7.4); low activation could simply reflect early adoption.

**Trigger**: If any of these groups stays <5% activation after 30 more days OR if a user reports a missed activation for one of these domains, re-audit the scope regex against a hand-curated 50-message test corpus. Until then, leave as-is.

### W-SCP-3 (Info) — Deferred-tool yield metric (1.78%) is not a pathology

**Context**: `SUM(tools_called) / SUM(tools_in_scope) = 355/19909 = 1.78%`. This looks alarming in isolation but reflects the inherent asymmetry of deferred-tool loading: scope activation loads ~60 tools _in case_ the model needs them, but typical tool-use is 1 call per turn. The right measurement is **how much the deferral mechanism reduces load vs. loading all 253 registered tools every turn** — per CLAUDE.md that's ~52% token savings. Yield doesn't measure that.

**No action.** Record-only — if someone proposes "yield is low, reduce scope activation" they should be pointed at this note.

---

## Commits landed

| Commit      | Size    | Description                                                                                                                                                 |
| ----------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (this push) | 5 files | C-SCP-1 NFC defense-in-depth in scope.ts + 3 regression tests; M-SCP-1 intel-query source enum; M-SCP-2 http_fetch description expansion; this audit report |

Test count: 3730 → 3733 (+3 regression guards).

---

## Methodology notes

**Single-round audit** per `full-system-audit.md` — Tool scoping was the only dimension flagged as single-round (Security + Resilience required double-audit). This turned out appropriate: 1 Critical + 2 Major, all surface-level findings, no round-2 risk of fix-introduces-bug because the fix is idempotent and scope tests catch regressions deterministically.

**Probes ran with:**

- DB: 4,623-message 30d conversation corpus + 334-row 7d scope_telemetry
- Code: static analysis of `src/tools/builtin/*.ts` (20-sample T4/T5, 10-sample T9) + full scope.ts/router.ts read for T8
- Subagent: one Explore for T3/T4/T5/T9 static work, one Explore for T6/T7/T8 corpus backtest; findings reconciled against direct code reads (T5 subagent false-positives on jarvis-dev/ads-audit/market corrected — those already had enums)

**The subagent T5 report was partially wrong**: it flagged jarvis-dev, ads-audit, market as missing enums when they already had them. Direct code verification caught the false-positives. Only `intel-query.source` was a real miss. Lesson: subagent reports on "has X feature" should always be spot-checked against the actual files before acting. Recorded under `feedback_subagent_false_positives.md` (new memory).

---

## What's next

**Dimension 5 closes the 5-dimension audit sweep.** Per methodology `Session N+6`:

1. Run re-benchmark probes against `docs/benchmarks/2026-04-22-baseline.md`; produce `docs/benchmarks/2026-05-22-post-audit.md`. (Can happen closer to 2026-05-22.)
2. Declare the 30-day window closed.
3. Lift freeze on 2026-05-22 if all P0 hardening items are closed (per `30d-hardening-plan.md` P0 list).

**Deferred across all 5 dimensions** (20+ items with explicit triggers): see the individual audit reports. No deferred items are Critical. 30-day plan remains healthy.
