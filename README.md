# Agent Controller

Agent Controller is a single TypeScript service that takes tasks over HTTP or chat, picks an
execution strategy for each one (a quick in-process tool loop, a sandboxed container, a
plan-execute-reflect loop, or a parallel swarm), runs it with LLM inference and tools, and
reports the result. It is built for one operator who runs it as a personal assistant called
**Jarvis**, reached over Telegram and WhatsApp. The service and its systemd unit are named
`mission-control`, and so is the npm package.

Terms used below:

- **Task**: one unit of work, submitted with a title and a description. Tasks are stored in SQLite.
- **Runner**: the strategy that executes a task. There are five: `fast`, `nanoclaw`, `heavy`,
  `swarm`, `a2a`.
- **Tool**: a function the model can call (shell, files, web, Google Workspace, and so on). A
  fresh clone registers 180 tools; production registers 251 (see [How it works](#how-it-works)).
- **Claude Agent SDK**: Anthropic's library (`@anthropic-ai/claude-agent-sdk`) that runs Claude
  with tools; the production inference path.
- **MCP** (Model Context Protocol): a standard for exposing tools from a separate server process.
- **A2A** (Agent2Agent): a JSON-RPC protocol for one agent to hand a task to another.
- **Prometheus**: in this repo, the name of the plan-execute-reflect loop (`src/prometheus/`).
  The `/metrics` endpoint is unrelated: it serves Prometheus-the-monitoring-system metrics.
- **Ritual**: a scheduled job, such as the morning briefing or the nightly close (an end-of-day
  review of the day-log, the KB file `logs/day-logs/<date>.md` that records the day's chat
  activity, and a plan for tomorrow).
- **KB**: the Jarvis knowledge base, markdown files stored in the database (`jarvis_files`).

---

## Quick start

Tested path: Linux, Node 22. Steps 1-3 need no credentials. Step 4 needs a Claude login.

### 1. Install and check the setup (no credentials)

```bash
git clone https://github.com/kosm1x/agent-controller.git
cd agent-controller
npm ci
npm run typecheck
npx vitest run src/config.test.ts
```

`npm ci` prints `npm warn deprecated …` lines, an `npm audit` vulnerability summary and possibly
an `npm notice New major version of npm available` block; none of them blocks the install (exit 0). `npm run typecheck` prints npm's script header (`> tsc --noEmit`),
no errors, and exits 0. The test run ends with:

```
 ✓ src/config.test.ts (17 tests) 8ms

 Test Files  1 passed (1)
      Tests  17 passed (17)
```

### 2. Start the server (no credentials)

The server does **not** read a `.env` file. Pass variables in the environment. `MC_API_KEY` is the
only variable that is always required. Use any string you like; it is the key clients send in
the `X-Api-Key` header. With `INFERENCE_PRIMARY_PROVIDER=claude-sdk` no other variable is
required at boot.

```bash
MC_API_KEY=dev-local-key MC_BIND_HOST=127.0.0.1 INFERENCE_PRIMARY_PROVIDER=claude-sdk npm run dev
```

`MC_BIND_HOST=127.0.0.1` keeps the server off the network: the default is `0.0.0.0` (all
interfaces), which would expose it behind a trivial key.

Startup takes about 4 seconds. **The one signal that boot succeeded is the `Mission Control
listening` line.** Its form depends on whether output goes to a terminal:

```
# piped or redirected (JSON):
{"level":"info",…,"module":"mc","port":8080,"msg":"Mission Control listening"}
# in a terminal (pretty-printed):
[22:37:51] INFO (244): Mission Control listening
    module: "mc"
    port: 8080
```

The database is created at `./data/mc.db`, relative to the directory you start from (here the
repo root), with a series of `[db] schema migration vN applied` lines on the first boot. On a fresh clone these lines are also expected and harmless:

| Line | Why |
| --- | --- |
| `[mcp] browser: failed to connect — spawn ./bin/lightpanda ENOENT` and `[mcp] graphify-code: failed to connect — spawn ./venv/graphify/bin/python ENOENT` | `mcp-servers.json` lists MCP servers whose binaries are installed only on the production host. Their tools are skipped. |
| `[mcp] xpoz: env XPOZ_API_TOKEN has no value — omitted`, then a Node stack trace `Error: Cannot find module '/root/claude/projects/xpoz-pipeline/dist/mcp-server.js'` ending in `Node.js v22.23.4`, then `[mcp] xpoz: failed to connect — MCP error -32000: Connection closed` | The `xpoz` server is a script from another project. The trace is the MCP **child process** exiting, not the server. |
| `[mcp] ⚠️ DEGRADED: 3 MCP server(s) failed to connect (browser, graphify-code, xpoz). Auto-reconnect started.` | Summary of the three lines above. |
| `{"level":"error",…,"errors":["gmail_send: backing tool 'gmail_send' not in registry"],"msg":"V8.3 capability seed reported errors"}` | V8.3 (`src/lib/v8-3/`) tracks how much autonomy each risky action, such as sending email, has earned. At boot it seeds the `capability_autonomy` table with five such capabilities at level 1 (always ask first), each backed by a tool; `gmail_send` exists only when the Google variables are set. |
| `[jarvis-fs] KB mirror DISABLED for this process …` | The KB disk mirror runs only against the production database. |
| `[intel] Starting 9 collectors: usgs, nws, gdelt, frankfurter, cisa_kev, coingecko, treasury, google_news, geo_rss` | The Intelligence Depot (`src/intel/`): collectors that poll public data feeds over outbound HTTP and store signals. They start on every boot; there is no switch to turn them off. |

If port 8080 is taken, add `MC_PORT=8090` and use that port below.

### 3. Check health (no credentials)

In a second terminal, once the `listening` line has appeared (about 4 seconds after start):

```bash
curl -s http://127.0.0.1:8080/health
```

Expected output: one JSON object that begins like this:

```
{"status":"healthy","timestamp":"…","version":"0.1.0","db":"ok","inference":"unreachable",…
```

`inference` is `"ok"` when `~/.claude/.credentials.json` exists (see step 4).
`"tools":{"toolCount":0,…}` counts tools *called* since start, not tools loaded. The detailed body
is returned only to loopback/private peers or a request with a valid `X-Api-Key`. Public peers
get `status` and `timestamp` only.

### 4. Run a task (needs credentials)

The `claude-sdk` provider runs through the Claude Agent SDK, which authenticates like Claude
Code. Install the Claude Code CLI (official instructions:
https://docs.claude.com/en/docs/claude-code/overview), run `claude` once and log in. The login
writes `~/.claude/.credentials.json`, which is what production uses and what `/health` checks.
That is the only verified path. The code passes its whole environment to the SDK
(`src/inference/claude-sdk.ts`), so the SDK's own `ANTHROPIC_API_KEY` support may work, but it
is untested here and `/health` still reports `"inference":"unreachable"` without the login file.
With the server from step 2 still running:

```bash
curl -s -X POST http://127.0.0.1:8080/api/tasks \
  -H "X-Api-Key: dev-local-key" -H "Content-Type: application/json" \
  -d '{"title":"Ping","description":"Reply with the single word pong.","agent_type":"fast"}'
```

The response is `201` with `{"task_id":"…","agent_type":"fast","classification":…,"status":"queued"}`.
`classification` explains the routing: `{"score":…,"reason":…,"explicit":…}`. With an explicit
`agent_type` it is `{"score":-1,"reason":"Explicit override: fast","explicit":true}`; with
`auto` it carries the complexity score. Poll the task:

```bash
curl -s http://127.0.0.1:8080/api/tasks/<task_id> -H "X-Api-Key: dev-local-key"
```

The result is `{"task":{…,"status":"completed","output":…},"runs":[…],"subtasks":[]}`. While the
task is running, `status` is `queued` or `running`.

To use an OpenAI-compatible endpoint instead of the Claude SDK, leave
`INFERENCE_PRIMARY_PROVIDER` unset and set `INFERENCE_PRIMARY_URL`, `INFERENCE_PRIMARY_KEY` and
`INFERENCE_PRIMARY_MODEL` (all three are then required at boot).

The web dashboard is at `http://127.0.0.1:8080/dashboard/`. It asks for the API key in the page.
Stop the server with Ctrl+C in its terminal.

---

## Requirements

| Need | Why |
| --- | --- |
| Node.js >= 22 and npm | `engines` in `package.json`. npm 10 (10.9.9, tested in a clean `node:22` container) and npm 12 (production host) both install it. |
| `curl` | The Quick start checks in steps 3 and 4. Slim images such as `node:22-slim` do not include it. |
| Linux | Production and CI run on Linux. The single-instance lock (one server per database file) uses a Linux abstract socket, a socket name with no file on disk. Where that lock is not available, the server logs `single-instance guard unavailable` and continues. |
| Python 3, `make`, a C++ compiler | Only when `better-sqlite3` has no prebuilt binary for your platform. Its install script is `prebuild-install \|\| node-gyp rebuild --release`: it downloads a prebuilt binary (published for LTS Node versions) and falls back to compiling with node-gyp, which needs these tools. The repo's `Dockerfile` installs them on top of `node:22-slim` for this reason. |
| Claude Code login, or an OpenAI-compatible endpoint | Inference. See [Configuration](#configuration). |
| Docker (optional) | Needed for the `nanoclaw` runner and for `HEAVY_RUNNER_CONTAINERIZED=true`. Build the image with `bash scripts/build-mc-image.sh`. |
| `sqlite3` CLI (optional) | Used by the `mc-ctl` admin script. |
| Supabase/pgvector, Google OAuth, Telegram bot, WhatsApp device (optional) | Integrations that turn on when their variables are set. |

The production host lays projects out under `/root/claude/`. A few features are tied to that
layout: the KB disk mirror (`/root/claude/jarvis-kb`, written only when the open database is the
production `data/mc.db`) and the write allow-list of the file, shell and git tools. On any other
path these features stay off or refuse writes.

---

## Configuration

All configuration comes from environment variables. Core settings are parsed once at startup in
`src/config.ts`. Runner limits are in `src/config/constants.ts`. Feature flags are read where they
are used. In production the variables come from systemd: `EnvironmentFile=.env` plus drop-ins
under `/etc/systemd/system/mission-control.service.d/`. `.env.example` in the repo root is the
maintained template for that file (`env.example`, without the dot, is an older copy).

### Required

| Variable | Required | Controls | Example (fake) |
| --- | --- | --- | --- |
| `MC_API_KEY` | Always. Boot fails with `Missing required env var: MC_API_KEY`. | Key checked against the `X-Api-Key` header on `/api/*` and `/a2a`. | `dev-local-key` |
| `INFERENCE_PRIMARY_URL` | When the provider is `openai`, which is the default if `INFERENCE_PRIMARY_PROVIDER` is not `claude-sdk`. | Base URL of an OpenAI-compatible `/v1/chat/completions` API. | `https://llm.example.com/v1` |
| `INFERENCE_PRIMARY_KEY` | Same as above. | API key for that endpoint. | `sk-example-not-real` |
| `INFERENCE_PRIMARY_MODEL` | Same as above. | Model name for that endpoint. | `example-model-large` |

### Core (optional)

| Variable | Default | Controls |
| --- | --- | --- |
| `INFERENCE_PRIMARY_PROVIDER` | `openai` | `claude-sdk` routes inference through the Claude Agent SDK (production setting). Any other value means `openai`. |
| `SONNET_MODEL_ID` / `SONNET_EFFORT` | `claude-sonnet-4-6` / unset | Model used by the main `claude-sdk` path, and the effort setting for it. An ID must match `claude-sonnet-<n>…`. |
| `INFERENCE_FALLBACK_URL` / `_KEY` / `_MODEL` | unset | Second OpenAI-compatible provider, tried after the primary fails. |
| `INFERENCE_TERTIARY_URL` / `_KEY` / `_MODEL` | unset | Third provider. |
| `INFERENCE_SDK_LASTLINE_ENABLED` | `false` | `true` runs the fallback provider after both Claude SDK attempts fail. Each such call is logged. |
| `INFERENCE_TIMEOUT_MS` / `INFERENCE_MAX_TOKENS` / `INFERENCE_MAX_RETRIES` | `60000` / `6144` / `3` | Limits for the OpenAI-compatible adapter. |
| `MC_PORT` | `8080` | HTTP port. Boot fails with `Port 8080 already in use` if it is taken. |
| `MC_BIND_HOST` | `0.0.0.0` | Listen address. |
| `MC_DB_PATH` | `./data/mc.db` | SQLite file. Created if missing. |
| `MC_MCP_CONFIG` | `./mcp-servers.json` | MCP server list. |
| `LOG_LEVEL` | `info` | Pino log level. Output is pretty-printed on a TTY and JSON otherwise. |
| `MAX_CONCURRENT_CONTAINERS` | `5` | Maximum number of sandbox containers running at once. |
| `HEAVY_RUNNER_CONTAINERIZED` / `HEAVY_RUNNER_IMAGE` | `false` / `mission-control:latest` | Run `heavy` tasks in a container, and the image used for that container and for `nanoclaw`. |
| `GOAL_TIMEOUT_MS` / `ORCHESTRATOR_TIMEOUT_MS` | `120000` / `600000` | Per-goal and whole-run timeouts for the heavy runner. |
| `SANDBOX_BACKEND` | `docker` | `docker` (plain `docker run`) or `opensandbox` (Alibaba's OpenSandbox lifecycle server, which adds an egress allow-list). Any other value stops the boot. |
| `OPENSANDBOX_URL` / `OPENSANDBOX_API_KEY` / `SANDBOX_EGRESS_ALLOW` | `127.0.0.1:8098` / unset / empty | OpenSandbox server, its key, and the egress allow-list (comma-separated domains). |
| `A2A_AGENT_NAME` / `A2A_AGENT_URL` | unset / `http://localhost:<port>` | Setting the name turns on `/.well-known/agent.json` and `/a2a`. Without it those routes do not exist. |
| `JARVIS_MCP_ENABLED` | unset | `true`/`1`/`yes`/`on` turns on the read-only MCP server at `/mcp`. |
| `RITUALS_ENABLED` | unset | `true` starts the scheduled rituals and proactive triggers. |
| `BUDGET_ENABLED` / `BUDGET_ENFORCE` | `false` / `false` | Spend checks at dispatch. They log and show on `/health`. Production never blocks a task on budget. |

### Channels and integrations (optional)

Each integration is off until its variables are set.

| Feature | Variables |
| --- | --- |
| Telegram | `TELEGRAM_ENABLED=true`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID` |
| WhatsApp (via Baileys, an unofficial WhatsApp Web library; the paired session is stored in `./data/whatsapp-session`) | `WHATSAPP_ENABLED=true`, `WHATSAPP_OWNER_JID`, optional `WHATSAPP_GROUP_JIDS` |
| Email | `EMAIL_ENABLED=true` plus per-account variables; see `docs/EMAIL-CHANNEL.md` |
| Google Workspace tools | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`; see `docs/GOOGLE-OAUTH-RUNBOOK.md` |
| Embeddings / pgvector memory | `EMBEDDING_PROVIDER`, `EMBEDDING_URL`, `EMBEDDING_KEY`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS` |
| Hindsight (an external memory service run as a Docker container; off by default, the SQLite backend is used instead) | `HINDSIGHT_ENABLED`, `HINDSIGHT_URL`, `HINDSIGHT_API_KEY`, `HINDSIGHT_RECALL_ENABLED` |
| Web search / research | `BRAVE_SEARCH_API_KEY`, `EXA_API_KEY`, `JINA_API_KEY`, `GEMINI_API_KEY` |
| WordPress tools | `WP_SITES` (JSON map of sites) |
| Finance data | `ALPHAVANTAGE_API_KEY`, `POLYGON_API_KEY`, `FRED_API_KEY`, `CMC_PRO_API_KEY` |
| GitHub tools | `JARVIS_GH_TOKEN`, `JARVIS_GH_USER`, `JARVIS_GH_EMAIL` |
| CRM bridge | `CRM_API_URL`, `CRM_API_TOKEN` |

The code reads about 140 other variables, mostly feature flags and tuning knobs. All of them are
optional. To list them:

```bash
grep -rhoE "process\.env\.[A-Z0-9_]+" src --include=*.ts --exclude=*.test.ts | sort -u
```

---

## How it works

```
POST /api/tasks ─┐   Telegram / WhatsApp / email ─┐   POST /a2a (when enabled)
                 v                                v
        src/dispatch/classifier.ts  ── scores the task, or uses agent_type if given
                 │     score 0-2 fast · 3-5 nanoclaw · 6-8 heavy · 9+ swarm
                 v
        src/dispatch/dispatcher.ts  ── creates task + run rows, enforces the container limit
                 │
   ┌─────────┬───┴──────┬───────────┬──────────┐
  fast    nanoclaw    heavy       swarm       a2a
```

| Runner | File | What it does |
| --- | --- | --- |
| `fast` | `src/runners/fast-runner.ts` | Runs in-process: an LLM with tools in a loop until it answers. Up to 30 rounds (55 for coding, 35 for browser tasks), set in `src/config/constants.ts`. Guards catch repeated calls and loops. |
| `nanoclaw` | `src/runners/nanoclaw-runner.ts` | Coding sandbox. `src/runners/nanoclaw-worker.ts` runs the Prometheus loop (see `heavy`) with the coding tools inside a Docker (or OpenSandbox) container built from the `mission-control:latest` image. It works only on this repo. A task aimed at another repo is sent to `heavy` instead. |
| `heavy` | `src/runners/heavy-runner.ts`, `src/prometheus/` | **Prometheus** plan-execute-reflect loop. It splits the task into a graph of goals (`goal-graph.ts`, `planner.ts`), runs each goal with retries and a self-check (`executor.ts`), replans when goals fail or block, and then evaluates the result (`reflector.ts`). |
| `swarm` | `src/runners/swarm-runner.ts` | Plans like `heavy`, then sends each independent goal back through the dispatcher as a sub-task, so the goals run in parallel. Cancelling the parent cancels the sub-tasks. |
| `a2a` | `src/runners/a2a-runner.ts`, `src/a2a/` | Sends the task to a remote agent over the A2A protocol (JSON-RPC, agent card at `/.well-known/agent.json`). Only used when you pass `agent_type: "a2a"` and `input.a2a_target`. The classifier never picks it. |

Chat messages (Telegram/WhatsApp/email) go through `src/messaging/router.ts`. It assembles the
Jarvis system prompt and the relevant KB files, picks the tool groups for the message, and runs
the task. Every reply passes a delivery filter before it is sent.

Other parts:

- **Inference**: `src/inference/adapter.ts` is the entry point. `claude-sdk.ts` holds the Claude
  Agent SDK path: Sonnet by default, Haiku as fallback, Opus for heavy-runner planning.
  `adapter-openai.ts` is the OpenAI-compatible path with failover and backoff.
- **Tools**: five sources are registered at boot in `src/index.ts`: builtin
  (`src/tools/sources/builtin.ts`), MCP (`mcp-servers.json`, tools named `<server>__<tool>`),
  Google, memory and skills. A fresh clone registers 180 (`"totalTools":180`); the N in `Tool
  sources reported N tools; registry holds 180` varies by boot because concurrent sources can
  double-count, so trust the registry. Production registered 251 on 2026-11-09, adding the
  Google source (22 tools), WordPress (`WP_SITES`), CRM (`CRM_API_TOKEN`), the Google Workspace
  CLI tool and MCP servers that connect only there. Per-tool catalog: `docs/TOOL-CATALOG.md`.
  Rarely used tools reach the model as name and description; the full schema follows on first use.
- **Storage**: one SQLite file (`better-sqlite3`, WAL mode). The schema is in
  `src/db/schema.sql`, with migrations in `src/db/index.ts`. Events go to a SQLite-backed bus
  (`src/lib/event-bus.ts`), and `/api/events/stream` serves them over SSE.
- **Schedulers**: rituals (`src/rituals/`, only with `RITUALS_ENABLED=true`), user-defined
  schedules (`src/rituals/dynamic.ts`), and the Intelligence Depot collectors
  (`src/intel/scheduler.ts`, always on).

### HTTP API

`/api/*` requires `X-Api-Key` and is rate-limited per IP.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/tasks` | Submit a task: `title`, `description` (required); `agent_type` (`auto` or a runner name), `tools`, `input`, `priority`, `tags`, `gates`, `interactive`, `conversationHistory` (optional). |
| `GET` | `/api/tasks` | List tasks (`status`, `agent_type`, `parent`, `limit`, `offset`). |
| `GET` | `/api/tasks/:id` | Task with its runs and sub-tasks. |
| `POST` | `/api/tasks/:id/cancel` | Cancel a task, including its sub-tasks. |
| `POST` / `GET` | `/api/agents/register`, `/api/agents/heartbeat`, `/api/agents` | Agent registry. |
| `GET` | `/api/events/stream` | SSE event stream. |
| `POST` | `/api/jarvis-pull` | Research question from the CRM. |
| various | `/api/admin/*` | Operator endpoints (kill switch, tool list, Drive maintenance). |
| `GET` | `/health` | No key needed. Full detail for private peers or key holders, liveness only for everyone else. |
| `GET` | `/metrics` | Prometheus metrics. Private peers or key holders only. |
| `GET` | `/dashboard/` | Web dashboard (`public/dashboard/`). The API key is entered in the page. |
| `GET`, `POST` | `/.well-known/agent.json`, `/a2a` | A2A agent card and JSON-RPC (`sendMessage`, `getTask`, `cancelTask`, `sendStreamingMessage`). Only when `A2A_AGENT_NAME` is set. |
| `POST` | `/mcp` | Read-only MCP server. Only when `JARVIS_MCP_ENABLED` is set. |

A task submitted through the API has no chat in which to confirm a high-risk action. By default
such an action is refused. Pass `"interactive": false` to run the task with the same
confirmation rules as a scheduled task.

---

## Development

| Command | What it does |
| --- | --- |
| `npm run dev` | `tsx watch src/index.ts`: runs from source and reloads on changes. |
| `npm run typecheck` | `tsc --noEmit`. Must report zero errors. |
| `npm run typecheck:tests` | Type-checks the test files and every script under `scripts/` (`tsconfig.test.json`). |
| `npx vitest run <file or dir/>` | Runs the tests for what you changed. Tests are `src/**/*.test.ts` and `scripts/**/*.test.ts`, next to the code they test. |
| `npm run build` | `tsc` to `dist/`, copies the runtime assets, builds the docs pages. |
| `npm start` | `node dist/index.js`. |
| `npm run tune:baseline:dry` / `npm run tune:run:dry` | Offline eval and a mock overnight tuning loop (no spend). |
| `npm run eval:gate -- --run` | Model-swap gate. It uses real inference (about $5 and 13 minutes per run). Run it before changing a model ID, the system prompt or a tool description, and do not ship on exit 1. |

Testing rules:

- Run scoped tests (one file, or the narrowest directory). The whole suite, about 590 test files,
  can run out of memory on a small machine. CI (`.github/workflows/ci.yml`) runs it in 3 shards.
- Tests never call a real LLM. Mock `infer`/`inferWithTools` with
  `vi.mock("../inference/adapter.js")`.
- Optional pre-commit hook (typecheck plus `vitest related` on staged `.ts` files):
  `git config core.hooksPath scripts/git-hooks`.

Where to add things (conventions in `CLAUDE.md`, full text in `docs/CLAUDE-REFERENCE.md`):

- **Tool**: define it with `defineTool()` (`src/tools/define-tool.ts`) and register it in
  `src/tools/sources/builtin.ts`. Add a row to `src/tools/rule-of-two.ts`, which marks whether the tool reads untrusted
  input or sensitive data (a run that combines both with a state-changing tool needs human
  confirmation, after Meta's "Agents Rule of Two"). Set all four MCP hints
  (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`). Failures return
  `{error}` JSON.
- **Runner**: add it under `src/runners/` and import it for its side effect in `src/index.ts`.
- **Schema change**: add it to the `SCHEMA_MIGRATIONS` list in `src/db/index.ts`. The list is
  append-only.
- **Cron job**: use `scheduleCron()` from `src/lib/cron.ts`, not `cron.schedule` directly.

---

## Deployment / operations

Production runs on a single VPS as the systemd unit `mission-control`. It runs the **compiled
`dist/`** (`ExecStart=node dist/index.js`, `WorkingDirectory` = the repo, `EnvironmentFile=.env`),
not the TypeScript source. A source edit has no effect until it is deployed.

- **Deploy**: `./scripts/deploy.sh [--force] [--drain <seconds>]`. **Only the operator runs it**,
  from a login session. The script refuses to run from inside the service, and agent sessions are
  blocked from running it. The script:
  1. Checks the database migrations on a throwaway database.
  2. Runs `npm run build` and records the build commit.
  3. Rebuilds the sandbox image if `package-lock.json` changed.
  4. Refuses to restart while tasks are running, unless `--force` or `--drain` is given.
  5. Restarts the unit and checks that the old process has exited.
- **After a deploy**: `systemctl is-active mission-control`, then
  `journalctl -u mission-control --since '30 sec ago'`, then exercise the endpoint or workflow
  you changed.
- **Logs**: `journalctl -u mission-control -f`, or `./mc-ctl logs 50`.
- **Admin CLI**: `./mc-ctl status | tasks --status=failed | task <id> | tools | schedules |
  sandboxes …`. It reads `data/mc.db` read-only with the `sqlite3` CLI and the
  API on `http://localhost:8080`. Run `./mc-ctl` with no arguments to list all commands.
- **Health**: `scripts/healthcheck.sh` (cron) checks `/health` and alerts on Telegram.
- **Database**: `data/mc.db` holds Jarvis's memory and KB. Never delete or reset it. Back it up
  with `scripts/backup-db.sh`.
- **Not used in production**: `docker-compose.yml` and the `Makefile` targets. Production does
  not run on Docker; Docker is used only for the sandbox image. The compose file requires the
  three `INFERENCE_PRIMARY_*` variables.

Project state and history: `docs/ROADMAP.md` (one page, current), `docs/PROJECT-STATUS.md`
(phase history), `docs/V8-VISION.md`, `docs/V9-ROADMAP.md`, `docs/BETA.md`.

---

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Missing required env var: INFERENCE_PRIMARY_URL` at boot | The provider defaulted to `openai`. Set `INFERENCE_PRIMARY_PROVIDER=claude-sdk`, or set all three `INFERENCE_PRIMARY_*` variables. |
| `Port 8080 already in use — kill the old process first` | Another process holds the port. Set `MC_PORT` to a free port. |
| `Another mission-control instance already holds database …` | Two processes cannot share one database file. Stop the other instance, or point `MC_DB_PATH` at another file. |
| `SANDBOX_BACKEND must be "docker" or "opensandbox"` | The value has a typo. The boot refuses it on purpose, so that a typo cannot silently switch sandboxes to the backend without egress limits. |
| `[mcp] <server>: failed to connect` | Its binary or path is missing (see the table in [step 2](#2-start-the-server-no-credentials)). Its tools are skipped. Remove the entry from `mcp-servers.json` or install the binary. |
| `nanoclaw` tasks fail with an image-missing or `built from a different package-lock.json` error | The `mission-control:latest` image is missing or out of date. Run `bash scripts/build-mc-image.sh`. |
| `/health` shows `"inference":"unreachable"` with `claude-sdk` | `~/.claude/.credentials.json` is missing or empty. Log in with Claude Code. |
| Production behaves like old code after an edit | The service runs `dist/`, so deploy (operator). If a live tsx process is involved, clear its cache: `rm -rf /tmp/tsx-$(id -u)/`. |
| A full `vitest run` is killed for running out of memory | Run tests scoped to a file or directory. CI runs the whole suite in shards. |
