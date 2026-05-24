/**
 * Health check endpoint. No authentication required.
 */

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { getDatabase } from "../../db/index.js";
import { getConfig } from "../../config.js";
import { providerMetrics } from "../../inference/adapter.js";
import { circuitRegistry } from "../../lib/circuit-breaker.js";
import { getThreeWindowStatus } from "../../budget/service.js";
import { getBudgetStatus } from "../../budget/service.js";
import { toolMetrics } from "../../observability/tool-metrics.js";
import { eventMetrics } from "../../observability/event-metrics.js";
import { getKbHealthStats } from "../../memory/lesson-decay.js";
import { getMessagingStatus } from "../../messaging/index.js";

const health = new Hono();

/**
 * Under the claude-sdk provider, `inferencePrimaryUrl` is stale (the SDK
 * auths via ~/.claude/.credentials.json and picks its own endpoint), so the
 * legacy openai-style fetch probe always returns null and /health reports
 * `inference: unreachable` even while Sonnet is happily serving traffic.
 * The strongest non-billable readiness signal for SDK mode is the existence
 * of a non-empty credentials file — the SDK subprocess would fail to spawn
 * without it. We avoid actually hitting Anthropic's API to keep /health
 * free, fast, and not dependent on third-party reachability.
 */
function sdkCredentialsReady(): boolean {
  try {
    const path = join(homedir(), ".claude", ".credentials.json");
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}

health.get("/health", async (c) => {
  let dbOk = false;
  try {
    const db = getDatabase();
    const row = db.prepare("SELECT 1 as ok").get() as
      | { ok: number }
      | undefined;
    dbOk = row?.ok === 1;
  } catch {
    // DB not available
  }

  let inferenceOk = false;
  const config = getConfig();
  if (config.inferencePrimaryProvider === "claude-sdk") {
    inferenceOk = sdkCredentialsReady();
  } else {
    try {
      const baseUrl = config.inferencePrimaryUrl.replace(/\/v1\/?$/, "");
      // Try /health first, fall back to /v1/models (DashScope has no /health)
      const healthRes = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      }).catch(() => null);
      if (healthRes?.ok) {
        inferenceOk = true;
      } else {
        const modelsRes = await fetch(
          `${config.inferencePrimaryUrl.replace(/\/+$/, "")}/models`,
          {
            headers: { Authorization: `Bearer ${config.inferencePrimaryKey}` },
            signal: AbortSignal.timeout(3000),
          },
        ).catch(() => null);
        inferenceOk = modelsRes !== null && modelsRes.status < 500;
      }
    } catch {
      // Inference provider unreachable
    }
  }

  const status = dbOk ? "healthy" : "degraded";
  const code = dbOk ? 200 : 503;

  const providers = providerMetrics.getAllStats();
  const budget = getBudgetStatus();
  const budgetCfg = getConfig();
  const kbStats = await getKbHealthStats().catch(() => null);

  return c.json(
    {
      status,
      timestamp: new Date().toISOString(),
      version: "0.1.0",
      db: dbOk ? "ok" : "error",
      inference: inferenceOk ? "ok" : "unreachable",
      providers,
      budget: {
        dailySpend: +budget.dailySpend.toFixed(4),
        dailyLimit: budget.dailyLimit,
        remaining: +budget.remaining.toFixed(4),
        threeWindow: getThreeWindowStatus(),
        // P6 (2026-05-24): expose the gate mode so operators can tell at a
        // glance whether breaches will block or only warn. `enforce` is
        // normalized to the effective value — `BUDGET_ENFORCE=true` with
        // `BUDGET_ENABLED=false` reports `enforce: false` since the gate
        // can't actually fire, matching the `mode: "disabled"` semantic.
        enabled: budgetCfg.budgetEnabled,
        enforce: budgetCfg.budgetEnabled && budgetCfg.budgetEnforce,
        mode: budgetCfg.budgetEnabled
          ? budgetCfg.budgetEnforce
            ? "enforce"
            : "soft-cap"
          : "disabled",
      },
      tools: toolMetrics.getSummary(),
      commitEvents: eventMetrics.getSummary(),
      circuitBreakers: circuitRegistry.getAllStatus(),
      messaging: getMessagingStatus(),
      ...(kbStats && { knowledgeBase: kbStats }),
    },
    code,
  );
});

export { health };
