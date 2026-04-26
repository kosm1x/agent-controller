/**
 * F9 — Market morning scan ritual.
 *
 * Fires 8:00 AM America/New_York on NYSE trading days (weekdays, non-holiday).
 * Surfaces pre-market intelligence: macro regime, alpha weights, ship_gate
 * status, paper portfolio mark-to-market, overnight signals. Read-only — does
 * NOT call paper_rebalance (per plan §D-A).
 *
 * Delivery: the task's final output text is broadcast to all active channels
 * (Telegram / WhatsApp / etc.) by `router.watchRitualTask` →
 * `broadcastToAll` — there is no `telegram_send` tool. The email copy is
 * sent explicitly via `gmail_send` inside the ritual.
 *
 * Budget: 10k tokens default (see DEFAULT_LIMITS in alert-budget.ts). When
 * exhausted, the ritual degrades to a headline-only summary.
 */

import type { TaskSubmission } from "../dispatch/dispatcher.js";

export function createMarketMorningScan(dateLabel: string): TaskSubmission {
  return {
    title: `Market morning scan — ${dateLabel}`,
    description: `You are Jarvis, Fede's market-intelligence ritual. Execute the morning market scan.

## Instructions

1. Call market_calendar with today's date. If trading=false, your FINAL OUTPUT (which is broadcast automatically) must be exactly: "Mercados cerrados hoy ([reason]). Nos vemos [next_trading]." Substitute the bracketed tokens with the values you got from market_calendar. Then stop — do not call any other tools.

2. Call alert_budget_status (ritual_id=market-morning-scan). If exhausted=true, your FINAL OUTPUT must be exactly: "⚠️ Budget de alertas agotado hoy. Ritual degradado." Then stop.

3. Call macro_regime to get the current regime label + confidence.

4. Call alpha_latest to get the F7 signal weights (top 5 by |weight|) and N_effective.

5. Call backtest_latest with strategy=flam to get PBO, DSR_pvalue, ship_blocked status.

6. Call paper_portfolio to get current positions + cash + total_equity + unrealized P&L. Note any position marked stale.

7. Call intel_query with hours=14 to fetch overnight signals + macro events since yesterday's close.

8. Call market_signals with lookback=5 to check fresh technical firings across the watchlist.

9. Compose the morning message in Spanish (Mexican tone) using the format below and emit it as your final output (the messaging router broadcasts it to Telegram automatically). Also send an email copy via gmail_send to fede@eurekamd.net with subject "Escaneo pre-mercado — ${dateLabel}" and the same body.

IMPORTANT:
- There is NO \`telegram_send\` tool. Your final text output IS the Telegram message — the messaging router broadcasts it on task completion.
- Do NOT call paper_rebalance — this ritual is read-only intelligence.
- If ship_blocked=1, mention it prominently; do NOT hide the firewall.
- Flag any stale positions in the portfolio so the operator can refresh prices.

## Final-output format (Spanish, Mexican)

📊 **Escaneo pre-mercado — ${dateLabel}**

**🌡️ Régimen macro**: [regime label] (confianza [X])

**⚖️ Alpha más reciente**: N=[N], N_efectivo=[NE], run_id=[first 8 chars]
- Top pesos: [sym1] [w1], [sym2] [w2], [sym3] [w3]

**🛡️ Firewall (F7.5)**: [ship_ok | ⚠️ SHIP_BLOCKED]
  PBO=[X] / DSR_p=[X]  ← if blocked, enumerate reasons

**💼 Portafolio paper**: equity=$[equity]  cash=$[cash]  positions=[N]
- [sym] [shares] sh @ $[price]  unr=[+/-X%]  [stale?]
- ...

**🗞️ Señales y macro (noche)**
- [top 3 signal firings or macro events]

**🎯 Enfoque del día**:
- [1-2 items derived from the above — observational, NOT trade commands]`,
    agentType: "fast",
    tools: [
      "market_calendar",
      "alert_budget_status",
      "macro_regime",
      "alpha_latest",
      "backtest_latest",
      "paper_portfolio",
      "market_signals",
      "intel_query",
      "gmail_send",
    ],
    requiredTools: ["market_calendar", "paper_portfolio"],
  };
}
