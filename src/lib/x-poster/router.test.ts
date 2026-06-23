import { describe, it, expect } from "vitest";
import { XPostRouter } from "./router.js";
import type { XBackend, ProbeResult, PostResult } from "./types.js";

/** Configurable fake backend for routing tests. */
function fake(
  name: string,
  opts: {
    configured?: boolean;
    probe?: Partial<ProbeResult>;
    post?: Partial<PostResult>;
    calls?: { post: number; probe: number };
  } = {},
): XBackend {
  const calls = opts.calls ?? { post: 0, probe: 0 };
  return {
    name,
    isConfigured: () => opts.configured ?? true,
    async probe() {
      calls.probe++;
      return {
        backend: name,
        ok: false,
        detail: "fake",
        authExpired: false,
        ...opts.probe,
      };
    },
    async post() {
      calls.post++;
      return {
        backend: name,
        ok: false,
        authExpired: false,
        ...opts.post,
      };
    },
  };
}

describe("XPostRouter.post", () => {
  it("returns the first configured backend that succeeds and skips the rest", async () => {
    const apiCalls = { post: 0, probe: 0 };
    const router = new XPostRouter([
      fake("cookie", { post: { ok: true, tweetId: "123" } }),
      fake("api", { calls: apiCalls }),
    ]);
    const res = await router.post("hi");
    expect(res.ok).toBe(true);
    expect(res.backend).toBe("cookie");
    expect(res.tweetId).toBe("123");
    expect(apiCalls.post).toBe(0); // fallback never invoked
  });

  it("falls back to the next backend when the primary fails (non-expiry)", async () => {
    const router = new XPostRouter([
      fake("cookie", { post: { ok: false, error: "500" } }),
      fake("api", { post: { ok: true, tweetId: "999" } }),
    ]);
    const res = await router.post("hi");
    expect(res.ok).toBe(true);
    expect(res.backend).toBe("api");
    expect(res.attempts).toHaveLength(2);
  });

  it("flags allAuthExpired when every backend fails with auth-expiry", async () => {
    const router = new XPostRouter([
      fake("cookie", { post: { ok: false, authExpired: true } }),
      fake("api", { post: { ok: false, authExpired: true } }),
    ]);
    const res = await router.post("hi");
    expect(res.ok).toBe(false);
    expect(res.allAuthExpired).toBe(true);
  });

  it("does NOT flag allAuthExpired when one failure is non-expiry", async () => {
    const router = new XPostRouter([
      fake("cookie", { post: { ok: false, authExpired: true } }),
      fake("api", { post: { ok: false, error: "500", authExpired: false } }),
    ]);
    const res = await router.post("hi");
    expect(res.allAuthExpired).toBe(false);
  });

  it("skips unconfigured backends entirely", async () => {
    const cookieCalls = { post: 0, probe: 0 };
    const router = new XPostRouter([
      fake("cookie", { configured: false, calls: cookieCalls }),
      fake("api", { post: { ok: true, tweetId: "7" } }),
    ]);
    const res = await router.post("hi");
    expect(res.backend).toBe("api");
    expect(cookieCalls.post).toBe(0);
  });

  it("reports unconfigured when no backend is configured", async () => {
    const router = new XPostRouter([fake("cookie", { configured: false })]);
    const res = await router.post("hi");
    expect(res.unconfigured).toBe(true);
    expect(res.ok).toBe(false);
  });
});

describe("XPostRouter.probe", () => {
  it("is healthy when at least one backend probes ok", async () => {
    const router = new XPostRouter([
      fake("cookie", { probe: { ok: false, authExpired: true } }),
      fake("api", { probe: { ok: true } }),
    ]);
    const res = await router.probe();
    expect(res.healthy).toBe(true);
    expect(res.results).toHaveLength(2);
  });

  it("is unhealthy when all configured backends are down", async () => {
    const router = new XPostRouter([fake("cookie", { probe: { ok: false } })]);
    const res = await router.probe();
    expect(res.healthy).toBe(false);
    expect(res.unconfigured).toBe(false);
  });

  it("reports unconfigured when nothing is configured", async () => {
    const router = new XPostRouter([fake("cookie", { configured: false })]);
    const res = await router.probe();
    expect(res.unconfigured).toBe(true);
    expect(res.healthy).toBe(false);
  });
});
