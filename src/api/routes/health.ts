/**
 * Health check endpoint. No authentication required.
 */

import { Hono } from "hono";
import { getDatabase } from "../../db/index.js";
import { getConfig } from "../../config.js";

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
    const healthUrl =
      config.inferencePrimaryUrl.replace(/\/v1\/?$/, "") + "/health";
    const res = await fetch(healthUrl, {
      signal: AbortSignal.timeout(3000),
    });
    inferenceOk = res.ok;
  } catch {
    // Inference provider unreachable
  }

  const status = dbOk ? "healthy" : "degraded";
  const code = dbOk ? 200 : 503;

  return c.json(
    {
      status,
      timestamp: new Date().toISOString(),
      version: "0.1.0",
      db: dbOk ? "ok" : "error",
      inference: inferenceOk ? "ok" : "unreachable",
    },
    code,
  );
});

export { health };
