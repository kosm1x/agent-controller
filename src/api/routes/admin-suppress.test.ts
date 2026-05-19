/**
 * v7.7 Spine 2 Bundle 3 — POST /api/admin/alerts/:id/suppress route tests.
 *
 * Separate file from `admin.test.ts` because the suppress route exercises
 * `suppressAlert` → `getDatabase()` end-to-end; the sibling admin.test.ts
 * mocks `getDatabase` globally for that file (vi.mock at module load), so
 * mixing real-DB tests in there would conflict with the mocks.
 *
 * Uses initDatabase(":memory:") + closeDatabase() per test.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { admin } from "./admin.js";
import { initDatabase, closeDatabase, getDatabase } from "../../db/index.js";

beforeEach(() => initDatabase(":memory:"));
afterEach(() => closeDatabase());

function createTestApp(): Hono {
  const app = new Hono();
  app.route("/admin", admin);
  return app;
}

function seedAlert(): number {
  const sigR = getDatabase()
    .prepare(
      `INSERT INTO drift_signals
         (signal_name, signal_kind, source_substrate, baseline_query,
          baseline_value_json, tolerance_json, cadence, alert_priority,
          established_at, established_by)
       VALUES ('t_sig', 'test', 'S1', 'SELECT 1', '{}', '{}',
               'nightly', 'P1', '2026-05-19', 'test')`,
    )
    .run();
  const sigId = Number(sigR.lastInsertRowid);
  const r = getDatabase()
    .prepare(
      `INSERT INTO drift_alerts
         (signal_id, triggered_at, observed_value_json, baseline_value_json,
          deviation_kind, severity, delivery_status)
       VALUES (?, datetime('now'), '{"value":1}', '{}', 'above', 'P1', 'pending')`,
    )
    .run(sigId);
  return Number(r.lastInsertRowid);
}

async function suppressReq(
  app: Hono,
  id: string | number,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.request(`/admin/alerts/${id}/suppress`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

describe("POST /admin/alerts/:id/suppress", () => {
  it("200 + suppresses with operator_acknowledged on valid body", async () => {
    const app = createTestApp();
    const alertId = seedAlert();
    const { status, json } = await suppressReq(app, alertId, {
      reason: "looked at it, expected",
    });
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.alert_id).toBe(alertId);
    expect(json.resolution_kind).toBe("operator_acknowledged");
    expect(typeof json.resolved_at).toBe("string");
  });

  it("200 + false_positive when reason starts with 'false positive: '", async () => {
    const app = createTestApp();
    const alertId = seedAlert();
    const { status, json } = await suppressReq(app, alertId, {
      reason: "false positive: baseline outdated",
    });
    expect(status).toBe(200);
    expect(json.resolution_kind).toBe("false_positive");
  });

  it("400 on missing reason", async () => {
    const app = createTestApp();
    const alertId = seedAlert();
    const { status, json } = await suppressReq(app, alertId, {});
    expect(status).toBe(400);
    expect(json.error).toContain("reason");
  });

  it("400 on empty-string reason", async () => {
    const app = createTestApp();
    const alertId = seedAlert();
    const { status } = await suppressReq(app, alertId, { reason: "" });
    expect(status).toBe(400);
  });

  it("400 on whitespace-only reason", async () => {
    const app = createTestApp();
    const alertId = seedAlert();
    const { status } = await suppressReq(app, alertId, { reason: "   " });
    expect(status).toBe(400);
  });

  it("400 on invalid until ISO datetime", async () => {
    const app = createTestApp();
    const alertId = seedAlert();
    const { status, json } = await suppressReq(app, alertId, {
      reason: "ack",
      until: "not-a-date",
    });
    expect(status).toBe(400);
    expect(json.error).toMatch(/until/i);
  });

  it("400 on invalid JSON body", async () => {
    const app = createTestApp();
    const alertId = seedAlert();
    const { status, json } = await suppressReq(app, alertId, "{ not json");
    expect(status).toBe(400);
    expect(json.error).toContain("JSON");
  });

  it("400 on non-integer alert id in URL", async () => {
    const app = createTestApp();
    const { status } = await suppressReq(app, "notanumber", { reason: "x" });
    expect(status).toBe(400);
  });

  it("404 when alert id does not exist", async () => {
    const app = createTestApp();
    const { status, json } = await suppressReq(app, 99999, { reason: "ack" });
    expect(status).toBe(404);
    expect(json.error).toMatch(/not found/i);
  });

  it("409 when alert is already resolved", async () => {
    const app = createTestApp();
    const alertId = seedAlert();
    await suppressReq(app, alertId, { reason: "first" });
    const { status, json } = await suppressReq(app, alertId, {
      reason: "second",
    });
    expect(status).toBe(409);
    expect(json.error).toMatch(/already resolved/i);
  });

  it("custom acknowledged_by is honored", async () => {
    const app = createTestApp();
    const alertId = seedAlert();
    await suppressReq(app, alertId, {
      reason: "ack",
      acknowledged_by: "fede",
    });
    const row = getDatabase()
      .prepare("SELECT acknowledged_by FROM drift_alerts WHERE id = ?")
      .get(alertId) as { acknowledged_by: string };
    expect(row.acknowledged_by).toBe("fede");
  });
});
