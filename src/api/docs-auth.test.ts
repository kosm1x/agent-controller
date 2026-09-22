import { describe, it, expect } from "vitest";
import { createApp } from "./index.js";

// audit 2026-09-22: /docs/raw served CLAUDE.md to any internet peer.
const peer = (remoteAddress: string) => ({
  incoming: { socket: { remoteAddress } },
});

describe("/docs auth gate", () => {
  const app = createApp();

  it("rejects a public peer without an API key", async () => {
    for (const path of ["/docs/raw/CLAUDE.md", "/docs/llms.txt", "/docs/"]) {
      const res = await app.request(path, {}, peer("203.0.113.7"));
      expect(res.status, path).toBe(401);
    }
  });

  it("serves a loopback peer keyless, without shared caching", async () => {
    const res = await app.request("/docs/raw/CLAUDE.md", {}, peer("127.0.0.1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/^private\b/);
  });
});
