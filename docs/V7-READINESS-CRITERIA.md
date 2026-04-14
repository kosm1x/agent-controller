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
- [ ] **MCP browser tool URL validation gap closed** — see Known Issues below

**If all boxes are checked: start v7 F1.**
**If any box fails: fix that specific item first, extend validation period.**

---

## Known Issues — must close before v7.0

### URL safety gap on MCP browser tools (discovered 2026-04-14, day 5 of validation)

**The gap.** Jarvis's `validateOutboundUrl()` (`src/lib/url-safety.ts`) blocks `file://`, private IPs, metadata endpoints, non-HTTP schemes — but only when called from **builtin tools** that opt in. Currently those are: `web_read`, `seo_page_audit`, `http`. The Playwright MCP browser tools (`browser__markdown`, `browser__navigate`, `browser__screenshot`, etc.) come from `@playwright/mcp` and bypass this validation entirely. They reach Playwright's `page.goto()` directly. The builtin `screenshot_element` tool also lacks the validation call.

**What saved us this time.** Playwright's protocol allowlist rejects `file://` with `UnsupportedProtocol`. Day 5 of validation surfaced 4 such errors — turned out to be a scheduled task (PipeSong tech radar) where the LLM tried `file:///root/claude/mission-control/.env` and `file:///root/claude/mission-control/src/tools/builtin/` via the MCP browser. Playwright blocked both. No exfiltration. The validation script's regex was matching these as "scope classifier errors" — false positive, fixed in `mc-ctl` cmd_validation regex tightening (same session).

**What is NOT blocked.** SSRF targets that look like normal HTTP URLs:

- `http://localhost:3000/`, `http://localhost:9090/`, `http://localhost:3001/` (Grafana, Prometheus, MC API on the same host)
- `http://10.0.0.0/8`, `http://192.168.0.0/16`, `http://172.16.0.0/12` (private IP ranges)
- `http://[::1]/` and IPv6 link-local

**Why it matters for v7.0.** Pillar 6 is non-negotiable. An LLM that can hit `http://localhost:3000/api/datasources/` (Grafana) via the MCP browser can leak credentials and dashboard metadata. Once Jarvis manages real money signals via paper trading, this becomes a financial-data exposure path.

**Fix options** (decide in v7.6 or earlier):

1. **MCP source wrapper.** Wrap `@playwright/mcp` tools in a `ToolSource` adapter that calls `validateOutboundUrl()` before forwarding the call. Works for any URL-bearing param. Requires identifying which MCP tools accept URLs. Also fix `screenshot_element` builtin to call `validateOutboundUrl()`.
2. **Network-layer block.** iptables/nftables OUTPUT rule: drop traffic from the Playwright Chromium process to RFC1918 + loopback + link-local. Defense at OS layer, no code change. Requires identifying the Chromium process by launch path or cgroup.
3. **Both.** Belt + suspenders. Layer 1 catches user-input URL strings before the call; Layer 3 catches Chromium-internal redirects, JS-initiated fetches, and any tool we miss.

**Recommended:** ship Option 1 in v7.6 (Workspace Expansion session) since it touches the same MCP wrapping pattern. Option 2 as a follow-up if the audit shows additional gaps.

**Validation script gap.** The Pillar 1 scope-classifier check (`mc-ctl validation check` item 8) was false-positiving on these Playwright errors and reporting 4 "scope classifier errors". Regex tightened to require `[router]` / `[classifier]` / `[messaging]` log prefix and exclude pino's `$scope=` browser fields. After fix: 10/10 pass. A future Pillar 6 validation item should scan for `UnsupportedProtocol` errors with internal/loopback IP targets to surface real SSRF attempts proactively.

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
