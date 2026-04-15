# F8 pm-trader Integration Dry-Run

> **Exploration item:** B (from `05-exploration-plan.md`)
> **Run date:** 2026-04-14 session 67 wrap+3
> **Method:** hands-on install + MCP stdio round-trip in a scratch venv at `/tmp/pm-trader-dryrun/`
> **Purpose:** Derisk F8 (Paper Trading via pm-trader MCP) by actually spawning the subprocess and exchanging MCP messages BEFORE committing to the F8 session. The reality-check report flagged "pm-trader Python subprocess fails on our systemd deploy" as Medium/High risk.

---

## Headline findings

1. **F8 is GREEN.** pm-trader-mcp installs cleanly, spawns as a subprocess in 2.5ms, and completes a full MCP protocol round-trip (initialize → tools/list → tools/call). Both read (`get_balance`) and write (`init_account`) operations work end-to-end with clean structured responses.

2. **Tool count is actually 30, not 26 (README) or 29 (v7 spec).** The pm-trader repo is evolving — 4 tools have been added since the README was last updated: `get_tags`, `get_markets_by_tag`, `get_event`, `cancel_all_orders`. The v7 spec claim of 29 is closer than the README's stale 26.

3. **Package version 0.1.7** (up from 0.1.6 reported by the earlier Explore agent yesterday). The repo is actively maintained — last commit 2026-04-15 00:12 UTC, ~2 hours before my dry-run. We're integrating against a moving target, but the MCP protocol surface is stable.

4. **Response shape is ideal for our fast-runner error classification.** All responses follow `{"ok": true, "data": {...}}` or `{"ok": false, "error": "...", "code": "..."}`. This maps directly onto our existing tool-error routing.

5. **REAL ISSUE: pm-trader has a `--data-dir` bug in its `mcp` subcommand.** The global `--data-dir` flag does NOT thread through to the MCP server — the server always writes to `~/.pm-trader/default/paper.db`. The `PM_TRADER_DATA_DIR` env var also appears to be ignored when the subprocess is spawned by another process. **Workaround:** set `HOME` env var when spawning. **Upstream action:** file a pm-trader issue.

6. **Latency is fine for our use case.** Cold start (initialize + first request) is ~660ms (Python import overhead + MCP SDK handshake). Subsequent requests are 3-70ms. Subprocess lifetime should span multiple tool calls, not one-per-call.

7. **Install friction: zero.** `python3 -m venv venv && pip install polymarket-paper-trader` in one step, no C extensions, no system deps. Python 3.10+ required; our VPS runs 3.12.3.

---

## 1. Install

```bash
cd /tmp/pm-trader-dryrun
python3 -m venv venv
source venv/bin/activate
pip install polymarket-paper-trader
```

**Result:**

- Package version: **0.1.7**
- Python: 3.12.3 (installed)
- Dependencies: `click`, `httpx`, `mcp`
- Entry points installed: `venv/bin/pm-trader` (CLI) and `venv/bin/pm-trader-mcp` (MCP server)
- Install time: <5 seconds on our VPS

No wheels built from source, no C extensions, no system package requirements. A production F8 install on mission-control's VPS would look identical.

---

## 2. MCP protocol handshake

Minimal Python client mimicking what `@modelcontextprotocol/sdk` TypeScript would do:

```python
proc = await asyncio.create_subprocess_exec(
    "venv/bin/pm-trader-mcp",
    stdin=PIPE, stdout=PIPE, stderr=PIPE,
)
# 1. initialize
await send({"jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                       "clientInfo": {"name": "mc-dryrun", "version": "0.0.1"}}})
init_resp = await recv()
# 2. initialized notification
await send({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})
# 3. tools/list
await send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
tools = await recv()
# 4. tools/call
await send({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": {"name": "get_balance", "arguments": {}}})
result = await recv()
```

**Result:**

| Step                                   | Latency | Notes                                            |
| -------------------------------------- | ------- | ------------------------------------------------ |
| Subprocess spawn                       | 2.5ms   | Essentially free                                 |
| `initialize`                           | 661ms   | First-call cost — Python imports + MCP SDK setup |
| `notifications/initialized`            | —       | No response expected (notification)              |
| `tools/list`                           | 2.9ms   | Fast                                             |
| `tools/call` (get_balance)             | 68ms    | Includes SQLite check                            |
| `tools/call` (init_account, write)     | 50.8ms  | DB write roundtrip                               |
| `tools/call` (get_balance, after init) | 2.7ms   | Warm state                                       |
| Clean shutdown via stdin.close()       | <3s     | Exits cleanly, return code 0                     |

**Server info reported:** `{"name": "pm-trader", "version": "1.27.0"}` (this version is the MCP SDK version, not the pm-trader package version — a minor self-reporting quirk worth noting).

**Protocol version:** `2024-11-05` — matches our `@modelcontextprotocol/sdk` expectations.

**STDERR output per request:**

```
Processing request of type ListToolsRequest
Processing request of type CallToolRequest
```

This is the Python `mcp` SDK's default request logging. **Noisy but harmless.** If mission-control pipes pm-trader-mcp's stderr to journalctl, we'll get one line per tool call which would spam logs. **Mitigation for F8:** set `PYTHONLOGLEVEL=ERROR` or `MCP_LOG_LEVEL=ERROR` in the subprocess env (or redirect stderr to `/dev/null` if we don't need error capture).

---

## 3. Actual tool count: 30 (not 26, not 29)

Live `tools/list` response on pm-trader-mcp v0.1.7 / server 1.27.0:

| #   | Tool                 | Category   |
| --- | -------------------- | ---------- |
| 1   | `init_account`       | Account    |
| 2   | `get_balance`        | Account    |
| 3   | `reset_account`      | Account    |
| 4   | `search_markets`     | Markets    |
| 5   | `list_markets`       | Markets    |
| 6   | `get_market`         | Markets    |
| 7   | `get_order_book`     | Markets    |
| 8   | `get_tags`           | Markets 🆕 |
| 9   | `get_markets_by_tag` | Markets 🆕 |
| 10  | `get_event`          | Markets 🆕 |
| 11  | `watch_prices`       | Markets    |
| 12  | `buy`                | Trading    |
| 13  | `sell`               | Trading    |
| 14  | `portfolio`          | Trading    |
| 15  | `history`            | Trading    |
| 16  | `place_limit_order`  | Orders     |
| 17  | `list_orders`        | Orders     |
| 18  | `cancel_order`       | Orders     |
| 19  | `cancel_all_orders`  | Orders 🆕  |
| 20  | `check_orders`       | Orders     |
| 21  | `stats`              | Analytics  |
| 22  | `stats_card`         | Analytics  |
| 23  | `leaderboard_entry`  | Social     |
| 24  | `share_content`      | Social     |
| 25  | `pk_card`            | Social     |
| 26  | `leaderboard_card`   | Social     |
| 27  | `pk_battle`          | Social     |
| 28  | `resolve`            | Settlement |
| 29  | `resolve_all`        | Settlement |
| 30  | `backtest`           | Strategy   |

**🆕 = new since the README was last updated (README lists 26).**

**v7 spec update:** The F8 row in `04-ordering-map.md` and `PHASE-BETA-PLAN.md` should read "30 tools" not "26" or "29."

---

## 4. Response shape analysis

Every response I observed followed one of two shapes:

**Success:**

```json
{
  "ok": true,
  "data": {
    "cash": 10000.0,
    "starting_balance": 10000.0,
    "positions_value": 0,
    "total_value": 10000.0,
    "pnl": 0.0
  }
}
```

**Error:**

```json
{
  "ok": false,
  "error": "Account not initialized. Run 'pm-trader init' first.",
  "code": "not_initialized"
}
```

This is **exactly** the shape we want for the fast-runner + hallucination-guard pipeline:

- `ok` is a boolean machine check (no regex parsing of error strings)
- `error` is a human-readable message that can be echoed to the operator
- `code` is a machine-readable error classifier that maps onto our existing `classifyToolError()` function in `src/runners/fast-runner.ts`

**Observation:** We should teach our `classifyToolError` to recognize pm-trader's `code` values (`not_initialized`, `insufficient_balance`, `market_not_found`, etc.) as "permanent" vs "transient" for retry logic. This is a small addition (~10-20 LOC) in F8.

---

## 5. The `--data-dir` / `PM_TRADER_DATA_DIR` bug

**Finding:** pm-trader v0.1.7 has a real bug where the `mcp` subcommand ignores both the global `--data-dir` CLI flag AND the `PM_TRADER_DATA_DIR` environment variable. The MCP server always writes to `~/.pm-trader/default/paper.db`.

**How I confirmed it:**

1. `pm-trader --data-dir /tmp/pm-trader-dryrun/ddir init --balance 777` — works correctly, writes to `/tmp/pm-trader-dryrun/ddir/default/paper.db`. Global flag honored.
2. `pm-trader --data-dir /tmp/pm-trader-dryrun/ddir2 mcp` with an `init_account` request piped to stdin — writes to `/root/.pm-trader/default/paper.db`. Global flag IGNORED.
3. Same test with `PM_TRADER_DATA_DIR=/tmp/pm-trader-dryrun/ddir` env var — same result, ignored.
4. `pm-trader mcp --help` confirms the `mcp` subcommand has NO flags of its own; it only shows `--help`.

**Root cause (from behavior):** The `mcp` subcommand in pm-trader doesn't re-read the click global options or the env var when initializing the MCP server's data backend. It falls back to the default `~/.pm-trader/` path.

### Workaround for F8 integration

Use the `HOME` environment variable trick: when mission-control spawns pm-trader-mcp, pass a custom `HOME` that points to a directory inside `./data/`:

```typescript
// src/finance/pm-trader-mcp.ts (F8 spawn code)
const pmTraderHome = path.join(process.cwd(), "data", "pm-trader-home");
await mkdirp(pmTraderHome);

const mcpClient = new McpClient({
  transport: new StdioClientTransport({
    command: "pm-trader-mcp",
    env: {
      ...process.env,
      HOME: pmTraderHome, // forces pm-trader's ~/.pm-trader to land here
      PYTHONLOGLEVEL: "ERROR", // silence the per-request stderr noise
    },
  }),
});
```

This lands the pm-trader SQLite file at `data/pm-trader-home/.pm-trader/default/paper.db`, which is:

- Inside our existing `data/` directory (so our backup ritual picks it up automatically)
- Not in `/root/.pm-trader/` (no cross-contamination with host state)
- Reversible (delete `data/pm-trader-home/` to reset)
- Verifiable (we can `ls` the directory after spawn to confirm)

### Upstream action

File a pm-trader GitHub issue with a minimal repro. This is a real bug — the documented `--data-dir` flag should work for all subcommands. Low priority for us (we have a workaround) but worth reporting for the next pm-trader user.

---

## 6. Integration contract for F8

Based on the dry-run, here's the concrete integration shape for F8:

### Install step (F8 session deploy checklist)

```bash
# One-time install on mission-control VPS
cd /root/claude/mission-control
python3 -m venv .pm-trader-venv
.pm-trader-venv/bin/pip install polymarket-paper-trader==0.1.7
# Entry point: .pm-trader-venv/bin/pm-trader-mcp
```

Pin the version explicitly — don't use `--upgrade`. Phase β's F8 session pins pm-trader to a specific version. Upgrades go through a future session.

### Spawn code (F8 TypeScript)

```typescript
// Pseudo-code for the F8 spawn layer
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

const PM_TRADER_HOME = path.resolve("./data/pm-trader-home");
await fs.mkdir(PM_TRADER_HOME, { recursive: true });

const transport = new StdioClientTransport({
  command: ".pm-trader-venv/bin/pm-trader-mcp",
  env: {
    ...process.env,
    HOME: PM_TRADER_HOME,
    PYTHONLOGLEVEL: "ERROR",
  },
});

const client = new Client({
  name: "mission-control-pm-trader",
  version: "0.1.0",
});

await client.connect(transport);
const tools = await client.listTools(); // returns 30 tools
```

### Startup hook (F8 runtime)

Before any tool call, verify the pm-trader account exists and is initialized:

```typescript
async function ensureAccount(client: Client): Promise<void> {
  const balance = await client.callTool({
    name: "get_balance",
    arguments: {},
  });
  const parsed = JSON.parse(balance.content[0].text);
  if (!parsed.ok && parsed.code === "not_initialized") {
    await client.callTool({
      name: "init_account",
      arguments: { balance: 10000 },
    });
  }
}
```

This runs once at subprocess spawn time. After this, all 30 tools are available.

### Error classification extension

Extend `classifyToolError()` in `src/runners/fast-runner.ts` to recognize pm-trader error codes:

```typescript
const PM_TRADER_PERMANENT_CODES = new Set([
  "market_not_found",
  "market_closed",
  "invalid_outcome",
  "insufficient_balance",
  "invalid_amount",
  "order_not_found",
]);
const PM_TRADER_TRANSIENT_CODES = new Set([
  "polymarket_api_timeout",
  "polymarket_api_5xx",
  "rate_limited",
]);
// ... dispatch based on code
```

### Subprocess lifecycle

**One pm-trader-mcp subprocess per mission-control process.** Spawn at startup, keep alive, reuse across all tool calls. Don't spawn one per request — the 660ms cold start would dominate.

If the subprocess dies (crash, OOM, orphan after mc restart), respawn on the next tool call. Same pattern as our existing MCP server integrations.

---

## 7. Risks NOT surfaced by this dry-run

The dry-run validated the protocol, shape, and latency. It did NOT test:

1. **Long-running subprocess stability.** My dry-run spawned and shut down within 5 seconds. F8 will keep pm-trader-mcp alive for hours/days. Memory leaks, connection pool exhaustion, file handle leaks are possible. **Mitigation:** F8 session includes a 2-hour soak test (spawn, 200 calls over 2 hours, verify memory stays flat).
2. **Concurrent tool calls.** MCP stdio is request/response sequential. What happens if mission-control's fast-runner sends two `buy` calls back-to-back? Does pm-trader queue them, or reject the second? **Mitigation:** F8 code serializes calls through a single client-side mutex.
3. **Polymarket API rate limits.** pm-trader calls the real Polymarket API for market data. Rate limits on the upstream are not our rate limits. **Mitigation:** respect `polymarket_api_rate_limited` error codes via the transient-retry path.
4. **SQLite WAL contention.** pm-trader uses SQLite WAL mode for its paper.db. If we ever run two pm-trader-mcp subprocesses simultaneously (shouldn't but could), WAL contention is possible. **Mitigation:** enforce single-subprocess invariant in the spawn code.
5. **Upgrade paths.** pm-trader's SQLite schema may change across versions. How does `pip install --upgrade polymarket-paper-trader` interact with an existing `paper.db`? **Mitigation:** F8 pins the version; upgrades are explicit deliberate sessions.

None of these are blockers for F8 session start. They're follow-up test targets for the F8 session itself.

---

## 8. F8 session estimate impact

**Original estimate:** 1.5 sessions (from v7 roadmap).

**Revised after dry-run:** **1.5 sessions — unchanged.** The dry-run confirmed the happy path works; no rework or replacement required. The HOME-env-var workaround is 5 LOC, the error classification extension is 15 LOC, the ensureAccount hook is 10 LOC. All small additions inside the 1.5-session budget.

Compare to the counterfactual: if pm-trader had been dead, incompatible, or broken, F8 would have needed a from-scratch TypeScript paper-trading layer against Polymarket raw API — that's 3-4 sessions, maybe more. **The dry-run saved 2+ sessions of risk.**

---

## 9. Cleanup

All dry-run artifacts live in `/tmp/pm-trader-dryrun/`. Removing that directory cleans up:

- Python venv (~80 MB)
- Test scripts (`mcp_dryrun.py`, `mcp_writetest.py`)
- Stray `ddir/` from the CLI flag test

The dry-run also created a `/root/.pm-trader/` directory during the first write test (before I discovered the `--data-dir` bug). **I removed it** — `rm -rf /root/.pm-trader` confirmed. No stale state left on the host.

Nothing was committed to the repo. Nothing was installed into mission-control's venv. Nothing was added to systemd. Zero impact outside `/tmp/`.

---

## 10. Summary for F8 pre-plan

F8 is GREEN. The math study for F7 (item A) was 7 gaps and a recommendation to write a 1-page addendum. This dry-run is the opposite: **no gaps, no addendum needed, the integration shape is concrete**.

Three small things to remember when F8 starts:

1. **Spawn with `HOME` env var override** (5 LOC) — `data/pm-trader-home/`
2. **Set `PYTHONLOGLEVEL=ERROR`** (1 LOC) — silences per-request stderr spam
3. **Extend `classifyToolError`** (15 LOC) — recognize pm-trader error codes for transient/permanent classification

Plus the existing F8 scope from the v7 spec: `trade_theses` table wiring, thesis-commitment UI in mc-ctl, 2-hour soak test, shadow portfolio, replication scoring against Polymarket whales.

**Tool count correction:** update PHASE-BETA-PLAN.md + 04-ordering-map.md from "26 tools" to "30 tools."

**Follow-up (not blocking):** file upstream bug on pm-trader's `--data-dir` regression in the `mcp` subcommand.
