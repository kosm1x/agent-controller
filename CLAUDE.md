# CLAUDE.md

Index. Full text per section: `docs/CLAUDE-REFERENCE.md`.

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
npm run eval:gate -- --run # model-swap gate: score vs committed incumbent (~$5, ~13 min)
```

- Always run `typecheck` + `test` after changes before reporting completion.
- Jarvis's `git_commit` / `jarvis_dev action=pr` commit with `--no-verify` on `jarvis/*` branches by design — do not "fix" this back; CI gates.
- **Before ANY model-id, system-prompt, or tool-description change**, run `npm run eval:gate -- --run` and do not ship on a FAIL (exit 1).

## Invariants

Rules only; mechanism + history → §Invariants.

| Invariant | Rule |
| --- | --- |
| Inference | Claude Agent SDK primary when `INFERENCE_PRIMARY_PROVIDER=claude-sdk`; OpenAI-compat when `=openai`. Runners spawn via `spawnSandbox()` (`SANDBOX_BACKEND`). Never bypass the seam in a runner. |
| Deps | The two Anthropic SDKs are EXACT-pinned (no caret); `@alibaba-group/opensandbox` EXACT-pinned 0.1.11. Do not add deps without discussion. |
| Schema | NEW column adds/drops go in the append-only `SCHEMA_MIGRATIONS` list — never as bare ALTER probes in the init body. `deploy.sh` ABORTS on an unexpected schema signature (`MC_SKIP_MIGRATION_GATE=1` to override). **Never reset the DB without explicit user approval.** |
| Budget | `budgetEnabled`/`budgetEnforce` default false; limits NEVER block/throttle a dispatch. Do not describe them as "binding." Operator ruling 2026-07-13: hard-cap enforcement is CLOSED — do not propose arming it. |
| Ritual failures | A new ritual/cron with its own catch should call `recordRitualFailure(id, err, phase)` so its death isn't silent. |
| Cron | Never call `cron.schedule` directly — use `scheduleCron(id, expr, fn, opts)` from `src/lib/cron.ts`. `cron.validate` is fine to call directly. |
| Delivered text | Every LLM-derived send passes `sanitizeDeliverable` at the router seams. Do not route LLM text through `raw`, and do not add a new send path that bypasses the filter. Extend it with a corpus-replay fixture, never with a wider regex alone. |
| Sticky scope | A reply that asks the user to activate a tool (`detectScopeMiss`) is NEVER delivered. Do not add prompt text that tells the model to ask the user for a keyword. Extend the detector only with a corpus-replay fixture. |
| Provenance | `src/lib/v8-4/numbers.ts` is the ONE claim detector. Evidence = `EVIDENCE_TOOL_RE` allow-list — never `readOnlyHint`. A new READ tool that produces figures ⇒ add it to `EVIDENCE_TOOL_RE`; a new WRITE/CREATE tool ⇒ add its key to `writeTargetKeys`/`createdKeys` in `registry.ts` and gate it with `checkArtifactProvenance`. New harness-appended lines go in `ledger-lines.ts`. |
| Singletons | `getDatabase()`, `toolRegistry`, `eventBus`, `config` — use the existing singletons. Never instantiate duplicates. |
| Provider quirks | Model-specific guards live in `src/inference/adapter-openai.ts`; shared types + claude-sdk hot path in `adapter.ts`. Nowhere else. |
| Write-guard | Single `/root/claude/` allow-list — do NOT re-introduce a per-repo enumeration. Keep in sync: `git.ts` (`ALLOWED_CWD_PREFIXES`), `shell.ts` + `file.ts` (`getAllowWritePrefixes`). Jarvis's mission-control git work happens ONLY in the linked worktree `/root/claude/mission-control-jarvis`; the primary checkout is operator-session territory. |
| Package managers | `shell_exec` and `task_gates.check_cmd` children get `src/tools/builtin/pm-shim/` FIRST on PATH (dependency trust audit 2026-09-16): installs, registry/auth changes and registry execution (`npx <uncached>`, `uvx`, `bunx`, `corepack`) are operator-only; the shim passes read-only verbs to the real binary; the string gate refuses the spellings that would remove the shim (`PATH=`, `env -i`, `sudo`, login shells, a manager binary path or bare name as the argument of any non-read command — also behind the standard wrappers `env|timeout|nice|nohup|stdbuf|flock|watch|xargs|…`; an unlisted wrapper binary hides what follows at this layer; a redirection is not a word — tokenizers split on `<`/`>` like bash) and checks `npm run <script>` bodies. Open as spelled and documented in the audit doc: a shell glob naming the binary (`cp /usr/bin/np? zz` — no glob rule, 3-strike stop R6–R8), a detached `>& 2` or spaced `<<- TAG` before the command (3-strike stop R12–R14), a path assembled at run time inside an interpreter, `find -exec cp {}`. Do not add a glob parser or a redirection span table to the string gate; the rename class is the structural closer's job (queue). Do not remove the PATH prefix, add an off switch, or widen the allow-list without the audit doc; `npm run build` must keep copying the directory (`shell_exec` and `check_cmd` fail closed without it). |

## Testing

Tests: `src/**/*.test.ts` (vitest, colocated with source).

- Mock `infer`/`inferWithTools` via `vi.mock("../inference/adapter.js")` — never call real LLM in tests
- Mock `getDatabase` when testing components that touch SQLite
- Every new type field must have assertions in existing tests (cascading type changes break silently)

## Agent Design Principles

Five Anthropic workflow patterns → §Agent Design Principles. Rules:

- Always prefer the simplest runner that can solve the task. Never default to Prometheus when a single LLM call with tools suffices.
- **nanoclaw is mission-control-only.** Four-layer guard; Layer 2 is HOST code → `deploy.sh`; Layer 3 runs INSIDE the container → rebuild the image.
- ACI: tool definitions are prompts. Every new tool sets all 4 hints and **MUST get a Rule-of-Two row** in `src/tools/rule-of-two.ts`. Enums over free strings; `.describe()` on every Zod field.
- **The day-log is the only record of work done** — NEVER `NorthStar/` or the `tasks` table. Do NOT re-wire NorthStar/tasks as a work-source. Silence ≠ stall (`stall_exempt: true`).
- Honest done (V8.4): "Done" is a CLAIM. Route every completion path through `applyCompletionLedger` — never invent a second "done" decision. New write tool ⇒ `declareReadbackGate` hook + verifier + `readback-wiring.test.ts` case. Ledger lines only via `isLedgerLine` — never a hand-typed prefix list.
- No unbounded loops — ever. Sole exception: operator `/loop <tarea>` on Telegram/WhatsApp — never an env knob, never a default. Do not extend it to scheduled tasks, rituals, or container runners.
- Every decision point emits a trace event visible in the dashboard SSE stream.

## Admin CLI

`mc-ctl` — bash admin tool at project root. → §Admin CLI

| Command | Purpose |
| --- | --- |
| `./mc-ctl status` | Service health, API, Hindsight, key metrics |
| `./mc-ctl stats` | Metrics dashboard |
| `./mc-ctl tasks --status=X` / `task <id>` | List tasks / task detail + runs + subtasks |
| `./mc-ctl logs 50` | journalctl last N lines |
| `./mc-ctl db "SELECT ..."` | Raw SQLite query or interactive shell |
| `./mc-ctl briefing-gate` | V8.1 §13 + V8.2 §17 activation gates |
| `./mc-ctl judgments [id]` | V8.2 shadow judgments |
| `./mc-ctl audit-claim <metric> --window=24h --stratify-by=bank` | Self-audit before reporting |
| `./mc-ctl gates <task_id> \| summary [days] \| status-sources [days] \| set-ritual <id> <file>` | V8.4 completion ledger |
| `./mc-ctl sandboxes` | Sandbox backend/health/guard/containers |
| `./mc-ctl usability [days]` | Usability KPIs; `--json` |
| `./mc-ctl schedule-resume <id>` | Re-activate a task paused by `[PAUSAR-SCHEDULE]` |

Before quoting any aggregate metric (utility %, cache-hit ratio, latency, cost, success rate) run `mc-ctl audit-claim` and incorporate any warnings. Exit codes: `0` verified, `1` warnings present (do NOT report as-is), `2` insufficient n, `3` error.

## Infrastructure

Harness recipe, cutover/revert scripts, scope classifier, JME, Hindsight → §Infrastructure.

- **Deploy**: source edits have **NO effect** until deployed — the service runs compiled JS from `dist/`, not source.
  ```bash
  ./scripts/deploy.sh          # build + restart + verify (preferred; OPERATOR-RUN — the mc-guard hook denies Claude executing it)
  npm run build && systemctl restart mission-control   # manual
  ```
  After deploy, always verify: `systemctl is-active mission-control` → `journalctl -u mission-control --since '30 sec ago'` → test one affected endpoint/workflow.
- **Risky / never-run paths**: debut with a `scripts/validate-*.ts` harness, NOT against live state; gate real spend behind `--run`.
- **tsx cache**: `rm -rf /tmp/tsx-0/ && systemctl restart mission-control` when live behavior ≠ source.
- **Deferred tools**: **A tool at the head of a scope group's call distribution must not be `deferred: true`**; re-run `npx tsx scripts/validate-tool-search.ts --run` after changing any `deferred` flag.
- **Database**: `data/mc.db` holds Jarvis memories — **NEVER delete or reset** without explicit user approval. Additive DDL (`sqlite3 ./data/mc.db < ddl.sql`) is operator-run: mc-guard denies non-readonly `sqlite3` from Claude's shell (reads use `sqlite3 -readonly`). All DB access goes through `getDatabase()` — no raw `sqlite3` CLI in tools.
- **Managed namespaces**: when adding a new tool whose authority is non-FS, add the prefix to `MANAGED_NAMESPACES` (`src/db/jarvis-reindex.ts`) so its wipes can't be undone by the hourly walk.
- **JME**: never re-await `embed()` bare on the chat hot path.
- **Hindsight**: DEMOTED; `HINDSIGHT_RECALL_ENABLED=false` + `HINDSIGHT_ENABLED=false` are the defaults.

## Patterns

Recipes → §Patterns. Rules:

- **New tool**: `defineTool()`; failure returns are `{error}` JSON, never `"Error:"` strings or `success:false`; Rule-of-Two row; group in `CLASSIFIER_SYSTEM_PROMPT` + `VALID_GROUPS`, verified with ONE live chat turn; description needs a `DO NOT USE WHEN:` section naming only registered tools.
- **Batch tool**: iterate the single-item function — do NOT bypass its invariants; cap 50 checked BEFORE any work.
- **New runner**: Chat tasks never reach the score-based path — wire a messaging-branch check behind a `MESSAGING_*_ESCALATION` kill switch. `task.completed` `result` is the raw OBJECT; don't "fix" a serialization path assuming a string.
- **MCP server**: a bridge needing mc env vars MUST have an `env` key (`"env": {}`). Never put secret values directly in `mcp-servers.json` (the repo is public).
- **Prometheus**: `plan()`/`replan()`/`reflect()` return `{…, usage}` — always destructure; SDK calls go through `queryClaudeSdkTiered`, NOT `queryClaudeSdkComplexWithFallback` directly. Kill switch `PROMETHEUS_ECONOMY_MODEL=false` (systemd drop-in, not `.env`).

## Git

- Remote: `https://github.com/kosm1x/agent-controller.git` (HTTPS)
- **No SSH keys on this VPS — HTTPS + `gh` CLI only.** Run `gh auth status` before
  the first push; never switch the remote to SSH. (Operator + Jarvis share this
  worktree's `.git`; commits land on local `main`.)
