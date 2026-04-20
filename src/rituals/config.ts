/**
 * Ritual scheduling configuration.
 */

export const RITUALS_TIMEZONE =
  process.env.RITUALS_TIMEZONE ?? "America/Mexico_City";

export interface RitualDefinition {
  id: string;
  title: string;
  cron: string;
  enabled: boolean;
  /**
   * Timezone for the cron schedule. Defaults to RITUALS_TIMEZONE
   * (America/Mexico_City). Market rituals override to America/New_York so
   * 8:00 AM / 4:30 PM map to NYSE pre-open / post-close regardless of local
   * MX time or DST drift.
   */
  timezone?: string;
}

export const rituals: RitualDefinition[] = [
  {
    id: "signal-intelligence",
    title: "Signal intelligence",
    // 6:00 AM daily — runs before morning briefing to have digest ready
    cron: "0 6 * * *",
    enabled: true,
  },
  {
    id: "morning-briefing",
    title: "Morning briefing",
    // Production: '0 7 * * *' (7:00 AM daily)
    cron: "0 7 * * *",
    enabled: true,
  },
  {
    id: "nightly-close",
    title: "Nightly close",
    // Production: '0 22 * * *' (10:00 PM daily)
    cron: "0 22 * * *",
    enabled: true,
  },
  {
    id: "skill-evolution",
    title: "Skill evolution",
    // 11:00 PM daily — analyze outcomes and evolve skills before evolution-log
    cron: "0 23 * * *",
    enabled: true,
  },
  {
    id: "day-narrative",
    title: "Day log narrative",
    // 11:30 PM daily — reads raw day-log, writes curated narrative companion
    // (between skill-evolution at 23:00 and evolution-log at 23:59)
    cron: "30 23 * * *",
    enabled: true,
  },
  {
    id: "evolution-log",
    title: "Evolution log",
    // 11:59 PM daily — captures full day of interactions
    cron: "59 23 * * *",
    enabled: true,
  },
  {
    id: "weekly-review",
    title: "Weekly review",
    // Sunday 8:00 PM — comprehensive weekly strategic review
    cron: "0 20 * * 0",
    enabled: true,
  },
  {
    id: "overnight-tuning",
    title: "Overnight tuning",
    // 1:00 AM MX, Tue/Thu/Sat — off-peak self-improvement
    cron: "0 1 * * 2,4,6",
    enabled: false, // controlled by TUNING_ENABLED env var at runtime
  },
  {
    id: "market-morning-scan",
    title: "Market morning scan",
    // 8:00 AM ET weekdays — 1.5h before NYSE open. Timezone override so DST
    // transitions don't shift the fire time relative to market hours.
    cron: "0 8 * * 1-5",
    enabled: true,
    timezone: "America/New_York",
  },
  {
    id: "market-eod-scan",
    title: "Market EOD scan",
    // 4:30 PM ET weekdays — 30 min after regular close. On early-close days
    // (13:00 ET close), the ritual's own trading-day-gate still allows the
    // scan; it will reflect the half-day's close via market_history.
    cron: "30 16 * * 1-5",
    enabled: true,
    timezone: "America/New_York",
  },
];
