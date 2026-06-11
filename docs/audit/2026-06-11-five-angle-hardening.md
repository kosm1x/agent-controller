# 2026-06-11 — Five-Angle Hardening Audit

Full-codebase audit from five independent angles (performance, memory
handling, resilience/fault-tolerance, code hygiene, security), run by five
parallel auditor agents, triaged, implemented in one bundle, gated by
qa-auditor (verdict SHIP, both warnings folded), deployed same day.

- **Commit**: `c2e8fd2` (31 files, +652/−1787) · deployed 02:24 UTC, PID 364247 → 1007086
- **Revert path**: tag `pre-audit-2026-06-11` + `backups/pre-audit-2026-06-11-src.tar.gz`
- **Tests**: 6,195 passing · typecheck clean
- **Post-deploy verification**: router active (Telegram + email; WhatsApp skipped — pre-existing logged-out session, isolation worked as designed), Prometheus scrape up post-gate, /health detailed for private peers only.

## Shipped fixes by angle

### Resilience

| Fix                                                                                                                                                                                            | File(s)                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Shutdown drains in-flight tasks BEFORE messaging/tool-source teardown (old order stranded surviving tasks without tools or delivery channel)                                                   | `src/index.ts`                              |
| Shutdown re-entry guard (second SIGTERM during grace drain ran concurrent teardown → SQLITE_MISUSE risk)                                                                                       | `src/index.ts`                              |
| WhatsApp reconnect: flat 3s forever → exponential backoff (3s→60s) + jitter + `stopped` flag (`stop()` previously could not halt the loop — `sock.end()`'s close event resurrected the socket) | `whatsapp.ts`                               |
| Email channel init isolated (try/catch + 20s timeout per mailbox + `unregisterChannel` on failure); config error no longer crash-loops the orchestrator                                        | `messaging/index.ts`, `router.ts`           |
| `wa.stop()` on WhatsApp init failure — orphaned Baileys socket can no longer hold the session and drop inbound into a null handler                                                             | `messaging/index.ts`                        |
| Telegram `send()` throws instead of returning `"not_initialized"` sentinel (broadcast paths counted the sentinel as delivered)                                                                 | `telegram.ts`                               |
| Cron-boundary catches: ritual executes wired to `recordRitualFailure`, idle-detect catch                                                                                                       | `rituals/scheduler.ts`, `triggers/index.ts` |
| Dynamic schedules emit `schedule.run_failed` on submit failure (was a log-only dead end; the day's slot is consumed by `markExecuted`)                                                         | `rituals/dynamic.ts`                        |

### Performance (per-message hot path)

| Fix                                                                                                                                                                                                                                                               | Est. impact                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `enrichContext` ∥ `classifyScopeGroups` via Promise.all (were serialized; classifier alone can take its full 3s timeout)                                                                                                                                          | 0.5–3.5s per inbound message       |
| Skill-match embed joined to the parallel recall batch in `enrichContext` (was awaited before recalls started); skill block keeps first-section priority under the 5K cap                                                                                          | 100–300ms                          |
| In-flight-aware embedding dedupe cache (`generateEmbedding`, 64 entries / 5-min TTL / promise-cached) — same message text was embedded 2–3× per message by parallel consumers                                                                                     | 1–2 API round-trips per message    |
| Float32Array deserialization cache in hybrid recall (1000 ids; recall deserialized up to 500 BLOBs ≈ 3 MB per message). Invalidated via `clearVectorCache()` on consolidation deletes — `conversations.id` has no AUTOINCREMENT, deleted max-rowids can be reused | ~5–15ms CPU + GC churn per message |
| `idx_runs_task_created` composite index (router's latest-run-for-task lookups used a temp B-tree sort) — applied live + in schema.sql                                                                                                                             | per task-completion delivery       |

### Security

| Fix                                                                                                                                                                                                     | Notes                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/metrics` gated by `privateOrApiKeyAuth`; `/health` returns liveness-only to public peers                                                                                                              | Port 8080 is UFW-open. Private peers = loopback + RFC1918 + ULA, socket address only (XFF ignored). Verified: mc-prometheus scrape (docker bridge 172.19.x) still passes keyless. |
| Timing-safe API-key comparison (`timingSafeEqual` with length-mismatch padding)                                                                                                                         | `api/auth.ts`                                                                                                                                                                     |
| DNS-resolving SSRF check `validateOutboundUrlResolved` on `http_fetch` — closes the static DNS-rebinding bypass (public name → A record at 127.0.0.1/10.x/169.254.169.254). Residual TOCTOU documented. | `lib/url-safety.ts`, `tools/builtin/http.ts`                                                                                                                                      |
| IPv6 ULA blocklist widened `fc00:` → `f[cd]xx:` (fd00::/8 was a bypass of both the literal and resolved checks)                                                                                         | qa-auditor W2 fold                                                                                                                                                                |

### Memory handling

| Fix                                                                                                                                                                                                                                           | Notes         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| WhatsApp outgoing queue: unbounded → cap 100 drop-oldest + 24h staleness discard + peek-send-shift flush (mid-flush failure retains instead of losing) + 2-3s pacing (burst-flush after reconnect is the wrong shape for a ban-averse number) | `whatsapp.ts` |
| `previousScopeGroups`/`previousMessages` joined the router's 24h TTL sweep; `pushToThread` records `threadLastAccess` (background-spawn-path keys were never evicted)                                                                         | `router.ts`   |
| Typing-indicator 5-min safety `setTimeout` handle stored and cleared (one leaked per message)                                                                                                                                                 | `whatsapp.ts` |

### Hygiene

| Fix                                                                                                                                                                                                                                                       | Notes                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| MCP degradation alerts rewired to the LIVE manager via `McpToolSource.setAlertFn()`. The `src/mcp/index.ts` barrel held a `_manager` only set by `initMcp()` — never called anywhere — so operator alert broadcast was a permanent no-op. Barrel deleted. | `tools/sources/mcp.ts`, `index.ts`                        |
| Drifted duplicate `MODEL_PRICING` table deleted; adapter delegates to `budget/pricing.ts` `calculateCost` (dashboard cost now agrees with the budget ledger and honors `BUDGET_PRICING_JSON`)                                                             | `inference/adapter.ts`                                    |
| `"claude-sonnet-4-6"` literal → `SONNET_MODEL_ID` (claude-sdk.ts:439, next model bump can't diverge silently)                                                                                                                                             | `inference/claude-sdk.ts`                                 |
| 4 cron registrars derive timezone from `RITUALS_TIMEZONE` instead of hardcoding `"America/Mexico_City"` (setting the env var would have split schedules across timezones)                                                                                 | checkpoint-prune, test-sweep, s3/scheduler, cohort/rollup |
| `DEFAULT_RECALL_TIMEOUT_MS` 3000 → 8000 — matches the drift.ts invariant; deleting the env var no longer silently re-enters the timeout-jitter regime                                                                                                     | `memory/hindsight-client.ts`                              |

## Verified-good (do not re-fix)

Boot orphan-task reconciliation; SQLite WAL/busy_timeout/writeWithRetry;
WhatsApp+Telegram init isolation (3ce178a); email adapter internals (op
timeouts, per-UID catches, bounce filter); inference adapter retries/circuit
breaker; event bus persist-before-deliver; dispatcher CAS checkout; rate-limit
XFF handling; file-tool path allowlists (resolve-before-prefix); no SQL
interpolation; no committed secrets; no `require()`/empty-catch in src.

## Known-deferred (audited, intentionally not built)

1. **`appendDayLog` O(n²)** (`router.ts`): full read+rewrite of the day log
   ×4 per exchange, with sync FS mirror write. Fix shape: in-memory current-day
   string + `fs.appendFile` mirror leg.
2. **`UNTRUSTED_TOOLS` hardcoded 12-name list** (`inference/guards.ts:214`):
   new open-world tools silently bypass injection scanning. Fix shape: derive
   from `openWorldHint && readOnlyHint` registry annotations + manual override
   set. (`isUntrustedTool()` is also exported-but-unused.)
3. **Dead exported API**: `tuning/schema.ts` (getActiveVariant et al.),
   `rituals/dynamic.ts` (getSchedule/getScheduleRuns/deactivateSchedule),
   `dispatcher.setMaxContainers` — delete or wire consumers.
4. **`fast-runner.ts:668` stale routing comment** (says qwen primary; claude-sdk
   since 2026-05-10).
5. `uncaughtException` doesn't flip `running` tasks before exit (systemd
   restart + boot reconciliation cover it).
6. WhatsApp flush vs concurrent `send()` ordering nuance (qa-auditor N1): a
   fresh send during a paced flush jumps the backlog. No loss; pacing nuance only.
