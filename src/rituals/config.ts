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
}

export const rituals: RitualDefinition[] = [
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
];
