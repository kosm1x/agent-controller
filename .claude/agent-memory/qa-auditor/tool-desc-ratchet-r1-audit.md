---
name: tool-desc-ratchet-r1-audit
description: R1 audit of the not-for description ratchet + harness safety-invariant suite (mission-control, 2026-09-12, commits 5192508/62517d2) — FAIL, 2 Critical
metadata:
  type: project
---

# tool-description ratchet + safety invariants — R1 (2026-09-12)

Verdict **FAIL**, 2 Critical. `npx vitest run src/tools/description-lint.test.ts src/tools/registry.test.ts src/tuning/safety-invariants.test.ts` = 40/40 GREEN; tree clean after mutation work (md5 restore, never `git checkout --`).

## Reusable bug classes found

- **A sibling pointer in a tool description is an executable claim.** Two of 30 named siblings do not exist: `northstar_index` (northstar-sync.ts:956) and `paper_trade` (pm-paper-trading.ts:55). Worse than a dead pointer: `adapter-openai.ts:1678` runs `ToolRegistry.findClosest` (Levenshtein ≤ 30% of length) on unknown names, and `northstar_index`→`northstar_sync` at d=5 with maxDist=5 — a read-intent line silently repairs to the destructive bidirectional sync. **Always compute `findClosest` on a phantom name before rating severity** — null (paper_trade) is a wasted turn, a hit is a misfire.
- **A lint ratchet over ONE source array covers only that source.** `description-lint.test.ts:55` builds `ALL` from `BUILTIN_TOOLS+CRM+GWS+WP` (162). The google (22), memory (5) and skills (5) sources register via `registerTools()` and are invisible — 32/194 static tools, incl. 3 of the 22 tools backfilled by the same commit (`calendar_*`). Enumerate every `ToolSource` before believing a registry-wide claim.
- **A proxy regex admits the OPPOSITE of what it screens for.** `USE [^\n]* INSTEAD` (case-insensitive) matches positive recommendations: `jarvis_file_move` passes the ratchet solely on jarvis-files.ts:696 `"THIS IS A TRANSPORT OPERATION — use it instead of jarvis_file_read + jarvis_file_write"`. Scan the LIVE corpus per alternation branch and separate strong from weak matches.
- **A source-grep wiring pin is brittle in both directions** (safety-invariants.test.ts:133). Proven by mutation: renaming the catch binding `err`→`caught` (behaviour identical) goes RED; adding `if (!(err instanceof TypeError)) throw err;` inside the catch (every real rejection escapes) stays GREEN. `[\s\S]*` between two anchors pins co-location, not control flow.
- **A "closed set" test that iterates the set is self-referential.** Adding `"bogus_reason_mutant"` to `TERMINATION_REASONS` keeps both safety-invariants.test.ts:152 and runners/termination.test.ts:10 GREEN; only the unknown→`error` fold is pinned. Pin membership with a literal expected array.
- **`journalctl -u <name>` returns "No entries" for a Docker stack, not an error.** jarvis-self-repair.ts:54 routes supabase logs to `vps_logs`; there is no `supabase.service` on this box, so the model reads empty logs as "no errors".
- `web_read` is NOT browser-free: web-read.ts:191/204 fall back to `stealthFetch` (headless Chromium) on a Cloudflare challenge — screenshot.ts:42 claims "cheaper, no browser".

## Mutation results (all restored, md5-verified)

RED: analyzeInjection→none for `rss_read`; `if (false &&` on the task-executor interactive gate; `if (false &&` on the confirmations args-hash check; `terminationFromExit` leaking unknown strings; claude-sdk catch removed.
GREEN (gaps): bogus member added to `TERMINATION_REASONS`; guarded-rethrow inside the claude-sdk catch.
