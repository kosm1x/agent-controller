/**
 * The MCP router had zero test coverage (qa C1 2026-09-10): reordering the
 * per-token rate limiter in front of mcpAuth() turned every request into a
 * 500 ("rate_limit_missing_auth_context") and the green suite said nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDatabase, closeDatabase, getDatabase } from "../../db/index.js";
import { createMcpRouter } from "./index.js";
import type { McpDeps } from "./types.js";

beforeEach(() => {
  initDatabase(":memory:");
});
afterEach(() => closeDatabase());

function router() {
  const deps = {
    db: getDatabase(),
    memory: {} as McpDeps["memory"],
    startedAt: Date.now(),
  } as McpDeps;
  return createMcpRouter(deps);
}

describe("createMcpRouter middleware order", () => {
  it("an unauthenticated request is refused with 401, never 500", async () => {
    const r = await router().request("http://x/health");
    expect(r.status).toBe(401);
  });

  it("an unauthenticated flood hits the IP-keyed limiter (429), so auth lookups are metered", async () => {
    const app = router();
    let last = 0;
    for (let i = 0; i < 130; i++) {
      last = (await app.request("http://x/health")).status;
    }
    expect(last).toBe(429);
  });
});
