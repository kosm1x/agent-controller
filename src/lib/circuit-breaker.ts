/**
 * Circuit breaker registry — prevents cascading failures across tasks.
 *
 * Each external service gets a breaker with CLOSED/OPEN/HALF_OPEN states.
 * Shared singleton so one task discovering a broken provider protects all
 * other tasks from burning rounds on it.
 */

import {
  CB_FAILURE_THRESHOLD,
  CB_WINDOW_MS,
  CB_COOLDOWN_MS,
  CB_PROBE_TIMEOUT_MS,
} from "../config/constants.js";

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerStatus {
  state: CircuitState;
  failures: number;
  lastFailure: number | null;
  lastStateChange: number;
}

export class CircuitBreaker {
  readonly name: string;
  private state: CircuitState = "CLOSED";
  private failures: number[] = []; // timestamps within window
  private lastStateChange = Date.now();
  private probe = 0; // token of the current HALF_OPEN probe; bumped per grant
  private readonly failureThreshold: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;
  private readonly probeTimeoutMs: number;

  constructor(
    name: string,
    options?: {
      failureThreshold?: number;
      windowMs?: number;
      cooldownMs?: number;
      probeTimeoutMs?: number;
    },
  ) {
    this.name = name;
    this.failureThreshold = options?.failureThreshold ?? CB_FAILURE_THRESHOLD;
    this.windowMs = options?.windowMs ?? CB_WINDOW_MS;
    this.cooldownMs = options?.cooldownMs ?? CB_COOLDOWN_MS;
    this.probeTimeoutMs = options?.probeTimeoutMs ?? CB_PROBE_TIMEOUT_MS;
  }

  /** Check if a request should be allowed through. */
  allowRequest(): boolean {
    return this.admit() !== null;
  }

  /**
   * allowRequest() for callers that may release a probe: null when refused,
   * else a probe token — 0 when admitted CLOSED (holds no probe), >0 when
   * this caller holds the HALF_OPEN probe. Pass it to releaseProbe().
   */
  admit(): number | null {
    if (this.state === "CLOSED") return 0;

    if (this.state === "OPEN") {
      // Check if cooldown has elapsed → transition to HALF_OPEN
      if (Date.now() - this.lastStateChange >= this.cooldownMs) {
        this.transition("HALF_OPEN");
        return ++this.probe; // allow one probe
      }
      return null;
    }

    // HALF_OPEN: already allowed one probe, block further until resolved —
    // unless that probe never reported (backstop: grant a new one).
    if (Date.now() - this.lastStateChange >= this.probeTimeoutMs) {
      console.log(
        `[circuit-breaker] ${this.name}: HALF_OPEN probe expired unreported → new probe`,
      );
      this.lastStateChange = Date.now();
      return ++this.probe;
    }
    return null;
  }

  /**
   * Give back a HALF_OPEN probe without judging the provider (the caller
   * aborted on its own, or failed locally before the outcome was known).
   * Returns to OPEN with the cooldown already spent, so the next
   * allowRequest() grants a probe at once. No-op unless `probe` is the
   * token admit() gave the current probe holder (so never in CLOSED/OPEN).
   */
  releaseProbe(probe: number): void {
    if (this.state !== "HALF_OPEN" || probe === 0 || probe !== this.probe)
      return;
    this.transition("OPEN", " (probe released unjudged)");
    this.lastStateChange = Date.now() - this.cooldownMs;
  }

  /** Record a successful call. Resets the breaker if in HALF_OPEN. */
  recordSuccess(): void {
    if (this.state === "HALF_OPEN") {
      this.failures = [];
      this.transition("CLOSED");
    }
  }

  /** Record a failed call. May trip the breaker. */
  recordFailure(): void {
    const now = Date.now();

    if (this.state === "HALF_OPEN") {
      // Probe failed — back to OPEN
      this.transition("OPEN");
      return;
    }

    // CLOSED: add failure, prune old ones, check threshold
    this.failures.push(now);
    this.failures = this.failures.filter((t) => now - t <= this.windowMs);

    if (this.failures.length >= this.failureThreshold) {
      this.transition("OPEN");
    }
  }

  getStatus(): CircuitBreakerStatus {
    return {
      state: this.state,
      failures: this.failures.length,
      lastFailure:
        this.failures.length > 0
          ? this.failures[this.failures.length - 1]
          : null,
      lastStateChange: this.lastStateChange,
    };
  }

  private transition(newState: CircuitState, note = ""): void {
    console.log(
      `[circuit-breaker] ${this.name}: ${this.state} → ${newState}${note}`,
    );
    this.state = newState;
    this.lastStateChange = Date.now();
    if (newState === "OPEN") {
      this.failures = []; // clear — we've already tripped
    }
  }
}

class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();

  /** Get or create a circuit breaker for a service. */
  get(
    name: string,
    options?: {
      failureThreshold?: number;
      windowMs?: number;
      cooldownMs?: number;
    },
  ): CircuitBreaker {
    let breaker = this.breakers.get(name);
    if (!breaker) {
      breaker = new CircuitBreaker(name, options);
      this.breakers.set(name, breaker);
    }
    return breaker;
  }

  /** Get all breaker statuses for /health. */
  getAllStatus(): Record<string, CircuitBreakerStatus> {
    const result: Record<string, CircuitBreakerStatus> = {};
    for (const [name, breaker] of this.breakers) {
      result[name] = breaker.getStatus();
    }
    return result;
  }

  /** Reset all breakers (for testing). */
  reset(): void {
    this.breakers.clear();
  }
}

export const circuitRegistry = new CircuitBreakerRegistry();
