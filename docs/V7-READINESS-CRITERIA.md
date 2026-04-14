# V7 Readiness Criteria — Jarvis as a Learning Trading Agent

> Minimum tentpoles that must hold before Jarvis can be trusted as an autonomous financial agent that learns, adapts, and acts on its own judgment.

## The Standard

Jarvis is not a dashboard. It's not a notification bot. It's a **trading agent** that forms theses, validates them, practices with real market data, and earns the right to be heard through demonstrated competence — not through authority or configuration.

Every criterion below must be met **before** Jarvis is given real financial responsibility.

---

## Pillar 1: Operational Reliability

> "Can I leave Jarvis running for 30 days and trust it won't break?"

| Criterion              | Metric                                                                                | Current                                          |
| ---------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **Uptime**             | Service runs 30 consecutive days without manual restart                               | Untested at 30 days                              |
| **Message delivery**   | 99%+ of WhatsApp/Telegram messages get a response                                     | Needs validation                                 |
| **Ritual completion**  | All 11 scheduled rituals fire on time, every day, for 30 days                         | Needs validation                                 |
| **No silent failures** | Telegram reconnect, MCP reconnect, provider failover all work without intervention    | Reconnect logic shipped, untested at scale       |
| **Context integrity**  | Long conversations (50+ turns) don't degrade response quality                         | Compaction exists, untested under sustained load |
| **Memory stability**   | Thread buffer, pgvector, jarvis_files all function after 30 days of continuous writes | DB at 118MB, growth rate needs monitoring        |

**Gate:** If any ritual misses 2+ days in a row, or message delivery drops below 95%, Jarvis is not ready for financial responsibility.

---

## Pillar 2: Signal Accuracy

> "When Jarvis says 'buy signal', is it right more often than wrong?"

| Criterion                  | Metric                                                  | Minimum               |
| -------------------------- | ------------------------------------------------------- | --------------------- |
| **Backtest win rate**      | Shadow portfolio over 30+ simulated trades              | > 55%                 |
| **Sharpe ratio**           | Risk-adjusted return on paper portfolio                 | > 0.8                 |
| **Max drawdown**           | Worst peak-to-trough on paper portfolio                 | < 15%                 |
| **False signal rate**      | Signals that reverse within 1 hour of alert             | < 25%                 |
| **Regime accuracy**        | Correctly identifies trending/ranging/volatile market   | > 70%                 |
| **Composite confirmation** | Signals require ≥3 of 4 lenses to agree before alerting | Enforced mechanically |

**Gate:** If paper portfolio Sharpe drops below 0.5 for any rolling 2-week window, Jarvis pauses financial alerts and retrains.

---

## Pillar 3: Self-Awareness

> "Does Jarvis know what it doesn't know?"

| Criterion                    | Behavior                                                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Confidence calibration**   | When Jarvis says 70% confidence, it should be right ~70% of the time. Tracked via Brier score on paper trades                       |
| **Regime humility**          | In volatile/uncertain regimes, Jarvis reduces signal frequency and raises confirmation thresholds instead of generating more alerts |
| **Edge decay detection**     | If a strategy's rolling win rate drops below 50% over 20 trades, Jarvis flags it as degraded and stops using it until revalidated   |
| **Data staleness awareness** | Jarvis knows when its last FRED/price/prediction market data refresh was. If data is > 24h stale for daily series, it says so       |
| **Honest uncertainty**       | "I don't have a strong signal right now" is an acceptable output. Jarvis never fabricates conviction                                |

**Gate:** If Brier score exceeds 0.35 (poorly calibrated) over 50+ predictions, Jarvis retrains before continuing.

---

## Pillar 4: Learning Loop

> "Is Jarvis getting better over time, not just repeating the same mistakes?"

| Criterion                    | Metric                                                                                             | Evidence                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **Strategy adaptation**      | Win rate per strategy type improves or stays stable over 60-day rolling window                     | Monthly strategy report                         |
| **Regime-strategy matching** | Jarvis selects higher-performing strategies for the current regime vs random selection             | Backtest comparison: regime-matched vs baseline |
| **Whale alignment trend**    | Replication score vs smart money is stable or improving, not degrading                             | 30-day rolling alignment chart                  |
| **Mistake non-repetition**   | Same type of bad trade (e.g., buying oversold in a trending bear) occurs less frequently over time | Error categorization in trade journal           |
| **Playbook evolution**       | Jarvis proposes new signal combinations that weren't in the original 9-strategy playbook           | Tracked via trade journal annotations           |

**Gate:** If rolling 30-day win rate declines for 3 consecutive weeks, Jarvis enters "observation mode" — still detects signals but doesn't paper trade or alert until the decline reverses.

---

## Pillar 5: Communication Quality

> "When Jarvis speaks about markets, is it clear, honest, and useful?"

| Criterion                     | Standard                                                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **No hallucinated trades**    | Jarvis never claims it bought/sold something it didn't. Confirmation gate enforced on all write actions                                   |
| **Evidence-backed alerts**    | Every alert includes: signal type, supporting indicators, paper track record, smart money alignment                                       |
| **Concise delivery**          | Market alerts fit in one WhatsApp message (< 500 chars for summary, expandable on request)                                                |
| **Actionable language**       | "BTC RSI at 28 with macro support — likely bounce" not "several indicators suggest potential upward movement in the cryptocurrency space" |
| **Track record transparency** | Win rate, Sharpe, drawdown always included. Never hidden when performance is poor                                                         |
| **Thesis clarity**            | Every signal has a one-sentence thesis: "Oversold bounce with macro tailwind" — not just indicator values                                 |

**Gate:** If the user ignores 5 consecutive alerts (no response within 24h), Jarvis reduces alert frequency — it's either sending noise or the user lost trust.

---

## Pillar 6: Safety & Risk Management

> "Can Jarvis lose my money or embarrass me?"

| Criterion                                | Enforcement                                                                                                            |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Paper-only by default**                | No real money trading without explicit user activation. Config flag, not prompt instruction                            |
| **Confirmation required for all trades** | Even paper trades require user "sí" via confirmation gate — Jarvis proposes, user disposes                             |
| **No position sizing advice**            | Jarvis detects signals and practices, but NEVER tells the user how much real money to invest                           |
| **No specific buy/sell recommendations** | Jarvis reports what it sees and what it practiced — "I paper traded this with 62% success" — not "you should buy AAPL" |
| **Disclaimer on every alert**            | "Paper trading results. Not financial advice." — mechanical, not LLM-generated                                         |
| **Circuit breaker**                      | If paper portfolio drops > 20% in a week, all alerts pause automatically                                               |
| **Audit trail**                          | Every signal, paper trade, and outcome logged to jarvis_files with timestamps                                          |

**Gate:** These are non-negotiable. Any bypass = immediate pause of all financial features.

---

## Pre-V7 Validation Checklist

Before starting v7 implementation, confirm after 30 days of production:

- [ ] Service ran 30 days without manual restart
- [ ] All 11 rituals fired correctly for 30 consecutive days
- [ ] WhatsApp/Telegram message delivery > 99%
- [ ] No hallucinated tool executions (confirmation gate held)
- [ ] Context pressure stayed manageable (no emergency compactions)
- [ ] DB growth is sustainable (projected < 500MB at 6 months)
- [ ] Scope classifier accuracy stable (no new tool routing bugs)
- [ ] Proactive scanner fires reliably without false positives
- [ ] Thread buffer hydration survives restarts cleanly
- [ ] No poisoned thread incidents requiring manual cleanup
- [x] **MCP browser tool URL validation gap closed** — ✅ shipped 2026-04-14 session 67 (v7.6.1). Single intercept at `createMcpTool.execute()` pre-validates URL-bearing args via `validateArgsUrls()`. Covers ALL MCP tools (lightpanda, playwright, future servers). See Known Issues below for the full threat model and the fix details.

**If all boxes are checked: start v7 F1.**
**If any box fails: fix that specific item first, extend validation period.**

---

## Known Issues

### ~~URL safety gap on MCP browser tools~~ ✅ CLOSED 2026-04-14 (v7.6.1 + v7.6.2 audit follow-up)

**Discovered:** 2026-04-14 day 5 of the 30-day validation window during the `mc-ctl validation check` scope-classifier false-positive investigation. A scheduled PipeSong task on 2026-04-13 15:01 UTC had an LLM try `file:///root/claude/mission-control/.env` and `file:///root/claude/mission-control/src/tools/builtin/` via the MCP browser. Playwright's UnsupportedProtocol allowlist blocked both (no exfiltration), but the investigation found that SSRF targets looking like normal HTTP URLs (`http://localhost:3000/api/datasources/`, `http://10.x.x.x`, `http://192.168.x.x`, `http://127.0.0.1:9090/metrics`) would have reached Playwright with nothing in the way.

**The gap (now closed).** Jarvis's `validateOutboundUrl()` only ran on **builtin tools that explicitly called it** — `web_read`, `seo_page_audit`, `http`. The Playwright MCP browser tools (`browser__markdown`, `browser__navigate`, `browser__screenshot`, lightpanda's `browser__goto`, etc.) came from MCP servers and bypassed this validation entirely.

**The fix (v7.6.1 — session 67, 2026-04-14).** Single intercept point at `createMcpTool.execute()` in `src/mcp/bridge.ts` — the ONE funnel every MCP tool from every MCP server passes through. New helper `validateArgsUrls()` in `src/lib/url-safety.ts` recursively scans the args object for string values under URL-convention keys (`url`, `uri`, `href`, `link`, `target`, `target_url`, `location`, `src`, `source_url`, `endpoint`, `page`, `page_url`, `navigate_to`, `goto`, case-insensitive) with a max depth of 3, and runs `validateOutboundUrl()` on any value that parses as an absolute URL (matches `scheme://`). If any URL fails validation, the bridge returns the standard error envelope (`{error: "Blocked outbound URL: ..."}`) **without forwarding to the upstream MCP server**. Walks arrays of objects but skips arrays of primitives (too many false positives). Short-circuits on first block.

**Key design choices:**

- **Single intercept, not a ToolSource wrapper.** One function (`createMcpTool.execute()`), ~15 LOC delta, covers EVERY MCP server (current and future) with one change. The original v7.6 Phase 1 plan was to wrap `@playwright/mcp` specifically — the bridge-intercept approach is strictly better because it also catches lightpanda, hypothetical new MCP servers, and any schema drift where a tool adds a new URL param.
- **Scheme gating minimizes false positives.** The helper ONLY validates values that match `^[a-z][a-z0-9+\-.]*:\/\/`. A search query `"how to fix bug"` under a `url` key is let through unchanged. Only real URL strings get validated.
- **URL-key whitelist, not content-based detection.** The helper only inspects strings under specific key names. A `description: "see http://localhost/docs"` is NOT validated — we don't parse prose for URL substrings. This keeps false positives near zero at the cost of missing tools that use non-standard param names. Acceptable because the URL key set is easy to extend, and the current state was 0% coverage so any deterministic coverage is a strict improvement.
- **Audit logging.** Every rejection emits `[mcp] blocked URL-bearing arg on <tool_name>: <path>: <reason>` to stderr via `console.warn` — surfaces attempted SSRF in journalctl without touching the tool result format.

**Test coverage (v7.6.1):** 16 new tests in `src/lib/url-safety.test.ts` + 7 new tests in `src/mcp/bridge.test.ts`. All 23 cases green. Full suite: 2071 → 2094 tests.

**QA audit findings + v7.6.2 follow-up (same-day).** A dedicated qa-auditor pass on commit `0c29f84` surfaced three real bypasses in `validateOutboundUrl()` that pre-dated v7.6.1 but flowed through the new MCP surface unblocked — meaning the "Known Issue closed" claim would have been dishonest. All three plus four secondary findings shipped as v7.6.2 the same day:

- **C1 (critical) — trailing-dot hostname bypass.** `http://localhost./` returned null (safe). DNS strips the trailing FQDN dot and resolves identically to `localhost`. **Fix:** strip trailing `.` from hostname before `BLOCKED_HOSTS.has()`. Regression test added.
- **C2 (critical) — IPv6 unspecified address bypass.** `http://[::]/` returned null. `::` is not covered by `::1` / `fc00:` / `fe80:` patterns, routes to loopback on Linux. **Fix:** added `/^::0*$/` to `BLOCKED_IP_PATTERNS` (covers `::`, `::0`, `::00`, etc.). Regression test added.
- **R4 (critical) — `javascript:` / `data:` / `vbscript:` / `file:` URIs without `//` bypassed the scheme gate.** The `^[a-z][a-z0-9+\-.]*:\/\/` regex required `://`, which these schemes lack. Playwright's own `checkUrlAllowed` only blocks `file:` — `javascript:fetch("http://169.254.169.254")` via `browser_navigate` would have been executed. **Fix:** replaced the regex gate with `URL.canParse()`. Schemes without `//` now parse successfully, reach `validateOutboundUrl()`, and get rejected by the `ALLOWED_SCHEMES` check. Regression tests for each URI scheme added.
- **W1 (warning) — whitelist expansion.** Extended `URL_PARAM_KEYS` from 15 → 46 names to cover common third-party MCP conventions: `destination`, `webhook_url`, `callback_url`, `redirect_uri`, `redirect_url`, `return_url`, `api_url`, `base_url`, `endpoint_url`, `destination_url`, `ping_url`, `website`, and variants. Zero false-positive risk because `URL.canParse()` gates downstream.
- **W3 (warning) — string arrays under URL-convention keys not walked.** `{url: ["http://ok.com", "http://localhost/"]}` was passed through unvalidated. **Fix:** when the parent key is in `URL_PARAM_KEYS` and the value is an array, string elements are now validated (not just objects).
- **W5 (warning) — audit log contract not asserted in tests.** The `[mcp] blocked URL-bearing arg` log line is load-bearing for the future Pillar 6 validation item. Added `console.warn` spy assertions for both the block path and the no-op on happy path.
- **W6 (warning) — `args = null/undefined` not tested at the bridge call site.** Added resilience tests covering both.

**Test coverage (v7.6.2):** 21 additional tests in `url-safety.test.ts` (C1/C2/R4 regression coverage, W1 expanded whitelist keys, W3 array walking) + 8 additional tests in `bridge.test.ts` (audit log spy, null/undefined args, C1/C2/R4/W1 end-to-end via the bridge). Full suite: 2094 → 2123 tests.

**Net v7.6.1 + v7.6.2 coverage:** 37 new url-safety tests + 15 new bridge tests = 52 new security tests total against the MCP URL attack surface.

**Key design choices (post-audit):**

- **URL.canParse() gate, not regex.** Catches schemes without `//` (javascript:, data:, vbscript:, file:, blob:) so they reach `validateOutboundUrl()`'s scheme check and get rejected. More permissive parse gate, stricter downstream semantic check.
- **Generous whitelist, tight parse gate.** Adding keys to `URL_PARAM_KEYS` costs nothing because non-URL strings under those keys are filtered by `URL.canParse()`. The right tradeoff: wide-key + strict-value instead of narrow-key + loose-value.
- **Single bridge intercept beats per-source wrappers.** One function, covers every current and future MCP server with one change. Strictly better than the v7.6 original plan to wrap `@playwright/mcp` as a ToolSource.
- **Audit logging via `console.warn`, tested.** Every rejection emits a structured line to stderr that a future `mc-ctl validation check` Pillar 6 item will scan from journalctl.

**Deferred follow-ups** (Pillar 6 defense-in-depth, not blocking v7.0):

1. **Network-layer block (iptables OUTPUT rule)** — drop traffic from the Playwright Chromium process to RFC1918 + loopback + link-local. Defense at OS layer, catches Chromium-internal redirects and JS-initiated fetches that don't go through the tool-call boundary. Value is in defending against the class "URL was safe at tool call time but resolved to an internal target via redirect or JS" — not currently observed in production but worth having.
2. **Validation script Pillar 6 check** — `mc-ctl validation check` should scan for `[mcp] blocked URL-bearing arg` log lines and surface the count as a Pillar 6 signal. Future attempted SSRF would show up in the validation log instead of silently getting blocked. Not built yet.
3. **Non-URL-key attack surface audit** — walk all registered MCP tool schemas and flag any URL-bearing param whose key name isn't in `URL_PARAM_KEYS`. Extend the set if needed. One-shot audit, not recurring.

**Validation script false-positive (also fixed 2026-04-14).** The Pillar 1 scope-classifier check (`mc-ctl validation check` item 8) was false-positiving on Playwright errors and reporting 4 "scope classifier errors". Regex tightened to require `[router]` / `[classifier]` / `[messaging]` log prefix and exclude pino's `$scope=` browser fields. After fix: 10/10 pass — first fully clean validation day.

---

## Post-V7 Graduation Criteria

After v7 is built and running for 60 days:

| Level        | Requirement                                                                         | What Changes                                                          |
| ------------ | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Observer** | Paper portfolio exists, signals fire, track record building                         | Jarvis reports signals with evidence                                  |
| **Advisor**  | 55%+ win rate, Sharpe > 0.8, 50+ paper trades                                       | Jarvis proactively suggests paper trades                              |
| **Analyst**  | 60%+ win rate, Sharpe > 1.0, 100+ paper trades, smart money alignment > 60%         | Jarvis sends daily market brief with thesis + track record            |
| **Trusted**  | 6 months of consistent performance, user has acted on signals with positive outcome | Jarvis gets expanded autonomy (auto paper trade without confirmation) |

**No level is skipped. Each must be earned through demonstrated performance, not configured by an engineer.**
