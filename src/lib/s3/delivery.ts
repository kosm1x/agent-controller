/**
 * v7.7 Spine 2 Bundle 2 — morning-brief delivery hook for S3 alerts.
 *
 * Per spec §8: active P0/P1 alerts surface in every morning brief; P2 alerts
 * aggregate into a weekly digest delivered on Sundays. This module:
 *
 *   1. Loads the alert sets via SQL (active = resolution_at IS NULL)
 *   2. Renders them as Spanish-localized markdown for inclusion in the brief
 *
 * The output markdown is intended for VERBATIM inclusion by the LLM in the
 * email body. The morning_brief instruction explicitly says "copy this section
 * verbatim" — the LLM should not paraphrase technical signal names or P0/P1
 * priorities.
 *
 * Empty alerts → empty string returned. Caller (morning.ts) omits the
 * "do you want to inject this?" branch when the section is empty, matching
 * the existing "OMIT the section entirely" pattern from morning.ts:39
 * (spaced-repetition section).
 *
 * Spec §8 does NOT mutate delivery_status in this bundle. Alerts keep
 * appearing every day until they auto-resolve (observed value moves back
 * into tolerance — not implemented yet) OR until Bundle 3's suppressAlert
 * API lands. For shadow-mode operation, daily reminder behavior is correct.
 */

import { getDatabase } from "../../db/index.js";
import { loadAgingBaselines, formatAgingSection } from "./aging.js";

export interface BriefAlertRow {
  id: number;
  signal_name: string;
  signal_kind: string;
  source_substrate: string;
  triggered_at: string;
  observed_value_json: string;
  deviation_kind: string;
  severity: "P0" | "P1" | "P2";
}

export interface BriefAlertSet {
  p0: BriefAlertRow[];
  p1: BriefAlertRow[];
  /** Empty unless `includeP2Digest=true`. Spec §8: P2s aggregate weekly. */
  p2_digest: BriefAlertRow[];
}

/**
 * Defensive truncation cap. If a section ever exceeds this count, render
 * the top N and a "+M more" footer rather than blow up the brief.
 */
export const ALERT_SECTION_CAP = 30;

/**
 * Load active alerts joined with their signal metadata. Active means
 * `resolution_at IS NULL`. Bundle 2 doesn't filter by `delivery_status`
 * because no mutation of delivery_status happens yet — alerts repeat
 * daily until they auto-resolve or operator suppresses (Bundle 3).
 */
export function loadActiveAlertsForBrief(opts: {
  includeP2Digest?: boolean;
}): BriefAlertSet {
  const db = getDatabase();
  // R1-W2 fold: push truncation into SQL with LIMIT cap+1 (the +1 row lets
  // formatAlertSection detect "more exist" without fetching 10k rows during
  // an alert storm).
  // R1-W3 fold: LEFT JOIN + COALESCE so an alert whose signal_id row was
  // deleted still renders (with a "<deleted signal N>" placeholder) instead
  // of vanishing from the brief. drift_alerts.signal_id has no REFERENCES
  // clause (foreign_keys pragma is on but the schema lacks the FK), so SQLite
  // permits the orphan; we degrade visibly rather than silently.
  const baseQuery = `
    SELECT a.id,
           COALESCE(s.signal_name, '<deleted signal ' || a.signal_id || '>') AS signal_name,
           COALESCE(s.signal_kind, '<unknown>') AS signal_kind,
           COALESCE(s.source_substrate, '<unknown>') AS source_substrate,
           a.triggered_at, a.observed_value_json, a.deviation_kind, a.severity
    FROM drift_alerts a
    LEFT JOIN drift_signals s ON s.id = a.signal_id
    WHERE a.resolution_at IS NULL AND a.severity = ?
    ORDER BY a.triggered_at DESC
    LIMIT ?
  `;
  // cap+1 so formatAlertSection can detect overflow without an extra COUNT(*) query
  const fetchLimit = ALERT_SECTION_CAP + 1;
  const p0 = db.prepare(baseQuery).all("P0", fetchLimit) as BriefAlertRow[];
  const p1 = db.prepare(baseQuery).all("P1", fetchLimit) as BriefAlertRow[];

  let p2_digest: BriefAlertRow[] = [];
  if (opts.includeP2Digest) {
    p2_digest = db.prepare(baseQuery).all("P2", fetchLimit) as BriefAlertRow[];
  }
  return { p0, p1, p2_digest };
}

/**
 * Compute whether today is Sunday in the rituals timezone (America/Mexico_City).
 * Used by the scheduler to gate `includeP2Digest`. Sunday = JS getDay() === 0.
 * Pure, testable (date is injectable).
 */
export function isSundayInMxTime(now: Date = new Date()): boolean {
  // toLocaleDateString with weekday — locale-stable across runtimes.
  const weekday = now.toLocaleDateString("en-US", {
    timeZone: "America/Mexico_City",
    weekday: "short",
  });
  return weekday === "Sun";
}

/**
 * Render a BriefAlertSet as Spanish-localized markdown for VERBATIM inclusion
 * in the morning brief email body. Returns empty string when no alerts exist
 * in any priority bucket (caller should then skip the inject-into-prompt step).
 *
 * Spanish convention matches morning.ts's existing voice. Signal names stay
 * as identifiers (not translated) because they're stable cross-system refs.
 *
 * Format:
 *   ## 🚨 Alertas de deriva (S3)
 *   ### Crítico (P0) — N
 *   - **<signal_name>** (<source_substrate>) — <deviation_kind>, observado: <value>
 *     _disparado <relative time>_
 *   ### Alta (P1) — N
 *   - ...
 *   ### Resumen semanal (P2) — N  ← only on Sundays
 *   - ...
 *
 * Section truncates at ALERT_SECTION_CAP per priority. Excess noted with
 * "_+M más — ver drift_alerts en la base de datos._"
 */
export function formatAlertSection(set: BriefAlertSet): string {
  if (
    set.p0.length === 0 &&
    set.p1.length === 0 &&
    set.p2_digest.length === 0
  ) {
    return "";
  }

  const lines: string[] = [];
  lines.push("## 🚨 Alertas de deriva (S3)");
  lines.push("");

  if (set.p0.length > 0) {
    lines.push(`### 🔴 Crítico (P0) — ${set.p0.length}`);
    lines.push("");
    appendAlerts(lines, set.p0);
    lines.push("");
  }

  if (set.p1.length > 0) {
    lines.push(`### 🟠 Alta (P1) — ${set.p1.length}`);
    lines.push("");
    appendAlerts(lines, set.p1);
    lines.push("");
  }

  if (set.p2_digest.length > 0) {
    lines.push(`### 🟡 Resumen semanal (P2) — ${set.p2_digest.length}`);
    lines.push("");
    appendAlerts(lines, set.p2_digest);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

/**
 * Compose the full morning-brief drift section, including aging-baseline
 * hygiene reminders on Sundays (Bundle 3).
 *
 * - Mon-Sat: alerts only (P0/P1; no P2 digest, no aging)
 * - Sun: alerts + P2 weekly digest + aging baselines >90d
 *
 * Returns empty string when nothing to report (OMIT discipline).
 */
export function composeMorningBriefDriftSection(
  now: Date = new Date(),
): string {
  const sunday = isSundayInMxTime(now);
  const set = loadActiveAlertsForBrief({ includeP2Digest: sunday });
  const alertSection = formatAlertSection(set);

  // Aging baselines only on Sundays — per spec §6 it's a weekly hygiene nudge.
  let agingSection = "";
  if (sunday) {
    try {
      const aging = loadAgingBaselines();
      agingSection = formatAgingSection(aging);
    } catch (err) {
      // Aging load failure must NOT block alert delivery — alerts are
      // higher-priority. Log and proceed without the aging subsection.
      console.warn(
        "[s3-delivery] aging baseline load failed (alerts section unaffected):",
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (alertSection === "" && agingSection === "") return "";
  if (alertSection === "") {
    // R1-W3 fold: aging-only Sundays use a distinct hygiene heading, NOT
    // the "🚨 Alertas de deriva" alarm-bell heading. Baselines past 90d are
    // a maintenance nudge, not an alert; aligning urgency with content
    // keeps the operator's eye properly tuned.
    return `## 🟢 Higiene de baselines (S3)\n\n${agingSection}`;
  }
  if (agingSection === "") return alertSection;
  return `${alertSection}\n\n${agingSection}`;
}

function appendAlerts(lines: string[], alerts: BriefAlertRow[]): void {
  // SQL fetches at most ALERT_SECTION_CAP + 1 rows (R1-W2 fold). If we got
  // the +1 row, there are AT LEAST that many extra — we don't know the
  // exact count without a separate COUNT(*) (deliberately avoided). Render
  // the cap and note the overflow without a specific number.
  const shown = alerts.slice(0, ALERT_SECTION_CAP);
  for (const a of shown) {
    lines.push(
      `- **${a.signal_name}** (${a.source_substrate}) — ${a.deviation_kind}, observado: ${extractObserved(a.observed_value_json)}`,
    );
    lines.push(`  _disparado ${formatRelativeTime(a.triggered_at)}_`);
  }
  if (alerts.length > ALERT_SECTION_CAP) {
    lines.push(
      `- _Más alertas activas — ver \`drift_alerts\` en la base de datos (mostrando primeras ${ALERT_SECTION_CAP})._`,
    );
  }
}

/**
 * Extract the observed scalar from observed_value_json. The evaluator stores
 * `{"value": ..., "error": ...}`. For query_failure alerts, value is null;
 * surface the error message instead. For trips, surface the value.
 */
function extractObserved(json: string): string {
  try {
    const parsed = JSON.parse(json) as { value?: unknown; error?: string };
    if (typeof parsed.error === "string" && parsed.error.length > 0) {
      // Truncate long error strings
      return `error (${parsed.error.slice(0, 60)})`;
    }
    if (parsed.value === null || parsed.value === undefined) {
      return "null";
    }
    if (typeof parsed.value === "number") {
      // Round to 4 decimals to avoid jittery "0.8500000000000001"
      return Math.round(parsed.value * 10000) / 10000 + "";
    }
    return String(parsed.value);
  } catch {
    return json.slice(0, 80);
  }
}

/**
 * Format triggered_at as a Spanish relative-time string suitable for prose.
 * "hace 3 horas", "hace 2 días", "hoy a las 14:30". Best-effort; falls back
 * to the raw ISO string on parse failure.
 */
export function formatRelativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const ageMs = Date.now() - t;
  const ageMin = Math.floor(ageMs / 60_000);
  const ageHr = Math.floor(ageMin / 60);
  const ageDays = Math.floor(ageHr / 24);
  if (ageMin < 60) return `hace ${ageMin} min`;
  if (ageHr < 24) return `hace ${ageHr} h`;
  if (ageDays < 7) return `hace ${ageDays} d`;
  return `hace ${Math.floor(ageDays / 7)} sem`;
}
