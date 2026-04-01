import { describe, it, expect, beforeEach, vi } from "vitest";
import { CircuitBreaker, circuitRegistry } from "./circuit-breaker.js";

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
