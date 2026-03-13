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
- **4 production deps only**: hono, @hono/node-server, better-sqlite3, @modelcontextprotocol/sdk. Do not add deps without discussion.
- **Schema changes require DB reset**: SQLite CHECK constraints can't be altered in-place. After changing `src/db/schema.sql`, users must `rm ./data/mc.db`.
- **Singleton discipline**: `getDatabase()`, `toolRegistry`, `eventBus`, `config` — use the existing singletons. Never instantiate duplicates.
- **Provider quirks in adapter only**: Model-specific guards (e.g. `enable_thinking: false` for Qwen) live in `src/inference/adapter.ts`, nowhere else.

## Testing

Tests: `src/**/*.test.ts` (vitest, colocated with source).

- Mock `infer`/`inferWithTools` via `vi.mock("../inference/adapter.js")` — never call real LLM in tests
- Mock `getDatabase` when testing components that touch SQLite
- Every new type field must have assertions in existing tests (cascading type changes break silently)

## Patterns

### Adding a new tool
1. Create handler in `src/tools/builtins/`
2. Register in `src/tools/registry.ts` — name, description, parameters schema, handler
3. Add test in `src/tools/registry.test.ts`

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
