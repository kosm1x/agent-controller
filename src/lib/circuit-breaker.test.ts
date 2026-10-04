import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CircuitBreaker, circuitRegistry } from "./circuit-breaker.js";
import { CB_PROBE_TIMEOUT_MS } from "../config/constants.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("CircuitBreaker", () => {
  it("starts CLOSED and allows requests", () => {
    const cb = new CircuitBreaker("test-svc", {
      failureThreshold: 3,
      windowMs: 10_000,
      cooldownMs: 5_000,
    });
    expect(cb.allowRequest()).toBe(true);
    expect(cb.getStatus().state).toBe("CLOSED");
  });

  it("stays CLOSED below failure threshold", () => {
    const cb = new CircuitBreaker("test-svc", { failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.allowRequest()).toBe(true);
    expect(cb.getStatus().failures).toBe(2);
  });

  it("trips to OPEN at failure threshold", () => {
    const cb = new CircuitBreaker("test-svc", {
      failureThreshold: 3,
      windowMs: 60_000,
      cooldownMs: 5_000,
    });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.allowRequest()).toBe(false);
    expect(cb.getStatus().state).toBe("OPEN");
  });

  it("transitions OPEN → HALF_OPEN after cooldown", () => {
    const cb = new CircuitBreaker("test-svc", {
      failureThreshold: 2,
      cooldownMs: 100,
    });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getStatus().state).toBe("OPEN");

    // Fast-forward past cooldown
    vi.useFakeTimers();
    vi.advanceTimersByTime(150);
    expect(cb.allowRequest()).toBe(true);
    expect(cb.getStatus().state).toBe("HALF_OPEN");
    vi.useRealTimers();
  });

  it("HALF_OPEN → CLOSED on success", () => {
    const cb = new CircuitBreaker("test-svc", {
      failureThreshold: 2,
      cooldownMs: 100,
    });
    cb.recordFailure();
    cb.recordFailure();

    vi.useFakeTimers();
    vi.advanceTimersByTime(150);
    cb.allowRequest(); // transition to HALF_OPEN
    cb.recordSuccess();
    expect(cb.getStatus().state).toBe("CLOSED");
    expect(cb.allowRequest()).toBe(true);
    vi.useRealTimers();
  });

  it("HALF_OPEN → OPEN on probe failure", () => {
    const cb = new CircuitBreaker("test-svc", {
      failureThreshold: 2,
      cooldownMs: 100,
    });
    cb.recordFailure();
    cb.recordFailure();

    vi.useFakeTimers();
    vi.advanceTimersByTime(150);
    cb.allowRequest(); // transition to HALF_OPEN
    cb.recordFailure(); // probe failed
    expect(cb.getStatus().state).toBe("OPEN");
    expect(cb.allowRequest()).toBe(false);
    vi.useRealTimers();
  });

  it("HALF_OPEN blocks second concurrent request", () => {
    const cb = new CircuitBreaker("test-svc", {
      failureThreshold: 2,
      cooldownMs: 100,
    });
    cb.recordFailure();
    cb.recordFailure();

    vi.useFakeTimers();
    vi.advanceTimersByTime(150);
    expect(cb.allowRequest()).toBe(true); // first probe
    expect(cb.allowRequest()).toBe(false); // second blocked
    vi.useRealTimers();
  });

  // A HALF_OPEN probe whose caller never reports (caller abort, local throw)
  // used to freeze the breaker until process restart.
  let probe: number | null = null; // token openThenProbe() was admitted with
  function openThenProbe(probeTimeoutMs?: number): CircuitBreaker {
    vi.useFakeTimers();
    const cb = new CircuitBreaker("test-svc", {
      failureThreshold: 2,
      cooldownMs: 1_000,
      ...(probeTimeoutMs !== undefined && { probeTimeoutMs }),
    });
    cb.recordFailure();
    cb.recordFailure();
    vi.advanceTimersByTime(1_000);
    probe = cb.admit(); // the probe
    expect(probe).toBeGreaterThan(0);
    expect(cb.getStatus().state).toBe("HALF_OPEN");
    return cb;
  }

  it("releaseProbe hands an unjudged probe back: the next caller probes at once", () => {
    const cb = openThenProbe(60_000);
    expect(cb.admit()).toBeNull(); // second caller during the probe
    cb.releaseProbe(probe!);
    expect(cb.getStatus().state).toBe("OPEN");
    // No cooldown restart: granted without advancing the clock.
    expect(cb.allowRequest()).toBe(true);
    expect(cb.getStatus().state).toBe("HALF_OPEN");
    expect(cb.allowRequest()).toBe(false);
  });

  it("releaseProbe is a no-op in CLOSED and OPEN", () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker("test-svc", {
      failureThreshold: 2,
      cooldownMs: 1_000,
    });
    const closed = cb.admit();
    expect(closed).toBe(0); // admitted CLOSED: holds no probe
    cb.recordFailure();
    cb.releaseProbe(closed!);
    expect(cb.getStatus().state).toBe("CLOSED");
    expect(cb.getStatus().failures).toBe(1);

    cb.recordFailure(); // trips OPEN
    const openedAt = cb.getStatus().lastStateChange;
    vi.advanceTimersByTime(500);
    cb.releaseProbe(closed!);
    expect(cb.getStatus().state).toBe("OPEN");
    expect(cb.getStatus().lastStateChange).toBe(openedAt);
    expect(cb.allowRequest()).toBe(false); // still inside its cooldown
    vi.advanceTimersByTime(500);
    expect(cb.allowRequest()).toBe(true);
  });

  // Audit W1: a call admitted CLOSED must not release another call's probe.
  it("releaseProbe from a call admitted CLOSED cannot release a later probe", () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker("test-svc", {
      failureThreshold: 2,
      cooldownMs: 1_000,
    });
    const a = cb.admit(); // call A, admitted CLOSED, still in flight
    expect(a).toBe(0);
    cb.recordFailure();
    cb.recordFailure(); // trips OPEN
    vi.advanceTimersByTime(1_000);
    const b = cb.admit(); // call B holds the probe
    expect(b).toBeGreaterThan(0);
    cb.releaseProbe(a!); // A exits unjudged
    expect(cb.getStatus().state).toBe("HALF_OPEN");
    expect(cb.allowRequest()).toBe(false); // B's probe still the only one
  });

  it("a stale probe token cannot release the probe that replaced it", () => {
    const cb = openThenProbe(10_000);
    const stale = probe!;
    vi.advanceTimersByTime(10_000);
    const fresh = cb.admit(); // expired → new probe
    expect(fresh).toBeGreaterThan(stale);
    cb.releaseProbe(stale);
    expect(cb.getStatus().state).toBe("HALF_OPEN");
    expect(cb.allowRequest()).toBe(false);
    cb.releaseProbe(fresh!);
    expect(cb.getStatus().state).toBe("OPEN");
    expect(cb.allowRequest()).toBe(true);
  });

  it("a probe that never reports expires after probeTimeoutMs: exactly one new probe", () => {
    const cb = openThenProbe(10_000);
    vi.advanceTimersByTime(9_999);
    expect(cb.allowRequest()).toBe(false); // live probe still blocks
    vi.advanceTimersByTime(1);
    expect(cb.allowRequest()).toBe(true); // expired → re-probe
    expect(cb.getStatus().state).toBe("HALF_OPEN");
    expect(cb.allowRequest()).toBe(false); // only one
    vi.advanceTimersByTime(9_999);
    expect(cb.allowRequest()).toBe(false); // the re-probe has its own clock
  });

  it("a failed re-probe goes back to OPEN with a fresh cooldown", () => {
    const cb = openThenProbe(10_000);
    vi.advanceTimersByTime(10_000);
    expect(cb.allowRequest()).toBe(true);
    cb.recordFailure();
    expect(cb.getStatus().state).toBe("OPEN");
    expect(cb.allowRequest()).toBe(false);
    vi.advanceTimersByTime(999);
    expect(cb.allowRequest()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(cb.allowRequest()).toBe(true);
  });

  it("a successful re-probe closes the breaker", () => {
    const cb = openThenProbe(10_000);
    vi.advanceTimersByTime(10_000);
    expect(cb.allowRequest()).toBe(true);
    cb.recordSuccess();
    expect(cb.getStatus().state).toBe("CLOSED");
    expect(cb.allowRequest()).toBe(true);
  });

  it("defaults probeTimeoutMs to CB_PROBE_TIMEOUT_MS, longer than the 15-min SDK hard timeout", () => {
    // claude-sdk.ts SDK_TIMEOUT_MS: a live probe ends (and reports) by then.
    expect(CB_PROBE_TIMEOUT_MS).toBeGreaterThan(15 * 60_000);
    const cb = openThenProbe();
    vi.advanceTimersByTime(CB_PROBE_TIMEOUT_MS - 1);
    expect(cb.allowRequest()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(cb.allowRequest()).toBe(true);
  });

  it("rolling window expires old failures", () => {
    const cb = new CircuitBreaker("test-svc", {
      failureThreshold: 3,
      windowMs: 200,
    });

    vi.useFakeTimers();
    cb.recordFailure();
    cb.recordFailure();
    vi.advanceTimersByTime(250); // old failures expire
    cb.recordFailure(); // only 1 in window now
    expect(cb.getStatus().state).toBe("CLOSED");
    vi.useRealTimers();
  });
});

describe("CircuitBreakerRegistry", () => {
  beforeEach(() => {
    circuitRegistry.reset();
  });

  it("creates breaker on first access", () => {
    const cb = circuitRegistry.get("google");
    expect(cb).toBeDefined();
    expect(cb.getStatus().state).toBe("CLOSED");
  });

  it("returns same instance on subsequent access", () => {
    const cb1 = circuitRegistry.get("google");
    const cb2 = circuitRegistry.get("google");
    expect(cb1).toBe(cb2);
  });

  it("getAllStatus includes all registered breakers", () => {
    circuitRegistry.get("google");
    circuitRegistry.get("wordpress");
    const status = circuitRegistry.getAllStatus();
    expect(Object.keys(status)).toEqual(
      expect.arrayContaining(["google", "wordpress"]),
    );
  });
});
