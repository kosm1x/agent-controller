/**
 * Tests for the MCP rate limiter middleware.
 */

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { mcpRateLimit } from "./rate-limit.js";

function makeApp(maxPerWindow: number, windowMs: number) {
  const app = new Hono();
  app.use("/*", async (c, next) => {
    // Stub mcpToken so the limiter has a token id to key on.
    c.set("mcpToken", {
      id: 42,
      clientName: "test",
      scope: "read_only" as const,
    });
    await next();
  });
  app.use("/*", mcpRateLimit({ windowMs, maxPerWindow }));
  app.get("/probe", (c) => c.json({ ok: true }));
  return app;
}

describe("mcpRateLimit", () => {
  it("allows requests under the limit", async () => {
    const app = makeApp(3, 60_000);
    for (let i = 0; i < 3; i++) {
      const res = await app.request("/probe");
      expect(res.status).toBe(200);
    }
  });

  it("returns 429 when the window is exhausted", async () => {
    const app = makeApp(2, 60_000);
    await app.request("/probe");
    await app.request("/probe");
    const res = await app.request("/probe");
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("rate_limit_exceeded");
    expect(body.maxPerWindow).toBe(2);
  });

  it("includes a Retry-After header on 429", async () => {
    const app = makeApp(1, 60_000);
    await app.request("/probe");
    const res = await app.request("/probe");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).not.toBeNull();
  });

  it("isolates buckets per token id", async () => {
    const app = new Hono();
    let toggleId = 0;
    app.use("/*", async (c, next) => {
      toggleId = toggleId === 0 ? 100 : 101;
      c.set("mcpToken", {
        id: toggleId,
        clientName: "t",
        scope: "read_only" as const,
      });
      await next();
    });
    app.use("/*", mcpRateLimit({ windowMs: 60_000, maxPerWindow: 1 }));
    app.get("/probe", (c) => c.json({ ok: true }));

    // First request → id=100 (ok)
    const r1 = await app.request("/probe");
    expect(r1.status).toBe(200);
    // Second request → id=101 (ok, different bucket)
    const r2 = await app.request("/probe");
    expect(r2.status).toBe(200);
  });
});
