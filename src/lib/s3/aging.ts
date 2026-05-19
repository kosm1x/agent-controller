/**
 * v7.7 Spine 2 Bundle 3 — baseline aging hygiene reminder.
 *
 * Per spec §6: every baseline has `established_at`. After 90 days, the
 * registry surfaces a "baseline aging" reminder for the operator: "is this
 * baseline still appropriate?" Not an alert (no drift detected); a
 * maintenance nudge that appears in Sunday morning briefs alongside the
 * P2 weekly digest.
 *
 * NOT a drift_alerts row — aging baselines stay in drift_signals; this
 * module surfaces them as a separate rendering concern. delivery.ts calls
 * `loadAgingBaselines` + `formatAgingSection` and appends the section to
 * the morning brief on Sundays.
 */

import { getDatabase } from "../../db/index.js";

export interface AgingBaseline {
  signal_name: string;
  source_substrate: string;
  established_at: string;
  established_by: string;
  age_days: number;
}

/** Default per spec §6. Override for testing. */
export const DEFAULT_AGING_THRESHOLD_DAYS = 90;

/**
 * Load enabled signals whose baseline_value_json is the same as it was
 * `daysThreshold` days ago (i.e. `drift_signals.established_at` is that
 * old). Disabled signals are excluded — operator presumably doesn't care
 * about hygiene on something they've turned off.
 *
 * Returns oldest-first so the operator's eye lands on the most-stale first.
 */
export function loadAgingBaselines(
  daysThreshold: number = DEFAULT_AGING_THRESHOLD_DAYS,
): AgingBaseline[] {
  const cutoff = new Date(
    Date.now() - daysThreshold * 24 * 60 * 60 * 1000,
  ).toISOString();
  return getDatabase()
    .prepare(
      `SELECT signal_name, source_substrate, established_at, established_by,
              CAST((julianday('now') - julianday(established_at)) AS INTEGER) AS age_days
       FROM drift_signals
       WHERE enabled = 1 AND established_at < ?
       ORDER BY established_at ASC`,
    )
    .all(cutoff) as AgingBaseline[];
}

/**
 * Render aging baselines as a markdown subsection for the morning brief.
 * Returns empty string when no aging baselines exist (OMIT discipline,
 * matches delivery.ts's empty-state semantic).
 *
 * Format integrates with delivery.ts's alert section:
 *   ### 🟢 Baselines envejecidos (>90 días) — N
 *   - **<signal_name>** (<source_substrate>) — hace 95 d, establecido por operator
 */
export function formatAgingSection(baselines: AgingBaseline[]): string {
  if (baselines.length === 0) return "";

  const lines: string[] = [];
  lines.push(
    `### 🟢 Baselines envejecidos (>${DEFAULT_AGING_THRESHOLD_DAYS} días) — ${baselines.length}`,
  );
  lines.push("");
  for (const b of baselines) {
    lines.push(
      `- **${b.signal_name}** (${b.source_substrate}) — hace ${b.age_days} d, establecido por ${b.established_by}`,
    );
  }
  return lines.join("\n").trimEnd();
}
