# NanoClaw upstream review — v2.3.0 → v2.4.0 + Unreleased (2026-10-01)

Monthly review of `qwibitai/nanoclaw` since the last one (2026-09-01, v2.3.0):
**v2.4.0 (2026-09-23)** plus the commits to 2026-10-01. Memory:
`reference_nanoclaw_upstream`. Companion note:
`hermes-upstream-review-2026-10-01.md` (same session, one commit; the method,
the 30-day production numbers and the audit table live there).

## Method

Release notes, `CHANGELOG.md` and the commit log (subjects + the bodies of the
candidates) were read; each candidate was checked against the live code and
30 days of production data before a verdict. v2.4.0 is mostly product surface
(credential gateways through skills, community-portal setup, model and speed
controls, Mattermost, Codex provider changes) — one item maps to a gap here,
one to a gap closed in the Hermes note, one is a dependency decision.

Our nanoclaw runner in the window: **5 completed / 7 failed** (last run
2026-09-24; all seven are scope/capability refusals, not infrastructure).

## Shipped (1, plus one shared with the Hermes note)

### 1. A dead MCP server is recovered, and its tools fail fast — nanoclaw v2.4.0 tool-server lifecycle

Upstream (v2.4.0 Fixes): *"The provider now waits for every MCP server to
finish starting … and requires NanoClaw's own tool server: if that server
cannot start, the message fails with an error instead of running without its
tools."* (Hermes #106546 covers the same lifecycle from the replay side.)

- **Gap:** `src/mcp/manager.ts` reconnected only servers that failed at boot.
  A stdio server that died later stayed dead until restart: its tools remained
  registered and each call waited out the transport error; nothing told the
  operator.
- **Fix:**
  - `client.onclose` → `handleServerClosed`: the server's tools are replaced by
    fail-fast proxies (`MCP server <id> is down (auto-reconnect pending)`), an
    operator alert is sent, and the existing 60 s reconnect loop takes the
    server.
  - Connect, `listTools()` and tool registration run inside one guarded `try`;
    a failure closes the client (no leaked child process) and nothing is left
    half-registered. A reconnect re-registers every tool against the new
    client.
  - One reconnect at a time (`reconnectInFlight`); shutdown during a connect
    closes the late client.
  - **Bounded alerts:** at most 2 DEGRADED alerts per server in any rolling
    hour, each followed by at most one "reconnected" alert; a server that dies
    three times in an hour, or dies within 5 minutes of a reconnect, is
    *flapping* — quiet, attempts carried over — and ends in one `giving up
    after N reconnect attempts … Manual restart required` alert, after which
    its tools answer `reconnect abandoned — restart required`. A boot connect
    failure counts as a death.
- **Deliberately not silenced:** a server that dies at a steady ≤ 2 per hour
  never counts as flapping and alerts on every death (~95 alerts / 24 h at one
  death per 30 min). It is a recurring outage the operator should see; a daily
  cap is queued with a trigger.
- **Residuals (report-only):** a tool the server stops exposing after a
  reconnect stays registered (fails at call time); an SDK query already in
  flight keeps the proxy it started with; `healthCheckAll` has no caller;
  `buildMcpServer` (`claude-sdk.ts`) silently drops tool names that are not in
  the registry; a lazy server whose activation fails alerts on every activating
  call (pre-existing).
- **Evidence:** 43 tests in `manager.test.ts`; alert schedules replayed with
  fake timers by the auditor (nine schedules, two servers interleaved).

### (shared) Process-group kill on timeout — nanoclaw #3957

*"kill the whole process group when a pre-task script times out."* Our
`shell_exec` and `check_cmd` already did; `jarvis_test_run` and `vps_deploy`
did not. Closed in the Hermes note, item 5.

## Confirmed already present / N/A

| NanoClaw item | Ours |
| --- | --- |
| #3893 (`d36c7ca4`) heartbeat stays alive while Claude streams a long block | N/A — no heartbeat-driven kill of a streaming turn here |
| v2.4.0 `CLAUDE.md` `@` imports outside the project are silently dropped | N/A — the Jarvis prompt is assembled in code, no `@` imports |
| v2.4.0 Claude agents default to the `Concise` output style | N/A — the prompt owns tone (changing it would need the eval gate) |
| `ee0f0adf` drop `TaskOutput` (removed in Claude Code 2.1.277) | N/A today — the fast path passes `tools: ["ToolSearch"]` only; re-check on the SDK bump |
| v2.4.0 "failed provider turns keep partial replies" | present — `keepLeg1Partial` / `mergeSdkLegs` |

## Deferred — with triggers

| Item | Why not now | Trigger |
| --- | --- | --- |
| **Claude Agent SDK 0.3.245 → 0.3.281** (upstream pins `^0.3.280`; 0.3.287 is latest, 0.3.281 is the newest release past the 7-day `min-release-age`) | needs the service stopped for `npm install`, the paid eval gate, and `validate-tool-search`; the Sonnet 5.5 canary readout (~10-06) must not be confounded by an SDK change. Upstream's bump notes two behaviour changes to check first: since Claude Code 2.1.267 a session's system prompt is recorded on its first request and re-sent on every resume (upstream passes `snapshot: false`), and 2.1.275 adds a claude.ai skill/plugin sync that upstream opts out of | after the canary readout; operator runs the stop + install + deploy |
| `@alibaba-group/opensandbox` 1.1.0 (major) | exact-pinned at 0.1.11; no fix in the window maps to an observed failure (nanoclaw: 12 runs, 0 infrastructure failures) | first sandbox-backend failure traced to the client, or a security advisory |
| Daily cap on MCP DEGRADED alerts for a steady slow-dying server | not observed; the alert is information | first day with > 10 MCP alerts for one server |
| MCP: drop registered tools a server no longer exposes after reconnect | not observed (tool lists are static per server version) | a server upgrade that removes a tool |
| `buildMcpServer` silently drops unknown tool names | pre-existing; affects only misconfigured scope lists | first "tool not available" report traced to it |

## Tier 3 skipped

Credential gateways through skills (OneCLI / Iron Proxy), community-portal
setup, managed Slack app, Mattermost channel, install-wide and per-group model
and speed controls, Codex provider fixes, threading fixes for chat platforms,
Linux setup fixes, `/update-nanoclaw`, `/add-dial`.

## Cadence

Upstream is at **v2.4.0 (2026-09-23)** with an open Unreleased section. Next
review due **2026-11-01**.

## Audit

See the table in `hermes-upstream-review-2026-10-01.md`. MCP recovery: R1 PASS
WITH WARNINGS (alert storm on a flapping server, leaked child on a failed
`listTools`, shutdown race) → R2 PASS WITH WARNINGS (storm moved past the
stability threshold; give-up wording) → R3 PASS WITH WARNINGS (boot failure
not counted as a death; the bound stated in the comment was false) → folded;
every fix mutation-checked.

## Deploy

Operator: `cd /root/claude/mission-control && ./scripts/deploy.sh`

Post-deploy proof for this note's item: the boot log shows each MCP server
connected; no `[mcp]` DEGRADED line in the first minutes.
