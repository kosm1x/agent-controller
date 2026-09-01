# Hermes upstream review — v0.15.0 → v0.21.0 (2026-09-01)

Review of `NousResearch/hermes-agent` releases shipped since the last review
(2026-05-22, v0.14.0): **18 releases, 7 minor versions** (v0.15.0 2026-05-28 →
v0.21.0 2026-08-31), ~375 KB of release notes. Memory:
`feedback_prometheus_upstream`. Cadence rule ("monthly, full-day if >2 minors")
was missed by ~2 months; this note is the catch-up.

## Method

1. Three parallel readers extracted ~120 Tier-1/Tier-2 candidates (verbatim
   quotes + PR numbers) from the notes, slices v0.15–0.17 / v0.18–0.19 /
   v0.20–0.21. Tier-3 (platforms, TUI/desktop, profiles, distribution, voice,
   provider catalog, skills content, operator slash-commands) summarised only.
2. Every Tier-1 candidate was **verified against the live codebase** (grep /
   read), then grounded in **30-day production data** before any decision:
   - `tasks` 30d: 831 total — `fast` 787 (660 completed, 117
     completed_with_concerns, 6 failed, 4 blocked), `heavy` 36, `nanoclaw` 6,
     `swarm` 2. The Claude Agent SDK `fast` path is the loop that matters.
   - `task.fallback` 6 · `task.failed` 7 · `task.watchdog_failed` 2.
   - Busiest task: 81 tool calls. Telegram `Send failed`: 0. Shell commands
     blocked by policy: 0. `jarvis_files` compaction rows: 0. Journal covers
     only 2026-08-25→ (7 d) — DB numbers are the 30-day truth.
3. Decision per candidate: **shipped / present / rejected-by-measurement /
   deferred-with-trigger / N/A**.

## Shipped (2)

### 1. Connect-time SSRF guard — Hermes v0.20.0 #70193 "DNS-pinned SSRF-safe fetches"

- **Gap (pre-existing, documented in our own code):** `validateOutboundUrlResolved`
  checked the name _before_ fetch ran its own lookup — the header comment said
  "Residual TOCTOU … closing that fully needs a connect-time socket guard". A
  rebinding attacker (TTL 0) could reach hindsight :8888 (unauthenticated
  memory API), supabase :8100 or mission-control :8080 from inside the box.
  Tools that used only the sync `validateOutboundUrl` (seo-*, wordpress,
  gemini-research, pdf-read, screenshot) had no resolution check at all.
- **Fix:** `src/lib/url-safety.ts` — `safeDispatcher()` (one shared undici
  `Agent` whose `connect.lookup` re-resolves with `all:true` and drops blocked
  addresses → `SsrfBlockedError` code `ERR_SSRF_BLOCKED`) and `safeFetch()`.
  `safeFetch` follows redirects **itself** (≤20 hops, fetch parity), re-validating every hop
  with `validateOutboundUrl`, because `net.connect` never calls `lookup` for an
  IP-literal host — a `Location: http://127.0.0.1:8888/` hop would otherwise
  sail past the dispatcher on `redirect: "follow"` call sites. `manual` /
  `error` modes pass through (http_fetch and citations keep their own hop
  loops). Node's global fetch honours the npm-undici dispatcher (verified live:
  pinned-to-real-IP → 200, pinned-to-loopback → TLS alert).
- **Call sites:** `http.ts`, `seo-llms-txt-generate.ts`, `seo-robots-audit.ts`,
  `wordpress.ts` (image URL), `gemini-research.ts` (source URL),
  `lib/v8-4/citations.ts` (default fetchImpl), `lib/pdf.ts` (pdf-read + web-read), `gemini-research.ts` upload URL. `undici@7.29.0` promoted from a
  transitive dependency (opensandbox) to a direct exact one.
- **Evidence:** 19 new url-safety cases (lookup shapes, mixed records, rebinding
  flip, resolver errors, redirect to literal / metadata / scheme, relative
  Location, POST→GET on 303, manual/error passthrough, hop cap); mutant
  "filter disabled" → 4 RED; live probe: `example.com` 200, `http://github.com`
  followed → 200, `localhost` / `127.0.0.1` / `2130706433` refused, manual → 301.

### 2. Standing-orders guard — Hermes v0.21.0 #81152 "protected agent-instruction files require write approval"

- **Gap (pre-existing):** `directives/*.md` (21 rows: 3 enforce, 1 always-read,
  6 conditional) were protected by _description text_ ("DO NOT create new ones
  without user approval") plus a model-settable `confirmed:true` on delete.
  `upsertFile` replaces content **and resets `qualifier`** on conflict, so one
  prompt-injected `jarvis_file_write` could rewrite or silently disable a
  standing order. The gated path already existed: `jarvis_propose_directive`
  (add/modify/remove) → `jarvis_apply_proposal` (`requiresConfirmation` → real
  operator unlock in `task-executor.ts`).
- **Fix:** `immutable-core.ts` `canonicalKbPath` (trim, `\`→`/`, a leading `/` read as KB-relative, then ROOT-RELATIVE resolution `posix.relative(root, posix.resolve(root, p))`, lowercase — string normalisation alone let `../<kb-basename>/directives/x` back in) + `standingOrdersGuard(paths)`, wired into `jarvis_file_write`, `_update`, `_delete` (before
  the precious flow so `confirmed:true` cannot bypass), `_move` (both ends),
  `jarvis_files_batch_write` (whole batch refused before any write),
  `jarvis_files_batch_delete`; disk twin `isStandingOrdersDiskPath` (tree AND the bare directory) in `file_write`, `file_delete` (first check, symlink-resolved) and `code_edit` (symlink-resolved), plus a `shell_exec` `DENY_WRITE_PATTERNS` entry on `/jarvis-kb/directives`; `directives/` added to kb-reindex `MANAGED_NAMESPACES` so a disk-only directive never becomes a row. Error `STANDING_ORDERS_PROTECTED` names the proposal path. No code writer targets `directives/` outside the proposal tool
  (grep); 0 `jarvis_file_write` calls to it in 30 d traces (attrs carry no path;
  the two directives updated in 30 d were operator-side `upsertFile` writes).
- **Evidence:** 8 refusal tests (before any DB statement) + 6 spelling-bypass + 2 round-trip/bare-dir + 3 disk-path helper + 3 file_write/file_delete + 1 code_edit + 3 shell + 1 reindex; mutant
  "guard returns null" → 8 RED.
- **Follow-up (operator ruling, not shipped):** `qualifier: "always-read"` is
  model-settable on any path (8 rows: 5 projects/, 1 knowledge/, 1
  directives/, 1 root) and turns a file into an every-turn instruction surface
  — the same class one axis over. Downgrading it like `enforce` needs a ruling
  on who legitimately sets it (see queue).

## Confirmed already present (no action)

| Hermes item                                                                   | Ours                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v0.19 byte-stable system prompts (#67403)                                     | `identitySection` static + `CACHE_BREAK_MARKER`; no dates in the stable prefix                                                                                                                            |
| v0.19 `tool_call_id` dedup across sanitizers (#58350)                         | `session-repair.ts` pass 3                                                                                                                                                                                |
| v0.19 durable background delegation (#63494)                                  | sub-tasks are `tasks` rows; results survive restart by construction                                                                                                                                       |
| v0.19 / v0.18 per-task aux usage accounting                                   | V8.5 Phase 3 cost ledger (`0618119`)                                                                                                                                                                      |
| v0.18 post-turn review off the reply path + adaptive cadence (#49252)         | `background-extractor` fire-and-forget + `shouldExtract` gates                                                                                                                                            |
| v0.18 SIGTERM→SIGKILL escalation (#50489)                                     | `shell.ts` group kill, `container.ts` graceful→SIGKILL, `gate-check.ts`                                                                                                                                   |
| v0.18 cron ticker survives exceptions                                         | `rituals/scheduler.ts` try/catch per tick + heartbeat                                                                                                                                                     |
| v0.17 FTS5 `:` sanitisation (#40653)                                          | `jme.ts:313` strips to `\p{L}\p{N}` before `MATCH`                                                                                                                                                        |
| v0.17 scrub env before subprocess (#48423)                                    | `shell.ts` `buildScrubbedEnv()`, MCP stdio explicit `config.env`                                                                                                                                          |
| v0.16 invisible-unicode sanitisation (#37245)                                 | `guards.ts` `normalizeForDetection` / `detectEncodedInjection`                                                                                                                                            |
| v0.16 concurrent-compression session fork (#34351)                            | N/A — compaction is inline in a single sequential loop                                                                                                                                                    |
| v0.15 omit `tools` when empty (#33409)                                        | `adapter-openai.ts:490` sets `body.tools` only when non-empty                                                                                                                                             |
| v0.15 goal-graph cycle detection (#28088)                                     | `goal-graph.ts` Kahn                                                                                                                                                                                      |
| v0.15 periodic memory logging (#27102)                                        | `prometheus.ts` `collectDefaultMetrics` → `process_resident_memory_bytes`                                                                                                                                 |
| v0.15 refusal → `content_filter` (#46013)                                     | refusal never-silent floor `6b271fd` + API-error tail detector `d9f1f4a`                                                                                                                                  |
| v0.20/v0.21 oversized tool results spill instead of truncate (#89028, #77041) | OpenAI path `evictToFile` (12k chars, preview+TOC); SDK path: the CLI itself saves oversized MCP output to a file (`MAX_MCP_OUTPUT_TOKENS`, "Failed to save output to file" branch present in the binary) |
| v0.20 `[SKILL_PRUNED]` ghost-skill defence                                    | N/A — we never prune tool/skill definitions from context; tool search handles exposure                                                                                                                    |
| v0.20 Retry-After / credential reset-aware restore                            | `7d8ca81` honours Retry-After; single-key model, fallback is per-call                                                                                                                                     |
| v0.19 redaction of Telegram transport errors (#58893)                         | grammy client — `GrammyError` messages carry no token; raw `fetch` to `api.telegram.org/file/bot…` logs status only                                                                                       |

## Rejected by measurement (no evidence in 30 d)

- **Telegram 429 `retry_after` / drain-before-retry / delivery-obligation ledger
  (#67181):** 0 `[telegram] Send failed` lines; sends throw on any chunk error
  (deliberate, see `telegram.ts:636-647` — a resolved partial send would tally
  as consent). Re-open if a send failure ever appears in the journal.
- **Session-wide runaway caps for fan-out tools (#66600):** max 81 tool calls
  in one task; mean 8.5. No runaway.
- **Consecutive-denial circuit breaker (#72203):** 0 shell commands blocked by
  policy in the journal window; `checkPersistentFailure` covers all-error
  rounds on the OpenAI path.
- **1-hour prompt caching:** still rejected (May measurement stands).

## Deferred — with triggers

| Item                                                                                                                                                                            | Why deferred                                                                                                               | Trigger                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Temporal anchoring in compaction summaries (v0.17 #41102) — add "today is YYYY-MM-DD; resolve relative dates" to `STRUCTURED_COMPACT_PROMPT`                                    | compressor fires only on the OpenAI fallback (~6×/30 d); 0 summaries persisted                                             | first `compaction/*.md` row appears, or fallback traffic >5 %              |
| Strict redaction at compaction / snapshot boundaries (v0.20 #69294, v0.21 sweep) — `redactSecrets` before `upsertFile` in `context-compressor.ts` and on `prometheus_snapshots` | same cold path; `redactSecrets` 40-hex rule would mangle git SHAs the summary must preserve — needs a context-safe variant | same as above, or any secret found in `jarvis_files` `compaction/*`        |
| Live subagent orchestration / per-sub-task retry (v0.21 #85232 et al., v0.13)                                                                                                   | 2 swarm tasks in 30 d; design note with 4 questions already queued                                                         | ≥10 swarm tasks/month or the first lost sub-task result                    |
| Per-session turn lease (v0.19 #67401)                                                                                                                                           | no per-chat lock exists; no double-processing incident on record                                                           | first interleaved double-reply report                                      |
| Compaction cooldown escalation (v0.21 #79741)                                                                                                                                   | k=2 exhaustion guard covers the observed failure                                                                           | a `compaction_exhausted` exit in production                                |
| TTFB / stall watchdog on the OpenAI stream (v0.15 #32042, v0.21 #87236)                                                                                                         | fallback path only; SDK handles its own streaming                                                                          | streaming-truncation incident on the fallback path (unchanged since April) |
| `always-read` qualifier model-settable (this review's follow-up to Ship 2)                                                                                                      | needs an operator ruling on legitimate setters (8 rows)                                                                    | operator "go"                                                              |
| `jarvis_file_delete` precious flow still model-`confirmed` for knowledge/projects/NorthStar                                                                                     | interactive tasks already route through the runner's pendingConfirmation; non-interactive can't confirm anyway             | audit of a lost precious file                                              |

## Tier 3 skipped (categories, ~350 items)

Desktop/Electron + dashboard (~130), messaging platforms & platform features
(~50), provider/model catalog (~70), voice/TTS/STT (~25), distribution/CI
(~50), skills-hub content (~40), operator slash-commands/TUI (~55), profiles /
multi-instance (~12), Kanban/cron UI (~13), Bot Mode society (v0.21).
Cautionary reverts noted: memory provider-actions extension point (v0.19), DCP
context engine (v0.21), `prompt_caching.enabled` toggle (v0.18), `auth.json`
cloning (v0.18) — all corroborate decisions we already hold.

## Cadence

Upstream is at **v0.21.0 (2026-08-31)** and ships ~2 minors/month. Next review
due **2026-10-01**; if >2 minors land before then, it is a full-day review
again. The candidate lists themselves (3 reader files, ~140 KB) lived in the
session scratchpad and are not preserved — this note plus the memory entry are
the record.

## Audit (multi-round, Tier 1: SSRF + secret-handling surface, 24 files)

**R1 — FAIL** (qa-auditor, adversarial). All three Criticals real, all folded:

- **C1 (bundle regression):** `safeFetch` read `res.headers.get("location")`
  without an optional chain; `lib/v8-4/citations.ts` declares `FetchLike.headers`
  optional and now defaults to `safeFetch` → `consumer.test.ts` red and the V8.4
  citation gate swallowed the TypeError into `verdict = "unreachable"` (cached
  24 h) — a silent fail-open. Fix: `res.headers?.get("location") ?? null`.
- **C2 (bundle regression):** `standingOrdersGuard` stripped only leading `./`
  and `/`; `knowledge/../directives/core.md` passed and `mirrorToDisk` joined it
  onto the live `directives/core.md` (Drive-synced). `Directives/core.md` and
  `" directives/core.md"` also passed. Fix: `canonicalKbPath` (trim, `\`→`/`,
  `posix.normalize`, strip leading `./` `/`, lowercase) — 6 spelling tests.
- **C3 (pre-existing surface the ship claimed to close):** `file_write`'s
  allow-list includes the jarvis-kb root, `code_edit` denies only mission-control
  and `~/.claude`, and `kb-reindex` imported every disk-only path hourly — so
  `file_write("/root/claude/jarvis-kb/directives/x.md")` became a live
  standing order within the hour. Fix: `isStandingOrdersDiskPath` in both
  absolute-path tools + `directives/` in `MANAGED_NAMESPACES` (reindex never
  imports a disk-only directive; 15 reindex tests incl. the new case).
- Warnings folded: W1 `lib/pdf.ts` fetch unswept (pdf-read + web-read reach
  it); W4 hex-mapped `::ffff:7f00:1` unblocked; W6 header hygiene across hops
  (fresh `Headers` per hop, cross-origin credential strip, body-drop header
  strip, 303 → GET unless HEAD); W7 redirect cap 5 → 20 (fetch parity); W8
  warn-once per hostname; W9 stale `jarvis_file_list` text. Not folded: W2
  (`always-read` model-settable — operator ruling), W3 (model can author
  `knowledge/proposals/*.md` directly, skipping the propose tool's cooldown;
  `jarvis_apply_proposal` still requires operator approval), W5 (the
  connect-time e2e test depends on Ubuntu's `ip6-localhost` alias — now
  `it.runIf`).
- Verified clean by R1: callback shapes end-to-end, no IP-literal bypass
  (`2130706433`, `0x7f000001`, `0177.0.0.1`, `127.1`, `[::ffff:7f00:1]`,
  userinfo tricks all normalise or are caught), guard sits before the router's
  `confirmed:true` injection, header-comment ports all listening.

**R2 — FAIL** (fix-the-fix + adjacency). Two Criticals inside the R1 fixes, both
folded, plus four warnings:

- **C1 (bundle regression):** `canonicalKbPath` clamped `./` but a walk-out-and-
  back-in spelling — `../jarvis-kb/directives/core.md`, `a/../../jarvis-kb/…` —
  re-entered the root through `mirrorToDisk`'s `join`. String normalisation is
  the wrong tool; the canonical form is now **root-relative resolution**
  (`posix.relative(root, posix.resolve(root, p))`, `kbRoot` passed by every
  caller), and the bare `directives` directory counts too.
- **C2 (pre-existing doors the R1 sweep missed):** `file_delete` runs its own gate
  chain (never `isWriteAllowed`) and would `rmSync` the whole
  `jarvis-kb/directives` tree; `shell_exec` explicitly allow-listed writes under
  the KB root. Both refused now (`file_delete`: first check, symlink-resolved;
  `shell_exec`: `DENY_WRITE_PATTERNS` entry on `/jarvis-kb/directives`).
- Warnings folded: both new refusal messages had lost their `${resolved}`
  (a perl interpolation slip — the model could not see which path failed);
  `code_edit` resolved without following symlinks (now `realResolve`); one more
  `fetch` in `gemini-research.ts` (the upload URL, a response header validated
  by name only); `mirrorToDisk` containment lacked the trailing slash
  (`../jarvis-kb-evil/x.md` shared the prefix).
- Documented residuals, not fixed: shell writes that `cd` into the KB root and
  use a relative path (the guard sees command text); `always-read` qualifier;
  model-authored proposal files; pre-existing SSRF in `huggingface.ts`, the A2A
  client, browser `page.goto`, `video/images.ts` (queued with a trigger).

**R3 — PASS WITH WARNINGS** (verdict verification): both R2 Criticals closed empirically against `src`; no new Critical. Folded before commit: call-site pins for the three disk doors (`file_write`, `file_delete`, `code_edit` — deleting the wiring now goes RED), four stale numbers in this note. Recorded, not fixed: shell writes with a quoted target or via `sed -i` bypass the text-level extractor (pre-existing, same as the mission-control deny; queue item 8).

Scoreboard: pre-existing bugs found 5 (file_write / code_edit / reindex /
file_delete / shell doors, pdf + gemini-upload fetch, mirrorToDisk slash,
hex-mapped v4) · bundle-regression catches 6 Criticals-or-Warnings (R1-C1
headers, R1-C2 spellings, R2-C1 round-trip, message interpolation, code_edit
resolve, header hygiene) · rounds 3 · eval gate PASS 64.38 vs 65.75
(Δ −1.37, threshold 63.75).

## How mission-control compares to Hermes v0.21 (positioning, 2026-09-01)

Different products sharing an agent loop. Hermes is a general-purpose open-source
agent platform (22+ messaging platforms, desktop/TUI/web, plugin SDK, skills
hub, 20+ providers, MoA, Bot Mode multi-agent society; ~2 minors/month from
dozens of contributors). mission-control is a single-operator orchestrator that
trades that breadth for governance. View is from release notes + repo tree, not
from running Hermes.

| Dimension | Hermes v0.21 | mission-control | Read |
| --- | --- | --- | --- |
| Surface | 22+ platforms, desktop/TUI/web, plugins, skills hub, MoA, Bot Mode | Telegram + WhatsApp (+email), `mc-ctl`, 257 tools, SDK primary + one fallback | Deliberate asymmetry: smaller prompt, smaller attack surface |
| Loop robustness | doom-loop/convergence, 413 recompress, empty-response guards, TTFB watchdog, turn-reaper stack dumps | same guards (several came from Hermes ≤v0.14); hot path delegated to the Claude Agent SDK; richer `exitReason` taxonomy | parity; they diagnose stalls better, we lean on the SDK |
| Context management | 439 KB compressor: per-turn micro-compaction, N-user-tail guarantee, per-model absolute thresholds, ghost-skill sentinels, lean-tail default, recall eval harness | L0–L3 cascade + PRESERVE+ADD + focusTopic — fires only on the OpenAI fallback (~6×/30 d); the SDK compacts the 787/831 fast-path runs | Hermes ahead, where our traffic is not |
| Verified completion | v0.18 `/goal` completion contracts, verification evidence ledger, `pre_verify` hook; verify-on-stop gated OFF for messaging | V8.4 Honest Done (gates before work, harness-run checks, FAILED demotes), read-back gates, provenance/claim detector, citation validation — enforced ON messaging | convergent; ours deeper and live where theirs is off |
| Memory | pluggable providers (Honcho/Supermemory/mem0/OpenViking), atomic batch memory ops, curator, cron memory; provider-actions + DCP engine reverted | in-house JME (episodic + semantic + FTS5, consolidator, dedup/supersede, preference signals) + KB registry; `recall_audit` utility measurement | different bets; we measure utility, they optimise ecosystem |
| Security | DNS-pinned SSRF (v0.20), redaction sweeps, protected instruction files (v0.21), LLM-reviewed approvals, deny rules + `/deny <reason>`, consecutive-denial breaker, credential-injection egress proxy | both v0.20/v0.21 items shipped here today; Rule of Two structural risk tiers, shell/write guards, immutable core, sandbox egress default-deny | converged — ours structural, theirs ergonomic |
| Delegation | `delegate_task` background fan-out, durable ledger, live transcripts, mid-flight steer, stop-early-keep-partial, schema-validated output | swarm via goal-graph — 2 runs in 30 d; per-sub-task retry a known gap | Hermes ahead; not worth chasing at our volume |
| Scheduling | cron memory + continuity, monitor-mode dedup, self-heal, fail-closed on drift | rituals: delivery policy, sent-before ledger, 5/1400 budget, heartbeats + alerts, `[PAUSAR-SCHEDULE]` | we lead on delivery hygiene, they on job continuity |
| Cost / observability | usage reporting + bounded tool metrics (v0.21), per-task aux accounting (v0.19) | cost ledger with per-model attribution, Prom metrics, task traces, `mc-ctl audit-claim` | parity; ours audit-oriented |
| Eval / QA | Composio evals, compaction recall harness | 376-case eval gate before any prompt/tool-description change, 7.8k tests, multi-round audits | ours gates more strictly |

Implications: keep cherry-picking monthly on triggers (compaction engineering if
fallback traffic grows; delegation ergonomics if swarm volume grows; denial-reason
relay if shell denials appear); never import the breadth (platforms, UI, MoA,
providers, profiles, Bot Mode); the two things we do that they do not are
honest-done enforcement on the phone surface and memory judged by measured
utility rather than by provider.
