/**
 * F8 Paper Trading — Clock abstraction.
 *
 * Every VenueAdapter + strategy reads `clock.now()` instead of `new Date()`.
 * This lets the same strategy run under:
 *   - WallClock (paper + live): real time
 *   - FixedClock (tests): deterministic timestamps
 *   - (future) BacktestClock: historical replay
 *
 * The Nautilus research-to-live parity principle: strategy code must be
 * time-source-agnostic. Reading `new Date()` directly in strategy code makes
 * the backtest / paper / live outputs non-equivalent for the same inputs —
 * the very divergence class this abstraction exists to prevent.
 */

export interface Clock {
  now(): Date;
}

export class WallClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class FixedClock implements Clock {
  constructor(private fixed: Date) {}
  now(): Date {
    // Return a fresh Date so callers can't mutate our internal state.
    return new Date(this.fixed.getTime());
  }
  /** Advance the clock by `ms` milliseconds. Tests use this to simulate time passing. */
  advance(ms: number): void {
    this.fixed = new Date(this.fixed.getTime() + ms);
  }
  /** Jump the clock to a specific date. */
  set(date: Date): void {
    this.fixed = new Date(date.getTime());
  }
}
