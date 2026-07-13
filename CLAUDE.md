# CLAUDE.md

## Quick Context

Unified AI agent orchestrator. Routes tasks by complexity to 5 runner types (fast, nanoclaw, heavy, swarm, a2a). Single TypeScript process, Hono HTTP, SQLite.

## Development

```bash
npm run typecheck    # tsc --noEmit — must be zero errors
npm test             # vitest run — all tests must pass
npm run dev          # tsx watch (hot reload)
npm run build        # tsc → dist/
npm run tune:baseline:dry  # run free eval (scope + classification)
npm run tune:run:dry       # mock overnight loop (3 experiments)
npm run eval:gate -- --run # model-swap gate: score vs committed incumbent (~$5, ~172 LLM calls since the 4.3 corpus growth; ~13 min)
```

Always run `typecheck` + `test` after changes before reporting completion.
CI (`.github/workflows/ci.yml`) runs `tsc --noEmit` + sharded `vitest` on push/PR — it is the enforced gate; the local pre-commit hook is a convenience, not the only line of defense.
Jarvis's `git_commit` and `jarvis_dev action=pr` commit with `--no-verify` on `jarvis/*` branches by design (`d9187ae`/`e1c18bd`): the hook's full suite cannot fit inside those tools' 30-60s timeouts, and `action=pr` runs its own suite gate anyway — do not "fix" this back; CI gates.

**Before ANY model-id, system-prompt, or tool-description change**, run `npm run eval:gate -- --run` and do not ship on a FAIL (exit 1). This is the guard for the tool-adherence/delivery regression class that reverted the Sonnet-5 attempt — previously caught only in prod. First capture a gate-native incumbent once with `npm run eval:gate -- --run --update-baseline` (the committed `src/tuning/eval-baseline.json` is provisional). See `docs/planning/system-hardening-sweep-2026-07-05.md`.

## Invariants

- **Multi-provider inference**: Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) as primary when `INFERENCE_PRIMARY_PROVIDER=claude-sdk`. Raw fetch to OpenAI-compatible endpoints as fallback/alternative (`INFERENCE_PRIMARY_PROVIDER=openai`). Anthropic format adapter in `src/inference/anthropic.ts`. MCP bridge in `src/inference/claude-sdk.ts`. **Docker-isolated runners** (nanoclaw always, heavy-runner when `HEAVY_RUNNER_CONTAINERIZED=true`) receive the provider flag + `HOME=/root` + read-only mount of `/root/.claude/.credentials.json` so the SDK authenticates inside the container. Image: `mission-control:latest` (rebuild via `docker build -f Dockerfile -t mission-control:latest .`).
- **16 core + 2 messaging deps**: hono, @hono/node-server, better-sqlite3, @modelcontextprotocol/sdk, node-cron, @opendataloader/pdf, pino, zod, prom-client, mammoth, @playwright/mcp, @anthropic-ai/claude-agent-sdk, @anthropic-ai/sdk (forced peer of the agent SDK since 0.3.143 — same library that was previously transitive, not a new capability), fingerprint-injector, @antv/infographic, playwright + @whiskeysockets/baileys, grammy (messaging, optional at runtime). The two Anthropic SDKs are EXACT-pinned (no caret): upstream behavior shifts mid-minor-line (the 0.3.153 lean-prompt rollout) and every SDK move must be a deliberate, eval-gated action. Do not add deps without discussion.
- **Schema changes — versioned migrations (2026-07-05)**: `initDatabase` gates its legacy ALTER probes behind `PRAGMA user_version` and ends with the append-only `SCHEMA_MIGRATIONS` list (src/db/index.ts). NEW column adds/drops go there as the next numbered entry — never as bare ALTER probes in the init body. New tables/indexes stay `CREATE ... IF NOT EXISTS` (in schema.sql or the ensure*Tables modules) and can also be applied live via `sqlite3 ./data/mc.db < ddl.sql`. Validate schema surgery with `scripts/validate-migration-runner.ts` (fresh vs live-snapshot vs reboot). **`./scripts/deploy.sh` now runs the fresh-boot check automatically and ABORTS the deploy if the signature is unexpected** (want `user_version=2`, no `baseline_history` table) — override only with `MC_SKIP_MIGRATION_GATE=1` for a known-safe emergency deploy. Only CHECK-constraint changes on existing tables still require a reset — and **never reset the DB without explicit user approval**: Jarvis memories (conversations, embeddings) are irreplaceable.
- **Budget is observability-only (2026-07-05)**: `budgetEnabled`/`budgetEnforce` default false — the three-window limits (`budgetHourlyLimitUsd` default 20, daily 50) are soft anomaly thresholds that size `/health` `exceeded` flags + Prometheus alerts + `watchdog.sh` Check 9a; they NEVER block/throttle a dispatch. Do not describe them as "binding." Enabling enforcement is an operator decision (flip `BUDGET_ENABLED=true` + `BUDGET_ENFORCE=true`). **Operator ruling 2026-07-13: hard-cap enforcement is CLOSED for the near future — viewability and accountability are enough.** The V8.5 Phase 3.3 enforcement path (seam refusal + SDK maxBudgetUsd) stays dormant; do not propose arming it. If it is ever reopened, run the arming pre-flight in docs/planning/next-sessions-queue.md first (messaging floor, eval-gate window sizing).
- **Silent-failure observability (2026-07-05)**: rituals stamp `mc_ritual_last_success_timestamp{ritual_id}` on success (`MCRitualLoopStale` alert + `/health.ritualsHealthy`); ritual THROWS emit `schedule.run_failed` → operator Telegram (via `recordRitualFailure`, now also on the canary + poller-heartbeat paths). A new ritual/cron with its own catch should call `recordRitualFailure(id, err, phase)` so its death isn't silent. Provider latency/success is recorded on the claude-sdk path (not just the OpenAI-compat one).
- **Singleton discipline**: `getDatabase()`, `toolRegistry`, `eventBus`, `config` — use the existing singletons. Never instantiate duplicates.
- **Provider quirks in the inference layer only**: Model-specific guards (e.g. `enable_thinking: false` for Qwen) live next to their callers in `src/inference/adapter-openai.ts` (the OpenAI-compat path, split out of adapter.ts 2026-07-05); shared types + the claude-sdk hot path stay in `src/inference/adapter.ts`. Nowhere else.
- **Write-guard**: Jarvis's `git`/`shell`/`file` tools gate cwd + writes against a single `/root/claude/` allow-list (every project repo lives there — do NOT re-introduce a per-repo enumeration; it drifts and silently blocks repos it forgets, surfacing as "must be under an allowed project path"). Three files must stay in sync: `git.ts` (`ALLOWED_CWD_PREFIXES`), `shell.ts` + `file.ts` (`getAllowWritePrefixes`). mission-control **source** is protected by the DENY-first pipeline (`DENY_WRITE_*`/`isImmutableCorePath`/jarvis-branch override) that runs BEFORE the allow-list — not by the allow-list, so a broad allow can't weaken it. The broad prefix also requires the shared `src/tools/builtin/write-guard.ts` guards, applied in all three: `isOperatorConfigPath` (denies top-level dotfiles/dotdirs + umbrella `CLAUDE.md` — the operator's own `.claude/` hooks/`.mcp.json`) and `realResolve` (symlink-follow before allow/deny). See `docs/audit/2026-07-04-write-guard-hardening.md`. **Worktree split (P1, 2026-07-12): Jarvis's mission-control git work happens ONLY in the dedicated linked worktree `/root/claude/mission-control-jarvis`** (jarvis_dev bootstraps it: `git worktree add --detach` + node_modules symlink) — the git_* tools reject the primary checkout outright, and shell-level worktree-state git (checkout/reset/stash/…) targeting the primary is denied (`checkPrimaryMcGitMutation`; push/commit/add were already blanket-denied in shell). The primary checkout is operator-session territory; git guarantees one-branch-one-worktree, so his branches can't flip the primary.

## Testing

Tests: `src/**/*.test.ts` (vitest, colocated with source).

- Mock `infer`/`inferWithTools` via `vi.mock("../inference/adapter.js")` — never call real LLM in tests
- Mock `getDatabase` when testing components that touch SQLite
- Every new type field must have assertions in existing tests (cascading type changes break silently)

## Agent Design Principles

Source: [Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents) (Anthropic, 2025)

Our architecture maps to five workflow patterns from this guide. Name them explicitly so contributors recognize the design intent:

| Pattern              | Our implementation                           | Where                                                              |
| -------------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| Routing              | Classifier → dispatcher routes by complexity | `classifier.ts` → `dispatcher.ts`                                  |
| Prompt chaining      | Sequential tool calls in fast runner         | `fast-runner.ts`                                                   |
| Orchestrator-Workers | Swarm decomposes → parallel fan-out          | `swarm-runner.ts` (was called `orchestrator-workers` by Anthropic) |
| Evaluator-Optimizer  | Plan-Execute-Reflect loop with auto-replan   | `planner.ts` → `executor.ts` → `reflector.ts`                      |
| Parallelization      | Swarm sectioning + guardrail parallel checks | `swarm-runner.ts`, goal graph DAG                                  |

### Complexity gradient

Always prefer the simplest runner that can solve the task. The classifier enforces this: fast → heavy → swarm. Never default to Prometheus when a single LLM call with tools suffices. Add orchestration layers only when measurably better outcomes justify the latency/cost tradeoff.

> **nanoclaw is mission-control-only.** The nanoclaw sandbox mounts ONLY `/root/claude/mission-control` (read-only, cloned to `/workspace`). A coding task that targets anything OUTSIDE that mount — a SIBLING repo (e.g. `/root/claude/thewilliamsradar-journal`, `crm-azteca`) or an EXTERNAL website — cannot run there: `git_*`/file ops fail or "succeed" against the throwaway clone and never land on the host, and there is no web/file target at all for an external site. **Four-layer guard** (defense-in-depth):
>
> 1. **Path-literal** — `classifier.ts`'s `targetsForeignRepo()` keeps any coding task naming a non-mission-control `/root/claude/<repo>` path on a HOST runner. (Williams Journal W25 publish regression, 2026-06-20.)
> 2. **Name reference** — `referencesForeignProject()` keeps a coding task that NAMES a registered non-mc project (no path needed — "termina la landing de EurekaMS") on a host runner. The dispatcher resolves active non-mc project slugs/names via `getForeignProjectNames()`. Applied at BOTH the coding gate AND the score-path nanoclaw assignment. (EurekaMS-Landing misroute, 2026-06-24.)
> 3. **Web target** — `referencesExternalWebTarget()` keeps a coding task whose subject is code FROM an external website (a URL/domain, or rendered-content phrasing like "lo que se visualiza" / "de la página") on a HOST runner — the sandbox has no external target to author. Fires only with NO local-file path AND NO authoring verb, so "implementa un cliente para https://X" (writes LOCAL code) stays sandboxed. Applied at BOTH nanoclaw gates. (wilab.io extract-and-translate misroute, 2026-06-26 — task e77ed5b7 "Extrae el código y traduce al español lo que se visualiza" → nanoclaw → 0 output. The verb-blind `código` strong-signal routed a read/extract over external content into the authoring sandbox; the foreign-repo guards couldn't fire — no `/root/claude` path, no project name.)
> 4. **In-sandbox stop** — `nanoclaw-env-note.ts`'s `[SANDBOX SCOPE]` prompt guard tells the agent that only mission-control is here; if the target is anything else it must emit `TARGET_NOT_IN_SANDBOX` and STOP (never edit mc's own source as a substitute). The worker turns that sentinel into a STRUCTURAL failure (`emittedTargetNotInSandbox` → `success:false`), so a misroute that slips both routing layers can't report a confabulated success. A companion `[GUARD POLICY]` line forbids guard evasion (no base64/wrapper-script bypass — the 06-24 agent base64-encoded `commit` to dodge the shell-guard).
>
> **Layers 2–3 deploy differently:** Layer 2 (classifier/dispatcher) is HOST code → `./scripts/deploy.sh`. Layer 3 (nanoclaw-worker/env-note) runs INSIDE the container → rebuild the image: `docker build -f Dockerfile -t mission-control:latest .` (else the sandbox keeps the old prompt). See `feedback_containerized_runner_image_dependency`.

### ACI (Agent-Computer Interface) design

Tool definitions are prompts — they deserve more engineering than the handler code. Models read descriptions to decide which tool to call and how. Principles:

- **Write descriptions for a capable but literal junior dev** — include when to use, when NOT to use, edge cases, and boundaries with similar tools
- **Parameter names are documentation** — `due_date` > `date`, `objective_id` > `parent_id`. Add `.describe()` on every Zod field
- **Annotate side-effect semantics** (MCP-spec hints, v7.5 leftovers L2). On every new tool, set the four optional booleans on the `Tool` interface:
  - `readOnlyHint` — does NOT modify state (no FS write, DB mutation, side-effecting external call)
  - `destructiveHint` — MAY perform an irreversible action (delete, send, force-push)
  - `idempotentHint` — re-issuing the SAME call has no additional effect beyond the first
  - `openWorldHint` — interacts with state outside the agent (network, FS, third-party API)
    Defaults are deliberately conservative (`getToolAnnotations()` collapses absent hints to `{readOnly:false, destructive:true, idempotent:false, openWorld:true}`) so unannotated tools are treated as risky. Logical invariants enforced by tests in `src/tools/types.test.ts` AND production-coverage invariants in `src/tools/registry.test.ts` (v7.6 Spine 4): every production tool has all 4 hints set explicitly; `readOnlyHint` ⇒ NOT `destructiveHint`; `requiresConfirmation` ⇒ NOT `readOnlyHint`; `riskTier='high'` ⇒ `destructiveHint=true`. As of 2026-05-08, 186/186 non-MCP production tools annotated; MCP-bridge tools (xpoz, browser, playwright) currently fall back to defaults — name-pattern hint lookup tracked for v7.7+.
- **Use enums over free strings** — `z.enum(["high","medium","low"])` not `z.string()`. Constrain the model's output space
- **Poka-yoke** — design interfaces that make mistakes impossible. If the model confuses relative/absolute paths, require absolute. If empty string vs null causes bugs, handle both (see `update_task`'s `""` → `null` pattern)
- **Test tools with the model** — run real calls, observe mistakes, iterate on descriptions. Tool optimization often matters more than system prompt tuning

### Ground truth at every step

Agent progress must be validated through concrete tool results, not LLM self-assessment. The Prometheus reflector scores based on goal outcomes, not the model's opinion of itself. When adding new agent loops, always feed real environment state (DB results, file contents, API responses) back into the next step.

**The day-log is the only record of work done (operator ruling 2026-06-23).** Signals, detectors, and rituals must judge advancement/stalledness from the **Telegram day-log** (`jarvis_files` path `logs/day-logs/%` + the day-narrative) and the **active-`projects`** list — NEVER from `NorthStar/` (a stale compass of visions/goals) or the `tasks` table (no `due_date` column exists; deriving "overdue" from it fabricates data). `runDetection()` runs only `detectStalledProjects` (day-log-grounded); the legacy NorthStar/task-table detectors are retired. The proactive nudge + weekly-review (NorthStar-based) are off. Do NOT re-wire NorthStar/tasks as a work-source. NorthStar sync (`northstar_sync`, `kb-reindex` skip) stays — it's compass data, not work-truth. **Silence ≠ stall (operator correction 2026-06-24):** day-log absence is ambiguous — a quiet project may be finished, parked, or deliberately deprioritized, not drifting (absence records what did NOT happen, not why). So `detectStalledProjects` skips active projects whose `projects.config` has `stall_exempt: true` (operator override for done/launch-pending work, e.g. VLMP), and the judgment prompt warns the author not to read silence as drift. Absent/malformed config = NOT exempt (fail toward flagging). See `feedback_daylog_is_work_truth.md`.

### Stopping conditions

Every agent loop must have bounded iteration limits, token budgets, and timeouts. No unbounded loops — ever. Prometheus enforces this via `maxIterations`, `budgetTokens`, and `maxReplans`. New runners must implement equivalent guards.

### Transparency

Planning steps must be explicit and observable. The planner's goal graph, executor's per-goal logs, and reflector's scoring all serve this. When building new agent capabilities, ensure every decision point emits a trace event visible in the dashboard SSE stream.

## Admin CLI

`mc-ctl` — bash admin tool at project root. No npm deps, direct SQLite + systemctl + curl + docker.

```bash
./mc-ctl status             # Service health, API, Hindsight, key metrics
./mc-ctl stats              # Full metrics dashboard (tasks, outcomes, events, reactions, schedules, skills)
./mc-ctl tasks --status=X   # List tasks with optional filters
./mc-ctl task <id>           # Task detail + runs + subtasks
./mc-ctl logs 50             # journalctl last N lines
./mc-ctl db "SELECT ..."    # Raw SQLite query or interactive shell
./mc-ctl briefing-gate      # V8.1 §13 + V8.2 §17 activation gates (worst-of-two exit)
./mc-ctl judgments [id]     # V8.2 shadow judgments — list/detail + §17 gate-readiness header
./mc-ctl audit-claim utility --window=24h --stratify-by=bank   # Self-audit before reporting (V8 S2)
```

### Self-audit before reporting aggregate metrics

Before quoting any aggregate metric (utility %, cache-hit ratio, latency, cost, success rate) in a session report, status update, or strategic recommendation, run `mc-ctl audit-claim` and incorporate any warnings. Borne from the 2026-05-03 trilogy incident: aggregate "22.2% utility delivered" headline averaged 88% on mc-operational with 7% on mc-jarvis — the operator's primary bank was in complete collapse, the headline read green. See `feedback_recall_aggregate_hides_bank_collapse.md`.

Metrics: `utility | cache-hit | latency | cost`. Stratify by `bank`, `source`, `match_type`, `agent_type`, or `model` (metric-dependent). Exit codes: `0` verified, `1` warnings present (do NOT report as-is), `2` insufficient n, `3` error.

## Infrastructure

### Deployment flow

Source edits to mission-control have **NO effect** until deployed. The service runs compiled JS from `dist/`, not source.

```bash
./scripts/deploy.sh          # build + restart + verify (preferred)
# or manually:
npm run build && systemctl restart mission-control
```

After deploy, always verify:

1. `systemctl is-active mission-control` — must be "active"
2. `journalctl -u mission-control --since '30 sec ago' --no-pager | tail -10` — check for startup errors
3. Test at least one affected endpoint or trigger one affected workflow

### Validating a risky / never-run path

Debut a 0-usage or destructive-if-wrong path with a `scripts/validate-*.ts` (or
`verify-*.ts`) one-off harness, NOT against live state:

- isolated DB: `initDatabase('/tmp/<name>.db')` on a `copyFileSync` snapshot of
  `data/mc.db` (+`-wal`/`-shm`), `chmodSync(…, 0o600)` — it's a full memory snapshot.
- live env via `/proc/<MainPID>/environ` (loads INFERENCE\_\* / keys; never printed).
- the harness must replicate `index.ts`'s tool-source init
  (`new ToolSourceManager().addSource(new BuiltinToolSource()); await initAll(registry)`)
  or sub-agents fail with "No tools available."
- gate real spend behind `--run`. Precedents: `validate-swarm.ts`, `verify-v82-cache.ts`.

### Inference provider cutover & revert

The inference adapter routes through the Anthropic Claude Agent SDK when `INFERENCE_PRIMARY_PROVIDER=claude-sdk` (current default since 2026-05-10) — Sonnet primary, Haiku fallback for `infer()`/`inferWithTools()` callers, Opus→Sonnet for Prometheus complex paths. CRM and the Hindsight container deliberately stay on Fireworks; vision and Whisper stay on Groq. Cutover memory: `feedback_anthropic_sdk_cutover_2026_05_10.md`.

Two operational scripts maintain the cutover state:

- `scripts/cutover-env-cleanup.sh` — apply or re-apply the cutover (comments OpenAI-compat env vars, flips provider to claude-sdk, disables HINDSIGHT_ENABLED).
- `/RevertInference/revert-to-openai.sh` — emergency revert back to OpenAI-compat routing if the SDK becomes unavailable. See `/RevertInference/README.md`. Lives outside the repo because it manipulates a permission-protected `.env` and is rarely invoked.

The two scripts are exact inverses; round-trip tests verify multi-cycle stability. Both honor `ENV_FILE` env override for testing against fixtures.

### tsx caching gotcha

`tsx` caches compiled files in `/tmp/tsx-0/`. When live behavior doesn't match source code:

```bash
rm -rf /tmp/tsx-0/ && systemctl restart mission-control
```

This applies to dev mode (`npm run dev`) and any tsx-based service.

### Scope & deferred tools at runtime

- Tools marked `deferred: true` are NOT loaded into the LLM prompt until scope activates them. This saves ~52% prompt tokens.
- Scope groups are defined in `src/tools/scope.ts` — regex patterns match user messages to activate tool sets.
- Rituals with ≤6 tools use `skipDeferral=true` (all tools loaded regardless of deferred flag).
- If a tool "doesn't exist" at runtime, check: (1) is it deferred? (2) does the scope regex match? (3) is it in the ritual's tools list?

### Database

- SQLite at `data/mc.db` — contains Jarvis memories, conversations, embeddings, task history
- **NEVER delete or reset** without explicit user approval — memories are irreplaceable
- Additive schema changes (new tables/indexes) apply live: `sqlite3 ./data/mc.db < ddl.sql`
- All DB access goes through `getDatabase()` singleton — no raw `sqlite3` CLI in tools

### FS-mirror managed namespaces

The KB mirror at `/root/claude/jarvis-kb/` is walked hourly by `kb-reindex` and auto-upserts any FS-only `.md` into `jarvis_files`. This catches drift from external writers but conflicts with tools that have their OWN authoritative store: any path that kb-reindex resurrects from FS will undo a wipe from those tools.

`MANAGED_NAMESPACES` in `src/db/jarvis-reindex.ts` lists prefixes that kb-reindex MUST skip. Their authority lies elsewhere:

| Prefix       | Authority         | Sync tool        |
| ------------ | ----------------- | ---------------- |
| `NorthStar/` | `db.mycommit.net` | `northstar_sync` |

When adding a new tool whose authority is non-FS, add the prefix here so its wipes can't be undone by the hourly walk. The 2026-05-12 incident — 247 NorthStar records mass-deleted by `northstar_sync` and resurrected by `kb-reindex` within the hour — is the motivating case.

`deleteFile()` in `src/db/jarvis-fs.ts` propagates DB deletes to (a) pgvector, (b) Drive, (c) the FS mirror. The FS-mirror leg via `syncDeleteFromKbMirror()` is path-traversal-guarded (`resolve()` against the mirror root, rejects empty/`.`/`/`).

### Hindsight recall routing

**Verdict 2026-05-15 (queue #15) — DEMOTE.** `HINDSIGHT_RECALL_ENABLED=false` is now the documented default. 30-day data showed mc-jarvis on SQLite-hybrid returning 38.9% utility at 301ms vs mc-operational on Hindsight returning 4.0% utility at 2496ms — the "<20% utility AND >50% latency tax" threshold from the rehab playbook is comprehensively blown. The L4 hybrid SQLite layer the strategic-options doc anticipated is already serving traffic better than L5 (Hindsight) without the 2-week build cost. **Operational state**: the synchronous recall hop is demoted this commit; `HINDSIGHT_ENABLED=false` since the 2026-05-10 SDK cutover means `MemoryService` has been `SqliteMemoryBackend` (not `HindsightMemoryBackend`) since then, so retain/reflect have NOT been writing new memories to Hindsight either. The Hindsight container itself stays up — it's a frozen-but-queryable long-term store with data through 2026-05-09; the cost-ledger pull-job (queue #4 Prom scraper) keeps reporting on whatever the container does internally (observation extraction on already-written data). **Escape hatch (currently dormant)**: `RecallOptions.withRerank: true` (queue #10 mechanism) routes to Hindsight when the global is off, but ONLY when `HINDSIGHT_ENABLED=true` — currently both flags are false, so callers passing `withRerank: true` land on SQLite hybrid like everyone else. To reactivate Hindsight for analysis-task opt-in, flip `HINDSIGHT_ENABLED=true` AND keep `HINDSIGHT_RECALL_ENABLED=false`. Re-evaluation triggers: mc-jarvis SQLite utility drops below 25% for 7d (rebuild L4) OR a new memory-product candidate appears that's worth a REPLACE evaluation. Full rationale: `docs/planning/hindsight-strategic-options.md` (verdict block at top); ship script: `scripts/recall-demote.sh`; memory: `feedback_hindsight_demote_verdict_2026_05_15`.

- `HINDSIGHT_RECALL_ENABLED=true|false` — global recall path toggle. When false (current default since queue #15), all banks bypass Hindsight and answer from SQLite hybrid (FTS5 + embed). Retain/reflect unaffected.
- `HINDSIGHT_RECALL_TIMEOUT_MS=N` — client-side recall cap. Tuned 5000→8000 on 2026-05-03 per rehab playbook. Dormant under the current default (no Hindsight recalls fired).
- `HINDSIGHT_RECALL_DISABLED_BANKS=csv` — surgical per-bank demote primitive (V8 substrate follow-up). Listed banks bypass Hindsight regardless of the global flag; logged as `source='bank-disabled'` in `recall_audit`. **Dormant under the current global demote** (queue #15 cleared the list); kept as a primitive in case `HINDSIGHT_RECALL_ENABLED=true` is re-enabled in a future evaluation. Retain/reflect remain on Hindsight on disabled banks — the bank is not abandoned.
- Recall source values populated to `recall_audit.source`: `hindsight | sqlite-fallback | sqlite-fallback-opt-in | sqlite-only | sqlite-primary | circuit-open | bank-disabled | rerank-opt-out`. Filter / GROUP BY this column to attribute routing decisions. New 2026-05-07 (queue #10): `rerank-opt-out` = caller passed `withRerank: false`; `sqlite-fallback-opt-in` = caller passed `withRerank: true` but Hindsight failed and we degraded to SQLite. New 2026-05-20 (V8.1 Phase A): `sqlite-primary` = `SqliteMemoryBackend` is the top-level memory service (`HINDSIGHT_ENABLED=false`), so it instruments its own recalls — `logRecall` previously fired only from `HindsightMemoryBackend`, leaving `recall_audit` dormant under the demote. Under the current default `sqlite-primary` is the dominant label; the `sqlite-only` label (Hindsight backend active, recall flag off) can no longer be produced. **Escape hatch (queue #10 mechanism preserved):** callers pass `RecallOptions.withRerank: true` to opt into the cross-encoder rerank path on demand even when the global is off — for analysis tasks that legitimately want semantic re-ranking. Default behavior remains driven by `HINDSIGHT_RECALL_ENABLED`.

## Patterns

### Adding a new tool

1. Create handler in `src/tools/builtin/` — new tools use `defineTool()` from `src/tools/define-tool.ts` (name declared once); failure returns are `{error}` JSON, never `"Error:"` strings or `success:false`
2. Add to the appropriate `ToolSource` adapter in `src/tools/sources/` (or create a new one implementing `ToolSource` interface)
3. Write tool descriptions following ACI principles above (describe edge cases, use enums, add `.describe()` to all params)
4. Test with a real model call to verify the description guides correct usage
5. Add test in `src/tools/registry.test.ts`

### Adding a new tool source

1. Implement `ToolSource` interface in `src/tools/sources/<name>.ts` (initialize, registerTools, healthCheck, teardown)
2. Add `sourceManager.addSource(new XyzSource())` in `src/index.ts` (with any env-var guards)
3. `ToolSourceManager.initAll()` catches per-source errors — one failing source won't block others

### Adding a batch tool (collapse N rounds → 1)

When operator workflows trigger ≥3 calls of the same single-item tool in one task (NorthStar bulk-delete, NS reconstruction, weekly publish), wrap the single-item op in a batch tool that collapses N runner turns → 1. Reference: `jarvis_files_batch_write` / `jarvis_files_batch_delete` in `src/tools/builtin/jarvis-files.ts` (queue #17, commit `c2dd51e`'s successor).

Recipe:

1. **Iterate over the existing single-item function** — preserves all sync invariants (pgvector / Drive / FS-mirror, path-traversal guards, precious-path checks). Do NOT bypass them by re-implementing the underlying op.
2. **Batch-size cap = 50** as the default. Defensive against a hostile or buggy LLM looping inside one call.
3. **Partial error policy** — per-item `{path/id, status: "ok"|"not_found"|"error", error?}`. One item's failure does NOT abort the batch; the operator re-issues only the failed items.
4. **Dedupe inputs up front** — sets up the precious-path scan and the inner loop to work on distinct items, and prevents 2× side-effect cost (re-embed, re-sync) per duplicate.
5. **Cap enforcement happens BEFORE any work** — return cap-exceeded error before any precious scan or op execution.
6. **Precious-path / confirmation flow** — pre-scan ALL items; if any require confirmation, return `CONFIRMATION_REQUIRED` with the full list (one trip, not N), refuse to act on non-precious siblings on that call.
7. **Router auto-injects `confirmed: true`** on the operator-accepted retry (router.ts:1517), so the LLM does NOT need to set it manually. Document this in the tool description.
8. **Schema constraints**: `minItems: 1`, `maxItems: BATCH_CAP` — most LLMs honor them.
9. **Annotations**: `deferred: true` (schema loads on first call); `destructiveHint` and `idempotentHint` mirror the single-item parent.
10. **Add a `formatConfirmationResult` case** in `router.ts` for human-readable post-confirmation echo (e.g., "✅ 50 archivo(s) eliminado(s)").

### Adding a new runner

1. Implement `Runner` interface in `src/runners/<name>-runner.ts`
2. Register in `src/dispatch/dispatcher.ts`
3. Add classification case in `src/dispatch/classifier.ts`
4. Add tests

> **Chat tasks never reach the score-based path.** `classify()` returns from the
> messaging branch BEFORE the `PARALLEL_PATTERNS`/score routing, so a chat
> (Telegram/email) only lands on a runner the messaging branch _explicitly_ routes
> to. A `PARALLEL_PATTERNS` score case alone leaves the runner unreachable from
> chat — wire an explicit check into the messaging branch too, behind a
> `MESSAGING_*_ESCALATION` kill switch. (`swarm` had 0 lifetime runs until
> `isFanOutTask` was added to the messaging branch, 2026-06-20.)
>
> **Delivery: the event bus passes the result OBJECT by reference** (in-process).
> `task.completed`'s `result` is the runner's raw output object, NOT a JSON string;
> the router's `extractResultText` reads `.text`/`.output`/`.result`/`.content` off
> it. A new runner's output shape must expose one of those keys. Don't "fix" a
> serialization path assuming a string — trace the actual value type first.

### Adding a new MCP server (`mcp-servers.json`)

`src/mcp/manager.ts:137` passes `env: undefined` to `StdioClientTransport` whenever `McpServerConfig.env` is missing — the SDK interprets that as a clean minimal env (HOME/PATH/etc, ~5 vars), **not** parent inheritance. Any truthy `config.env` (including `{}`) flips to `{...process.env, ...config.env}` and the bridge child receives mc's full env.

1. If the bridge needs ANY env var from mc (auth tokens, API keys, etc.), the entry MUST have an `env` key — use `"env": {}` as the minimal trigger when no per-server overrides are needed.
2. Never put secret values directly in `mcp-servers.json` (the repo is public). Keep secrets in `.env`; they propagate via the inheritance trigger.
3. Verify post-deploy by inspecting the bridge child's `/proc/<pid>/environ` — count should be 70+ vars (inheritance), not 5 (clean minimal). The xpoz bridge (Session 122) silently 401'd every `POST /run` for a week because it lacked this trigger; GET tools are auth-gate-free so the connection looked healthy.

### Prometheus (heavy runner) changes

- PER loop: planner → executor → reflector → orchestrator coordinates
- `plan()` and `replan()` return `{ graph, usage }` — always destructure
- `reflect()` returns `{ result, usage }` — always destructure
- Token usage must propagate: goal → execution → orchestrator result
- GoalResult and ExecutionResult require `tokenUsage` field in all code paths
- **Model tiering**: `plan`/`replan`/`executeGraph`/`executeGoal`/`selfAssess`/`reflect` take a trailing `useOpus` (default `true`); the orchestrator/resume/swarm compute it once via `resolveUseOpus(taskDescription)` (`src/prometheus/model-tier.ts`) and thread it down. SDK calls go through `queryClaudeSdkTiered(useOpus, …)`, NOT `queryClaudeSdkComplexWithFallback` directly — keep new call sites tiered or simple tasks silently pay Opus. Kill switch: `PROMETHEUS_ECONOMY_MODEL=false` (all-Opus revert; set via systemd drop-in, not `.env`).

## Git

- Remote: `https://github.com/kosm1x/agent-controller.git` (HTTPS)
- **No SSH keys on this VPS — HTTPS + `gh` CLI only.** Run `gh auth status` before
  the first push; never switch the remote to SSH. (Operator + Jarvis share this
  worktree's `.git`; commits land on local `main`.)
