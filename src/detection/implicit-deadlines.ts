/**
 * Implicit-deadline detector — V8.1 Phase 5, spec §8.
 *
 * Scans task and objective text for dates and flags any that fall inside (or
 * just past) a one-week window — a deadline the operator stated in prose but
 * never tracked.
 *
 * RECONCILIATION vs spec §8:
 *   - Extracts ABSOLUTE dates with an explicit 4-digit year (ISO `2026-..`
 *     plus EN/ES month-name forms). Relative dates ("next Friday", "mañana")
 *     are deferred — they need a reference anchor and are error-prone;
 *     absolute dates are the reliable signal. The year is bounded 2026-2029
 *     (matching the spec's ISO regex) so a stray historical date is not read
 *     as a deadline.
 *   - Flag window: `-60 <= daysUntil < 7`. The spec says "deadline - now < 7
 *     days" (which would also flag dates years overdue); the lower bound
 *     keeps the signal to deadlines that are approaching or recently missed.
 *   - "status != completed" is broadened to all terminal-done states
 *     (completed / completed_with_concerns / cancelled).
 *
 * KNOWN FALSE-POSITIVE CLASS (audit W2): `extractDates` matches any
 * year-bearing date, including dates inside URLs or version strings
 * (`.../2026-01-02/...`, `v1 may 2026`). This detector deterministically
 * feeds the Phase-6 LLM judge, which discards a nonsensical "deadline" — the
 * FP is tolerated by design rather than guarded here.
 */

import { getDatabase } from "../db/index.js";
import type { ImplicitDeadlineSignal } from "./signals.js";

const MS_PER_DAY = 86_400_000;
/** Flag a date this many days out, through this many days overdue. */
const WINDOW_AHEAD_DAYS = 7;
const WINDOW_OVERDUE_DAYS = 60;
/** Defensive scan cap on the non-terminal task set. */
const MAX_TASKS = 500;

/** Month name → 1-12. English (full + abbrev) and Spanish. */
const MONTHS: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};
const MONTH_ALT = Object.keys(MONTHS).join("|");

const ISO_RE = /\b(202[6-9])-(\d{2})-(\d{2})\b/g;
// "15 de enero de 2026" / "15 enero 2026" / "15 January 2026"
const DMY_RE = new RegExp(
  `\\b(\\d{1,2})\\s+(?:de\\s+)?(${MONTH_ALT})\\s+(?:de\\s+)?(202[6-9])\\b`,
  "gi",
);
// "January 15, 2026" / "Jan 15 2026"
const MDY_RE = new RegExp(
  `\\b(${MONTH_ALT})\\s+(\\d{1,2}),?\\s+(202[6-9])\\b`,
  "gi",
);

/** Validate y/m/d and return ISO `YYYY-MM-DD`, or null if not a real date. */
function toIsoDate(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Round-trip guard — rejects e.g. Feb 30.
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  const mm = String(m).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}

/** Extract every absolute date (ISO `YYYY-MM-DD`) found in `text`. Deduplicated. */
export function extractDates(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(ISO_RE)) {
    const iso = toIsoDate(Number(m[1]), Number(m[2]), Number(m[3]));
    if (iso) found.add(iso);
  }
  for (const m of text.matchAll(DMY_RE)) {
    const iso = toIsoDate(
      Number(m[3]),
      MONTHS[m[2]!.toLowerCase()]!,
      Number(m[1]),
    );
    if (iso) found.add(iso);
  }
  for (const m of text.matchAll(MDY_RE)) {
    const iso = toIsoDate(
      Number(m[3]),
      MONTHS[m[1]!.toLowerCase()]!,
      Number(m[2]),
    );
    if (iso) found.add(iso);
  }
  return [...found];
}

/**
 * Today's calendar date in the operator's timezone, `YYYY-MM-DD`.
 *
 * The service runs `TZ=America/Mexico_City`. "Today" MUST be the MX-local
 * date, not `Math.floor(now / MS_PER_DAY)` — that is UTC midnight, which is
 * already the next calendar day for the 6h MX evening window, off-by-one-ing
 * every deadline at the window boundary (audit W1; the `toISOString()`-is-UTC
 * trap). `en-CA` formats as `YYYY-MM-DD`.
 */
function localToday(now: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
  }).format(new Date(now));
}

/**
 * Whole days from today (MX-local) to an ISO date. Negative = overdue.
 * Both endpoints are anchored to UTC midnight of their `YYYY-MM-DD` string,
 * so the difference is an exact integer day count (no DST drift).
 */
function daysUntil(isoDate: string, now: number): number {
  const today = Date.parse(localToday(now) + "T00:00:00Z");
  const target = Date.parse(isoDate + "T00:00:00Z");
  return Math.round((target - today) / MS_PER_DAY);
}

interface ScanItem {
  sourceRef: string;
  title: string;
  body: string;
}

/**
 * Detect implicit deadlines in task and objective text (spec §8).
 *
 * @param now - epoch ms reference for "today" (injectable for tests).
 */
export function detectImplicitDeadlines(
  now: number = Date.now(),
): ImplicitDeadlineSignal[] {
  const db = getDatabase();
  const items: ScanItem[] = [];

  for (const t of db
    .prepare(
      `SELECT task_id, title, description FROM tasks
        WHERE status NOT IN ('completed','completed_with_concerns','cancelled')
        ORDER BY id DESC LIMIT ?`,
    )
    .all(MAX_TASKS) as {
    task_id: string;
    title: string;
    description: string;
  }[]) {
    items.push({ sourceRef: t.task_id, title: t.title, body: t.description });
  }
  for (const o of db
    .prepare(
      `SELECT path, title, content FROM jarvis_files
        WHERE path LIKE 'NorthStar/objectives/%'`,
    )
    .all() as { path: string; title: string; content: string }[]) {
    items.push({ sourceRef: o.path, title: o.title, body: o.content });
  }

  const signals: ImplicitDeadlineSignal[] = [];
  const seen = new Set<string>(); // sourceRef + date — one signal per pair
  for (const item of items) {
    for (const [field, text] of [
      ["title", item.title],
      ["description", item.body],
    ] as const) {
      for (const date of extractDates(text)) {
        const du = daysUntil(date, now);
        if (du >= WINDOW_AHEAD_DAYS || du < -WINDOW_OVERDUE_DAYS) continue;
        const dedupe = `${item.sourceRef}|${date}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        signals.push({
          kind: "implicit_deadline",
          severity: "at_risk",
          summary:
            du < 0
              ? `Deadline ${date} (${-du}d overdue) in ${item.sourceRef}`
              : `Deadline ${date} (in ${du}d) in ${item.sourceRef}`,
          parsedDate: date,
          daysUntil: du,
          sourceField: field,
          sourceRef: item.sourceRef,
        });
      }
    }
  }
  return signals;
}
