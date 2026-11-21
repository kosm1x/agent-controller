/**
 * F9 — Market end-of-day scan ritual.
 *
 * Fires 4:30 PM America/New_York on NYSE trading days. Surfaces: day's close
 * summary, paper equity marked at the latest weekly close, next-day setup.
 * On Fridays, appends weekly-
 * rebalance section citing ship_gate status — but does NOT auto-trigger a
 * rebalance. Delivery: final output text is broadcast by
 * `router.watchRitualTask` → `broadcastToAll` to all active channels.
 *
 * Early-close days (13:00 ET): the ritual still fires at 16:30 ET per its
 * cron; v1 has no cron shift (plan §D-B proposed 13:30). Today's close comes
 * from `market_quote`, whose trading-day date the prompt checks.
 */

import type { TaskSubmission } from "../dispatch/dispatcher.js";

export function createMarketEodScan(dateLabel: string): TaskSubmission {
  return {
    title: `Market EOD scan — ${dateLabel}`,
    description: `You are Jarvis, Fede's market-intelligence ritual. Execute the end-of-day market scan.

## Instructions

1. Call market_calendar with today's date. If trading=false, your FINAL OUTPUT (broadcast automatically) must be exactly: "Mercados cerrados hoy. Sin recap." Then stop — do not call any other tools.

2. Call alert_budget_status (ritual_id=market-eod-scan). If exhausted=true, your FINAL OUTPUT must be exactly: "⚠️ Budget de alertas agotado. Recap degradado." Then stop.

3. Call paper_portfolio to get current positions + total equity.

4. Call paper_history with since=${dateLabel} to get today's fills (usually empty — rebalances are manual + weekly).

5. Call market_quote with symbol=SPY to get today's close as market context. Make this call on its own and wait for its reply before you call market_history or market_signals: market_signals can fall back to the same Alpha Vantage source and fill its per-minute limit, and a quote made after that is refused. The quote's trading day is the date inside its "(OHLC <YYYY-MM-DD>: …)" part; check that it is ${dateLabel}. When the line carries a "change" part, that is the day's %Δ against the "prev close" the line gives: use it as is, compute nothing, and do not call market_history. Only when the line has no "change" part, call market_history for SPY with lookback=5 and compute %Δ = the market_quote close against the close of the row dated prev_trading from the step 1 market_calendar reply; at this hour the history normally has no ${dateLabel} row yet, which is not a gap. If the prev_trading row is missing, if the market_history reply is marked "STALE (providers unreachable)", or if market_history fails, write the date of the prior close you used (or that you have none) in the Mercado line and report the old or missing prior close as a concern. If market_quote fails (an {"error": …} reply), call market_history for SPY with lookback=5 and write its latest close, with its date, in the Mercado line. If the quote's date is not ${dateLabel}, write that quote's close with its date in the Mercado line; its "change" belongs to that date, not to ${dateLabel}. In both cases today's close is missing: report the missing close for ${dateLabel} as a concern.

6. Call market_signals with lookback=3 to surface any technical firings triggered today. Each firing line starts with the date of the bar it fired on: call a firing today's only if that date is ${dateLabel}, and give the date of any other firing you report. The reply's second line, "Newest bar: <SYM> <DATE>, …", gives the newest bar each symbol's signals are computed on; judge age by that DATE alone, not by the "(fallback)" marker, since a symbol without it can still be old. A newest bar dated ${dateLabel} or prev_trading is the normal state at this hour, not a concern. In the Highlights heading write the date the signals are computed through and, after it, each symbol whose newest bar is older than prev_trading or shows "none", with its date or "none"; when no symbol is behind, add nothing. Report as a concern every symbol whose newest bar is older than prev_trading or shows "none", naming each symbol and its date, or that it has none. If the reply has no "Newest bar:" line, say so and report it as a concern.

7. Call intel_query with hours=6 to pick up the afternoon's macro/news events.

8. **If today is Friday**: call backtest_latest with strategy=flam. Append a "💼 Fin de semana — rebalanceo" section that:
   - If ship_blocked=0: "Ship-gate OK. Operador puede ejecutar paper_rebalance para rotación semanal."
   - If ship_blocked=1: "Ship-gate bloqueado — PBO=[X] DSR_p=[X]. Rebalanceo en espera."
   - Do NOT call paper_rebalance.

9. Compose EOD recap in Spanish (Mexican tone) using the format below and emit it as your final output. The messaging router broadcasts it to Telegram automatically on task completion.

IMPORTANT:
- There is NO \`telegram_send\` tool. Your final text output IS the Telegram message — the messaging router broadcasts it on task completion.
- Do NOT call paper_rebalance — this ritual is read-only intelligence.
- Empty fills today is the norm under weekly-only cadence; do not treat it as an anomaly.
- paper_portfolio marks positions at the latest weekly close by design, so there is no daily equity change to report.

## Final-output format (Spanish, Mexican)

🌆 **Recap de cierre — ${dateLabel}**

**📈 Mercado**: SPY $[close] ([+/-X%] vs ayer) · cierre del [fecha] si no es de hoy
**💼 Paper**: equity=$[equity] (marcado al último cierre semanal)
**📋 Posiciones**: [N] abiertas, [N] stale si aplica

**🗞️ Highlights del día** (señales con cierres hasta [fecha]; atrasados: [símbolo fecha, …] si aplica)
- [top 3 signal firings or macro events]

**🎯 Setup para mañana**
- [1-2 forward-looking items — observational]

## (FRIDAY ONLY) Append:

**💼 Fin de semana — rebalanceo**
- Ship-gate: [OK | BLOCKED]
- [PBO / DSR_p detail if blocked]
- [action hint]`,
    agentType: "fast",
    tools: [
      "market_calendar",
      "alert_budget_status",
      "paper_portfolio",
      "paper_history",
      "market_quote",
      "market_history",
      "market_signals",
      "backtest_latest",
      "intel_query",
    ],
    requiredTools: ["market_calendar", "paper_portfolio"],
  };
}
