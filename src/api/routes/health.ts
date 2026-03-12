/**
 * Health check endpoint. No authentication required.
 */

import { Hono } from "hono";
import { getDatabase } from "../../db/index.js";

const health = new Hono();

health.get("/health", (c) => {
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

  const status = dbOk ? "healthy" : "degraded";
  const code = dbOk ? 200 : 503;

  return c.json(
    {
      status,
      timestamp: new Date().toISOString(),
      version: "0.1.0",
      db: dbOk ? "ok" : "error",
    },
    code,
  );
});

export { health };
