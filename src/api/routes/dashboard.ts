/**
 * Dashboard serving route (v6.3 DB2)
 *
 * GET /dashboard/:id — serves generated HTML dashboard files.
 * No authentication (dashboards are self-contained, no sensitive data).
 * Served under a CSP sandbox: the page runs in an opaque origin, so
 * LLM-authored content cannot reach the API origin (audit 2026-09-22).
 */

import { Hono } from "hono";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const DASHBOARD_DIR = "/tmp/dashboards";

export const DASHBOARD_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline'; img-src data:";

const dashboard = new Hono();

dashboard.get("/:id", (c) => {
  const id = c.req.param("id");

  // C1 audit fix: reject path traversal (../, /, \)
  if (/[\/\\]|\.\./.test(id)) {
    return c.text("Invalid dashboard ID", 400);
  }

  const filePath = resolve(DASHBOARD_DIR, `${id}.html`);

  // Defense-in-depth: verify resolved path stays inside DASHBOARD_DIR
  if (!filePath.startsWith(DASHBOARD_DIR + "/")) {
    return c.text("Invalid dashboard ID", 400);
  }

  if (!existsSync(filePath)) {
    return c.text("Dashboard not found", 404);
  }

  const html = readFileSync(filePath, "utf-8");
  return c.html(html, 200, { "Content-Security-Policy": DASHBOARD_CSP });
});

export default dashboard;
