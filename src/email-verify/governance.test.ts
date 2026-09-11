import { describe, it, expect } from "vitest";
import { Governor, governanceFromEnv, DEFAULT_GOVERNANCE } from "./governance.js";

function clock(start = Date.UTC(2026, 8, 11, 18, 0, 0)) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("Governor", () => {
  it("charges the daily cap per CONNECTION and rolls over at Mexico City midnight", () => {
    const c = clock();
    const g = new Governor({ ...DEFAULT_GOVERNANCE, dailyCap: 2 }, c.now, async () => {});
    expect(g.chargeConnection()).toBe(true);
    expect(g.chargeConnection()).toBe(true);
    expect(g.chargeConnection()).toBe(false);
    expect(g.remainingToday()).toBe(0);
    expect(g.usage().usedToday).toBe(2);
    c.advance(24 * 60 * 60_000);
    expect(g.remainingToday()).toBe(2);
    expect(g.chargeConnection()).toBe(true);
  });

  it("limits concurrency and releases waiters in order", async () => {
    const g = new Governor({ ...DEFAULT_GOVERNANCE, concurrency: 1, dailyCap: 10 });
    const r1 = await g.acquire();
    let second = false;
    const p = g.acquire().then((r) => {
      second = true;
      r();
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(second).toBe(false);
    r1();
    await p;
    expect(second).toBe(true);
  });

  it("paces connections to the same host and staggers concurrent callers", async () => {
    const c = clock();
    const slept: number[] = [];
    const g = new Governor({ ...DEFAULT_GOVERNANCE, hostGapMs: 1000 }, c.now, async (ms) => {
      slept.push(ms);
    });
    // Three callers arrive at the same instant: slots at t, t+1000, t+2000.
    await Promise.all([g.paceHost("mx.a.com"), g.paceHost("mx.a.com"), g.paceHost("mx.a.com")]);
    expect(slept).toEqual([1000, 2000]);
    slept.length = 0;
    await g.paceHost("mx.b.com"); // other host: no wait
    expect(slept).toEqual([]);
  });

  it("opens the breaker after N strikes in the window and closes it again after the cooldown", () => {
    const c = clock();
    const g = new Governor(
      { ...DEFAULT_GOVERNANCE, breakerThreshold: 2, breakerWindowMs: 10_000, breakerCooldownMs: 60_000 },
      c.now,
      async () => {},
    );
    g.recordBlocked();
    c.advance(11_000); // first strike ages out of the window
    g.recordBlocked();
    expect(g.breakerOpen()).toBe(false);
    g.recordBlocked();
    expect(g.breakerOpen()).toBe(true);
    expect(g.usage().breakerOpen).toBe(true);
    c.advance(60_001);
    expect(g.breakerOpen()).toBe(false); // no half-open latch: probing simply resumes
    expect(g.usage().breakerOpen).toBe(false);
  });

  it("reads env overrides with sane fallbacks", () => {
    process.env.EMAIL_VERIFY_DAILY_CAP = "42";
    process.env.EMAIL_VERIFY_CONCURRENCY = "0";
    process.env.EMAIL_VERIFY_HOST_GAP_MS = "abc";
    try {
      const cfg = governanceFromEnv();
      expect(cfg.dailyCap).toBe(42);
      expect(cfg.concurrency).toBe(1);
      expect(cfg.hostGapMs).toBe(DEFAULT_GOVERNANCE.hostGapMs);
    } finally {
      delete process.env.EMAIL_VERIFY_DAILY_CAP;
      delete process.env.EMAIL_VERIFY_CONCURRENCY;
      delete process.env.EMAIL_VERIFY_HOST_GAP_MS;
    }
  });
});
