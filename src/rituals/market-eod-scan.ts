/**
 * F9 — Market end-of-day scan ritual.
 *
 * Fires 4:30 PM America/New_York on NYSE trading days. Surfaces: day's close
 * summary, paper P&L delta, next-day setup. On Fridays, appends weekly-
 * rebalance section citing ship_gate status — but does NOT auto-trigger a
 * rebalance. Delivery: final output text is broadcast by
 * `router.watchRitualTask` → `broadcastToAll` to all active channels.
 *
 * Early-close days (13:00 ET): the ritual still fires at 16:30 ET per its
 * cron. `market_history` reflects the half-day's early close via AV's
 * regular bar — no cron shift required for v1. Documented in plan §D-B.
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

5. Call market_history for SPY with lookback=5 to get today's close + %Δ as market context.

6. Call market_signals with lookback=3 to surface any technical firings triggered today.

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

## Final-output format (Spanish, Mexican)

🌆 **Recap de cierre — ${dateLabel}**

**📈 Mercado**: SPY $[close] ([+/-X%] vs ayer)
**💼 Paper**: equity=$[equity] ([+/-X%] hoy)
**📋 Posiciones**: [N] abiertas, [N] stale si aplica

**🗞️ Highlights del día**
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
      "market_history",
      "market_signals",
      "backtest_latest",
      "intel_query",
    ],
    requiredTools: ["market_calendar", "paper_portfolio"],
  };
}
