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
  {
    id: "skill-evolution",
    title: "Skill evolution",
    // 11:00 PM daily — analyze outcomes and evolve skills before evolution-log
    cron: "0 23 * * *",
    enabled: true,
  },
  {
    id: "evolution-log",
    title: "Evolution log",
    // 11:59 PM daily — captures full day of interactions
    cron: "59 23 * * *",
    enabled: true,
  },
];
