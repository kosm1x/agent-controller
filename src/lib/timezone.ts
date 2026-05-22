/**
 * Centralized Mexico City timezone utilities.
 *
 * All user-facing timestamps MUST go through these helpers so the LLM
 * never sees raw UTC strings that contradict the system-prompt date.
 *
 * SQLite stores UTC via datetime('now').  We convert at the read boundary
 * — right before a timestamp enters a tool result or system prompt.
 */

export const USER_TIMEZONE = "America/Mexico_City";

/**
 * Format an ISO / SQLite UTC timestamp string into a human-readable
 * Mexico City date-time.  Returns the original string unchanged if
 * parsing fails (defensive — don't break tool results).
 *
 * Example: "2026-03-21 02:04:44" → "2026-03-20 20:04 CST"
 */
export function toMexTime(utcTimestamp: string | null | undefined): string {
  if (!utcTimestamp) return "";

  try {
    // SQLite datetime('now') produces "YYYY-MM-DD HH:MM:SS" (no TZ indicator).
    // Append "Z" to ensure JS treats it as UTC, not local.
    const normalized =
      utcTimestamp.includes("T") || utcTimestamp.endsWith("Z")
        ? utcTimestamp
        : utcTimestamp + "Z";

    const date = new Date(normalized);
    if (isNaN(date.getTime())) return utcTimestamp;

    return date.toLocaleString("sv-SE", {
      timeZone: USER_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return utcTimestamp;
  }
}

/**
 * Normalize a UTC timestamp string to strict ISO-8601
 * (`YYYY-MM-DDTHH:MM:SS.sssZ`).
 *
 * SQLite `datetime('now')` yields `"YYYY-MM-DD HH:MM:SS"` — space separator,
 * no `T`, no `Z` — which Zod's `z.iso.datetime()` rejects. This converts that
 * (and any already-ISO string) into a value the ISO validator accepts.
 * Returns null when the input is empty or unparseable, so callers can write
 * `toIsoUtc(x) ?? fallback`.
 */
export function toIsoUtc(
  utcTimestamp: string | null | undefined,
): string | null {
  if (!utcTimestamp) return null;
  const normalized =
    utcTimestamp.includes("T") || utcTimestamp.endsWith("Z")
      ? utcTimestamp
      : utcTimestamp.replace(" ", "T") + "Z";
  const d = new Date(normalized);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Current Mexico-City date for the LLM's `[Hoy: …]` block — ISO `YYYY-MM-DD`
 * plus the Spanish weekday in parens, e.g. "2026-05-22 (viernes)".
 *
 * The ISO part is the unambiguous anchor the system prompt tells the model to
 * expect; the weekday saves the model from computing day-of-week itself (the
 * frequent source of "mañana es <día equivocado>" errors). Keep the shape in
 * sync with the `## Fecha y hora` section of `identitySection()`.
 */
export function nowMexDate(): string {
  const now = new Date();
  const iso = now.toLocaleDateString("en-CA", { timeZone: USER_TIMEZONE });
  const weekday = now.toLocaleDateString("es-MX", {
    timeZone: USER_TIMEZONE,
    weekday: "long",
  });
  return `${iso} (${weekday})`;
}

/** Current Mexico-City wall-clock time, 24-hour `HH:MM`. */
export function nowMexTime(): string {
  return new Date().toLocaleTimeString("en-GB", {
    timeZone: USER_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * SQLite-compatible datetime string in Mexico City timezone.
 * Use in SQL: `datetime(${mxNowSql()})` or inline in INSERT/UPDATE.
 * Returns "YYYY-MM-DD HH:MM:SS" in Mexico City time.
 */
export function mxNowSql(): string {
  const now = new Date();
  // en-CA gives YYYY-MM-DD format
  const datePart = now.toLocaleDateString("en-CA", {
    timeZone: USER_TIMEZONE,
  });
  const timePart = now.toLocaleTimeString("en-GB", {
    timeZone: USER_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return `${datePart} ${timePart}`;
}
