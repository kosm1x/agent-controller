/**
 * email-verify — governance. Every SMTP probe leaves this box's mail IP
 * (mail.eurekams.net, the same IP Stalwart delivers from). These limits are
 * the structural guard against burning its reputation:
 *
 * - daily cap on CONNECTIONS (every host tried and every retry is charged),
 *   in memory, day keyed in America/Mexico_City
 * - global concurrency
 * - per-MX-host pacing: slots are reserved atomically, so N workers to the
 *   same host are staggered, never simultaneous
 * - breaker on "blocked / needs rDNS" replies: N strikes in a window pause
 *   every probe for a cooldown, then probing resumes (no half-open state
 *   that could latch — audit C1, 2026-09-11)
 */

export interface GovernanceConfig {
  readonly dailyCap: number;
  readonly concurrency: number;
  readonly hostGapMs: number;
  readonly breakerThreshold: number;
  readonly breakerWindowMs: number;
  readonly breakerCooldownMs: number;
}

export const DEFAULT_GOVERNANCE: GovernanceConfig = {
  dailyCap: 500,
  concurrency: 4,
  hostGapMs: 1500,
  breakerThreshold: 3,
  breakerWindowMs: 10 * 60_000,
  breakerCooldownMs: 30 * 60_000,
};

const MAX_TRACKED_HOSTS = 2000;

function envInt(name: string, fallback: number): number {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

export function governanceFromEnv(): GovernanceConfig {
  return {
    dailyCap: envInt("EMAIL_VERIFY_DAILY_CAP", DEFAULT_GOVERNANCE.dailyCap),
    concurrency: Math.max(1, envInt("EMAIL_VERIFY_CONCURRENCY", DEFAULT_GOVERNANCE.concurrency)),
    hostGapMs: envInt("EMAIL_VERIFY_HOST_GAP_MS", DEFAULT_GOVERNANCE.hostGapMs),
    breakerThreshold: DEFAULT_GOVERNANCE.breakerThreshold,
    breakerWindowMs: DEFAULT_GOVERNANCE.breakerWindowMs,
    breakerCooldownMs: DEFAULT_GOVERNANCE.breakerCooldownMs,
  };
}

function mxDayKey(now: Date): string {
  return now.toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
}

export class Governor {
  private dayKey: string;
  private usedToday = 0;
  private active = 0;
  private waiters: Array<() => void> = [];
  private readonly nextConnect = new Map<string, number>();
  private strikes: number[] = [];
  private openUntil = 0;

  constructor(
    readonly config: GovernanceConfig = DEFAULT_GOVERNANCE,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.dayKey = mxDayKey(new Date(now()));
  }

  private rollDay(): void {
    const key = mxDayKey(new Date(this.now()));
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.usedToday = 0;
    }
  }

  /** Connections still allowed today. */
  remainingToday(): number {
    this.rollDay();
    return Math.max(0, this.config.dailyCap - this.usedToday);
  }

  /** Charge one SMTP connection against the daily cap. False = cap exhausted. */
  chargeConnection(): boolean {
    this.rollDay();
    if (this.usedToday >= this.config.dailyCap) return false;
    this.usedToday += 1;
    return true;
  }

  breakerOpen(): boolean {
    return this.now() < this.openUntil;
  }

  /** Take a concurrency slot; returns the release function. */
  async acquire(): Promise<() => void> {
    while (this.active >= this.config.concurrency) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.waiters.shift()?.();
    };
  }

  /**
   * Reserve the next connection slot for `host` and wait for it. The slot
   * is claimed BEFORE sleeping, so concurrent callers queue behind each other.
   */
  async paceHost(host: string): Promise<void> {
    const t = this.now();
    const slot = Math.max(t, this.nextConnect.get(host) ?? 0);
    this.nextConnect.set(host, slot + this.config.hostGapMs);
    if (this.nextConnect.size > MAX_TRACKED_HOSTS) {
      const oldest = this.nextConnect.keys().next().value;
      if (oldest !== undefined) this.nextConnect.delete(oldest);
    }
    if (slot > t) await this.sleep(slot - t);
  }

  recordBlocked(): void {
    const t = this.now();
    this.strikes = this.strikes.filter((s) => t - s < this.config.breakerWindowMs);
    this.strikes.push(t);
    if (this.strikes.length >= this.config.breakerThreshold) {
      this.openUntil = t + this.config.breakerCooldownMs;
      this.strikes = [];
    }
  }

  /** Read-only snapshot. */
  usage(): { usedToday: number; dailyCap: number; breakerOpen: boolean } {
    this.rollDay();
    return { usedToday: this.usedToday, dailyCap: this.config.dailyCap, breakerOpen: this.breakerOpen() };
  }
}
