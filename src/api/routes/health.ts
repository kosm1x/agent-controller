/**
 * Health check endpoint. No authentication required.
 */

import { Hono } from "hono";
import { getDatabase } from "../../db/index.js";
import { getConfig } from "../../config.js";
import { providerMetrics } from "../../inference/adapter.js";
import { getBudgetStatus } from "../../budget/service.js";
import { toolMetrics } from "../../observability/tool-metrics.js";
import { eventMetrics } from "../../observability/event-metrics.js";

const health = new Hono();

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
  try {
    const config = getConfig();
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

  const status = dbOk ? "healthy" : "degraded";
  const code = dbOk ? 200 : 503;

  const providers = providerMetrics.getAllStats();
  const budget = getBudgetStatus();

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
      },
      tools: toolMetrics.getSummary(),
      commitEvents: eventMetrics.getSummary(),
    },
    code,
  );
});

export { health };
