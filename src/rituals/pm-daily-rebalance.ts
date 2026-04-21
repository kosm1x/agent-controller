/**
 * PM daily rebalance ritual (F8.1c).
 *
 * Fires daily at 06:00 America/New_York (weekends included — prediction
 * markets don't follow the equity calendar). Submitted to the fast runner
 * as a scoped tool-loop:
 *
 *   1) prediction_markets   — refresh Gamma quotes for top-volume universe
 *   2) pm_alpha_run         — compute weights (positive + negative) from
 *                              the freshly-cached markets
 *   3) pm_paper_rebalance   — cadence="daily", writes thesis with
 *                              entry_signal=pm_daily_rebalance
 *
 * The ritual is a single task submission; the LLM runs the three tools in
 * order. Final text lands in the router via broadcastToAll (per F9 pattern).
 */

import type { TaskSubmission } from "../dispatch/dispatcher.js";

export function createPmDailyRebalance(dateLabel: string): TaskSubmission {
  return {
    title: `PM daily rebalance — ${dateLabel}`,
    description: `You are Jarvis. Execute the Polymarket daily rebalance ritual. The equity pipeline is weekly; Polymarket is faster-moving and rebalances every day.

## Sequence (run in this order, one at a time)

1. Call \`prediction_markets\` with \`limit=100\`. Each invocation fetches fresh Gamma API data and upserts \`prediction_markets.outcome_tokens\` + \`fetched_at\` for active markets — this is the "refresh" step. Do NOT pass any other params; a bare \`limit=100\` covers the top active slice.
2. Call \`pm_alpha_run\` to recompute per-token signed Kelly weights from the freshly-cached markets.
3. Call \`pm_paper_rebalance\` with \`cadence="daily"\`. This uses a 24h staleness gate (vs 5d weekly) and tags the thesis \`entry_signal=pm_daily_rebalance\`.

## Reporting format (Spanish)

**PM diario — ${dateLabel}**

Universo: N mercados | Pesos: +X largos, −Y cortos-via-NO | Rechazos: Z
Equity: $before → $after  |  Cash: $before → $after  |  Órdenes: planned/filled/rejected
Top fills: (symbol qty @ price, max 5)
Alertas: (stale markets, rejects razones, si hubiera)

If any step errors, stop and surface the error verbatim — do NOT fabricate fills. If step 1 returns no new data, still run step 2 + 3 with what's cached.

## Guardrails

- Do NOT call equity tools (paper_rebalance, market_quote, etc.) — this ritual is PM-only.
- Do NOT set \`allow_stale=true\` on pm_paper_rebalance — if stale positions are present, let the abort fire and report them honestly.
- Do NOT re-invoke tools after they fail — surface the error and stop.`,
    agentType: "fast",
    tools: ["prediction_markets", "pm_alpha_run", "pm_paper_rebalance"],
    requiredTools: ["pm_paper_rebalance"],
  };
}
