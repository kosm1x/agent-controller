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
```

Always run `typecheck` + `test` after changes before reporting completion.

## Invariants

- **Multi-provider inference**: Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) as primary when `INFERENCE_PRIMARY_PROVIDER=claude-sdk`. Raw fetch to OpenAI-compatible endpoints as fallback/alternative (`INFERENCE_PRIMARY_PROVIDER=openai`). Anthropic format adapter in `src/inference/anthropic.ts`. MCP bridge in `src/inference/claude-sdk.ts`. **Docker-isolated runners** (nanoclaw always, heavy-runner when `HEAVY_RUNNER_CONTAINERIZED=true`) receive the provider flag + `HOME=/root` + read-only mount of `/root/.claude/.credentials.json` so the SDK authenticates inside the container. Image: `mission-control:latest` (rebuild via `docker build -f Dockerfile -t mission-control:latest .`).
- **15 core + 2 messaging deps**: hono, @hono/node-server, better-sqlite3, @modelcontextprotocol/sdk, node-cron, @opendataloader/pdf, pino, zod, prom-client, mammoth, @playwright/mcp, @anthropic-ai/claude-agent-sdk, fingerprint-injector, @antv/infographic, playwright + @whiskeysockets/baileys, grammy (messaging, optional at runtime). Do not add deps without discussion.
- **Schema changes — additive vs destructive**: New tables and indexes (`CREATE TABLE/INDEX IF NOT EXISTS`) can be applied live via `sqlite3 ./data/mc.db < ddl.sql` — no reset needed. Only CHECK constraint changes or column alterations on existing tables require `rm ./data/mc.db`. **Never reset the DB without explicit user approval** — Jarvis memories (conversations, embeddings) are irreplaceable.
- **Singleton discipline**: `getDatabase()`, `toolRegistry`, `eventBus`, `config` — use the existing singletons. Never instantiate duplicates.
- **Provider quirks in adapter only**: Model-specific guards (e.g. `enable_thinking: false` for Qwen) live in `src/inference/adapter.ts`, nowhere else.

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
- Recall source values populated to `recall_audit.source`: `hindsight | sqlite-fallback | sqlite-fallback-opt-in | sqlite-only | circuit-open | bank-disabled | rerank-opt-out`. Filter / GROUP BY this column to attribute routing decisions. New 2026-05-07 (queue #10): `rerank-opt-out` = caller passed `withRerank: false`; `sqlite-fallback-opt-in` = caller passed `withRerank: true` but Hindsight failed and we degraded to SQLite. **Escape hatch (queue #10 mechanism preserved):** callers pass `RecallOptions.withRerank: true` to opt into the cross-encoder rerank path on demand even when the global is off — for analysis tasks that legitimately want semantic re-ranking. Default behavior remains driven by `HINDSIGHT_RECALL_ENABLED`.

## Patterns

### Adding a new tool

1. Create handler in `src/tools/builtin/`
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

## Git

- Remote: `kosm1x/agent-controller` on GitHub
- SSH preferred. Fall back to `gh` CLI for HTTPS if SSH unavailable.
