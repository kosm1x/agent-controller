# CLAUDE.md

## Quick Context

Unified AI agent orchestrator. Routes tasks by complexity to 5 runner types (fast, nanoclaw, heavy, swarm, a2a). Single TypeScript process, Hono HTTP, SQLite.

## Development

```bash
npm run typecheck    # tsc --noEmit — must be zero errors
npm test             # vitest run — all tests must pass
npm run dev          # tsx watch (hot reload)
npm run build        # tsc → dist/
```

Always run `typecheck` + `test` after changes before reporting completion.

## Invariants

- **Vendor-agnostic inference**: Raw fetch to OpenAI-compatible endpoints. Zero vendor SDKs in `src/inference/`. No `openai`, `anthropic`, etc.
- **6 core + 2 messaging deps**: hono, @hono/node-server, better-sqlite3, @modelcontextprotocol/sdk, node-cron, @opendataloader/pdf + @whiskeysockets/baileys, grammy (messaging, optional at runtime). Do not add deps without discussion.
- **Schema changes require DB reset**: SQLite CHECK constraints can't be altered in-place. After changing `src/db/schema.sql`, users must `rm ./data/mc.db`.
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

| Pattern | Our implementation | Where |
|---------|-------------------|-------|
| Routing | Classifier → dispatcher routes by complexity | `classifier.ts` → `dispatcher.ts` |
| Prompt chaining | Sequential tool calls in fast runner | `fast-runner.ts` |
| Orchestrator-Workers | Swarm decomposes → parallel fan-out | `swarm-runner.ts` (was called `orchestrator-workers` by Anthropic) |
| Evaluator-Optimizer | Plan-Execute-Reflect loop with auto-replan | `planner.ts` → `executor.ts` → `reflector.ts` |
| Parallelization | Swarm sectioning + guardrail parallel checks | `swarm-runner.ts`, goal graph DAG |

### Complexity gradient
Always prefer the simplest runner that can solve the task. The classifier enforces this: fast → heavy → swarm. Never default to Prometheus when a single LLM call with tools suffices. Add orchestration layers only when measurably better outcomes justify the latency/cost tradeoff.

### ACI (Agent-Computer Interface) design
Tool definitions are prompts — they deserve more engineering than the handler code. Models read descriptions to decide which tool to call and how. Principles:
- **Write descriptions for a capable but literal junior dev** — include when to use, when NOT to use, edge cases, and boundaries with similar tools
- **Parameter names are documentation** — `due_date` > `date`, `objective_id` > `parent_id`. Add `.describe()` on every Zod field
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
```

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

### Adding a new runner
1. Implement `Runner` interface in `src/runners/<name>-runner.ts`
2. Register in `src/dispatch/dispatcher.ts`
3. Add classification case in `src/dispatch/classifier.ts`
4. Add tests

### Prometheus (heavy runner) changes
- PER loop: planner → executor → reflector → orchestrator coordinates
- `plan()` and `replan()` return `{ graph, usage }` — always destructure
- `reflect()` returns `{ result, usage }` — always destructure
- Token usage must propagate: goal → execution → orchestrator result
- GoalResult and ExecutionResult require `tokenUsage` field in all code paths

## Git

- Remote: `kosm1x/agent-controller` on GitHub
- SSH preferred. Fall back to `gh` CLI for HTTPS if SSH unavailable.
