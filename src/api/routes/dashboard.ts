/**
 * Dashboard serving route (v6.3 DB2)
 *
 * GET /dashboard/:id — serves generated HTML dashboard files.
 * No authentication (dashboards are self-contained, no sensitive data).
 */

import { Hono } from "hono";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const DASHBOARD_DIR = "/tmp/dashboards";

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
  return c.html(html);
});

export default dashboard;
