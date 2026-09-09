---
name: sdk-bump-0-3-245-r1-audit
description: R1 audit of claude-agent-sdk 0.3.207→0.3.245 + npm-12 allowScripts block (2026-09-01) — PASS WITH WARNINGS, 0 Critical
metadata:
  type: project
---

# SDK bump 0.3.207 → 0.3.245 + `allowScripts` — R1 (2026-09-01)

**Verdict: PASS WITH WARNINGS, 0 Critical. Ship-blockers: none.**

## Doctrine crumbs (reusable)

- **An `else if` chain with no trailing `else` is the SAFE shape for a stream
  loop.** `claude-sdk.ts:839/951/959` handles `assistant` / `system` +
  `model_refusal_fallback` / `result` and nothing else. Every frame class the
  bump added (`system/permission_denied`, `tool_result_meta`, `mcp_status`,
  `queued_turn_count`, `aborted:true`, `timestamp`) falls through silently — no
  throw, no misclassification. When auditing a "new stream frame" changelog,
  the question is *"is there a terminal `else` that throws or mis-buckets?"* —
  if not, additive frames are inert by construction.

- **Check the built image's lock label to answer "will npm 10 handle this
  lockfile?" empirically instead of reasoning.** `docker inspect --format
  '{{index .Config.Labels "mc.lock-sha256"}}'` matched `sha256sum
  package-lock.json` byte-for-byte, so the image WAS built from the new
  lockfile by npm 10.9.9 — and it installed only `claude-agent-sdk-linux-x64`
  (391 MB `claude` binary present), not the musl sibling. npm 10.9.9 honors the
  new `libc` arrays. No reasoning needed once the label matches.

- **`npm install-scripts ls` is the read-only completeness proof for an
  `allowScripts` allow-list.** Returned "No packages with unreviewed install
  scripts." A hand-written node walk of `node_modules` independently found
  exactly 5 names with install lifecycle scripts (baileys, better-sqlite3,
  esbuild, protobufjs, sharp) — all 5 listed. Two independent probes, same
  answer.

- **Name-only `true` beats pinned `pkg@1.2.3` for BUILD-CRITICAL native deps,
  because the failure mode of a stale pin is a SILENT SKIP, not an error.**
  `npm help install-scripts`: "Install commands silently skip lifecycle scripts
  for any dependency that does not have a matching entry." A pinned
  `better-sqlite3@12.4.1` that drifts one patch = no native binding, discovered
  at `require()` in production. `min-release-age=7` is the compensating control.

- **Read a denied install script before claiming the denial is safe.**
  `protobufjs/scripts/postinstall.js` only `process.stderr.write`s a
  version-scheme WARN (no build output); `baileys/engine-requirements.js` is
  `if (major < 20) process.exit(1)` and our engines are `node>=22`. Both
  denials are provably inert — quoting the script beats asserting "postinstall
  is probably benign".

- **npm 10 IGNORES `allowScripts`, so a script-denial control declared in
  package.json is NOT enforced anywhere the image builds.** Host npm 12 honors
  it; `Dockerfile:40` pins `npm@10.9.9`, so inside the image all 5 scripts run.
  A supply-chain control that lives in a field only the newer client reads is
  half-applied — check EVERY installer's version, not just the dev box's.

- **A cost-multiplier changelog item is only Critical if a hard threshold is
  ARMED.** 0.3.239 adds a 1.1× US-inference multiplier to `total_cost_usd`
  (persisted at `claude-sdk.ts:993`, `:1044`, via `recordCost` `:1218`).
  `/health` reported `budget.enabled=false, enforce=false`, so `maxBudgetUsd`
  is never forwarded and `BudgetExhaustedError` never throws — Warning, not
  Critical. But the live daily window sat at **$44.84 / $50 (89.7%)**, so the
  QUEUED arming pre-flight must resize windows on post-0.3.239 figures.

- **`tools: []` is the evidence that makes built-in-tool changelog items N/A.**
  0.3.233 (Todo/Task no longer default-on) and 0.3.217 (subagent depth 5→1) are
  both moot: `claude-sdk.ts:706` sets `tools: toolSearchEnabled() ? ["ToolSearch"] : []`
  and `allowedTools` (`:626-636`) is built solely from `mcp__jarvis__*` names.
  Grep for the tool names anyway — `TaskListRow` / `TaskCreatedPayload` are our
  own symbols and are FALSE POSITIVES for a `TaskCreate|TaskList` grep.

- **Tripwire fields verified against the TYPES are not verified against the
  RUNTIME when the consumer casts to `unknown`.** `warnIfDeferredToolUnresolved`
  (`:1260`) reads `terminal_reason` / `deferred_tool_use` off an
  `as { ... }` cast, so `tsc --noEmit` clean proves nothing about them; same for
  the `_meta['anthropic/alwaysLoad']` carrier at `:273`. Both literals ARE still
  in 0.3.245 (`TerminalReason` retains `tool_deferred` + `tool_deferred_unavailable`;
  sdk.d.ts:521 still documents the `_meta` carrier) — but zero tests pin them
  (`grep terminal_reason src/**/*.test.ts` = 0 hits). The live harness
  `scripts/validate-tool-search.ts --run` is the only real proof; it is a
  documented per-bump trigger at `docs/planning/next-sessions-queue.md:124`.

- **0.3.211 "process-exit errors now include the CLI's stderr" is a near-miss
  for `/aborted/i.test(errorMsg)` at `claude-sdk.ts:368`** — an unanchored regex
  that would mis-route a crash to the no-retry abort branch if stderr ever
  carried the word. It does NOT fire in practice because `queryClaudeSdk`'s own
  `catch` (`:1104`) swallows every SDK error and returns a degraded result
  instead of throwing, so the outer fallback rarely sees SDK error text. Log the
  shape; don't inflate it.

## Not verified (stated in the report)

- Whether our API responses actually report `inference_geo: "us"` — needs a
  live probe; the 1.1× may not be active at all.
- `tool_result_meta` has 0 occurrences in 0.3.245 `sdk.d.ts` (changelog says
  0.3.216 added it). Irrelevant — the loop has no `user` branch.
- The eval gate and `validate-tool-search.ts --run` were run by the parent
  session, not by this audit.
