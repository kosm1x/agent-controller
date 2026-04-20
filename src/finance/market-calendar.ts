/**
 * F9 Morning/EOD Rituals — NYSE market calendar.
 *
 * Pure data + helpers: no DB, no deps, no I/O. Covers 2024–2027 (v7.0's
 * horizon). Update annually as part of a ritual review when NYSE publishes
 * next year's calendar.
 *
 * All dates and arithmetic are in America/New_York. Callers pass either a
 * Date (wall-clock anywhere) or a YYYY-MM-DD string; we normalize through
 * `toLocaleDateString("en-CA", { timeZone: "America/New_York" })` to get the
 * NY-local ISO date.
 *
 * Source: nyse.com/markets/hours-calendars (verified 2026-04-20).
 */

export interface NyseHoliday {
  /** YYYY-MM-DD in America/New_York. */
  date: string;
  reason: string;
  /** Early close = market closes 13:00 ET (regular close is 16:00 ET). */
  earlyClose: boolean;
}

/**
 * Full NYSE holiday + early-close list, 2024–2027. Edit when NYSE publishes
 * next year's calendar (typically late-November prior year).
 */
export const NYSE_HOLIDAYS_2024_2027: readonly NyseHoliday[] = [
  // 2024
  { date: "2024-01-01", reason: "New Year's Day", earlyClose: false },
  {
    date: "2024-01-15",
    reason: "Martin Luther King Jr. Day",
    earlyClose: false,
  },
  { date: "2024-02-19", reason: "Presidents' Day", earlyClose: false },
  { date: "2024-03-29", reason: "Good Friday", earlyClose: false },
  { date: "2024-05-27", reason: "Memorial Day", earlyClose: false },
  { date: "2024-06-19", reason: "Juneteenth", earlyClose: false },
  {
    date: "2024-07-03",
    reason: "Day before Independence Day",
    earlyClose: true,
  },
  { date: "2024-07-04", reason: "Independence Day", earlyClose: false },
  { date: "2024-09-02", reason: "Labor Day", earlyClose: false },
  { date: "2024-11-28", reason: "Thanksgiving", earlyClose: false },
  { date: "2024-11-29", reason: "Day after Thanksgiving", earlyClose: true },
  { date: "2024-12-24", reason: "Christmas Eve", earlyClose: true },
  { date: "2024-12-25", reason: "Christmas Day", earlyClose: false },

  // 2025
  { date: "2025-01-01", reason: "New Year's Day", earlyClose: false },
  {
    date: "2025-01-09",
    reason: "Day of Mourning (President Carter)",
    earlyClose: false,
  },
  {
    date: "2025-01-20",
    reason: "Martin Luther King Jr. Day",
    earlyClose: false,
  },
  { date: "2025-02-17", reason: "Presidents' Day", earlyClose: false },
  { date: "2025-04-18", reason: "Good Friday", earlyClose: false },
  { date: "2025-05-26", reason: "Memorial Day", earlyClose: false },
  { date: "2025-06-19", reason: "Juneteenth", earlyClose: false },
  {
    date: "2025-07-03",
    reason: "Day before Independence Day",
    earlyClose: true,
  },
  { date: "2025-07-04", reason: "Independence Day", earlyClose: false },
  { date: "2025-09-01", reason: "Labor Day", earlyClose: false },
  { date: "2025-11-27", reason: "Thanksgiving", earlyClose: false },
  { date: "2025-11-28", reason: "Day after Thanksgiving", earlyClose: true },
  { date: "2025-12-24", reason: "Christmas Eve", earlyClose: true },
  { date: "2025-12-25", reason: "Christmas Day", earlyClose: false },

  // 2026
  { date: "2026-01-01", reason: "New Year's Day", earlyClose: false },
  {
    date: "2026-01-19",
    reason: "Martin Luther King Jr. Day",
    earlyClose: false,
  },
  { date: "2026-02-16", reason: "Presidents' Day", earlyClose: false },
  { date: "2026-04-03", reason: "Good Friday", earlyClose: false },
  { date: "2026-05-25", reason: "Memorial Day", earlyClose: false },
  { date: "2026-06-19", reason: "Juneteenth", earlyClose: false },
  {
    date: "2026-07-03",
    reason: "Independence Day (observed)",
    earlyClose: false,
  },
  { date: "2026-09-07", reason: "Labor Day", earlyClose: false },
  { date: "2026-11-26", reason: "Thanksgiving", earlyClose: false },
  { date: "2026-11-27", reason: "Day after Thanksgiving", earlyClose: true },
  { date: "2026-12-24", reason: "Christmas Eve", earlyClose: true },
  { date: "2026-12-25", reason: "Christmas Day", earlyClose: false },

  // 2027
  { date: "2027-01-01", reason: "New Year's Day", earlyClose: false },
  {
    date: "2027-01-18",
    reason: "Martin Luther King Jr. Day",
    earlyClose: false,
  },
  { date: "2027-02-15", reason: "Presidents' Day", earlyClose: false },
  { date: "2027-03-26", reason: "Good Friday", earlyClose: false },
  { date: "2027-05-31", reason: "Memorial Day", earlyClose: false },
  { date: "2027-06-18", reason: "Juneteenth (observed)", earlyClose: false },
  {
    date: "2027-07-02",
    reason: "Day before Independence Day",
    earlyClose: true,
  },
  {
    date: "2027-07-05",
    reason: "Independence Day (observed)",
    earlyClose: false,
  },
  { date: "2027-09-06", reason: "Labor Day", earlyClose: false },
  { date: "2027-11-25", reason: "Thanksgiving", earlyClose: false },
  { date: "2027-11-26", reason: "Day after Thanksgiving", earlyClose: true },
  { date: "2027-12-23", reason: "Christmas Eve (observed)", earlyClose: true },
  { date: "2027-12-24", reason: "Christmas Day (observed)", earlyClose: false },
];

// ---------------------------------------------------------------------------
// Index for O(1) lookup
// ---------------------------------------------------------------------------

const HOLIDAY_BY_DATE = new Map<string, NyseHoliday>();
for (const h of NYSE_HOLIDAYS_2024_2027) {
  HOLIDAY_BY_DATE.set(h.date, h);
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Date or YYYY-MM-DD string to the NY-local ISO date. Strings
 * already in YYYY-MM-DD form pass through after a format check; Date inputs
 * get timezone-converted to NY.
 */
export function toNyDate(d: Date | string): string {
  if (typeof d === "string") {
    if (!/^\d{4}-\d{2}-\d{2}/.test(d)) {
      throw new Error(`toNyDate: expected YYYY-MM-DD, got ${d}`);
    }
    return d.slice(0, 10);
  }
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/** DayOfWeek in NY-local time. 0 = Sunday, 6 = Saturday. */
function dayOfWeekNY(dateIso: string): number {
  // Parsing YYYY-MM-DD as UTC midnight avoids local-time drift across
  // timezones. Sunday = 0 as in Date.getUTCDay.
  const d = new Date(`${dateIso}T12:00:00Z`);
  return d.getUTCDay();
}

/** Returns YYYY-MM-DD of the day `n` days after `dateIso`. */
function addDays(dateIso: string, n: number): string {
  const d = new Date(`${dateIso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * True iff `date` is an NYSE full trading day (not a weekend, not a full-day
 * holiday). Early-close days (like 2026-11-27 "Day after Thanksgiving") count
 * as trading days — the market is open, just closes at 13:00 ET.
 */
export function isNyseTradingDay(date: Date | string): boolean {
  const iso = toNyDate(date);
  const dow = dayOfWeekNY(iso);
  if (dow === 0 || dow === 6) return false;
  const h = HOLIDAY_BY_DATE.get(iso);
  if (h && !h.earlyClose) return false;
  return true;
}

/** True iff `date` is a half-day (market closes 13:00 ET instead of 16:00). */
export function isEarlyClose(date: Date | string): boolean {
  const iso = toNyDate(date);
  return HOLIDAY_BY_DATE.get(iso)?.earlyClose === true;
}

/**
 * Returns the next NYSE trading day strictly after `date`. Skips weekends +
 * full-day holidays. Scans up to 10 days forward; throws if no trading day
 * found (extreme case, shouldn't happen under our calendar).
 */
export function nextTradingDay(date: Date | string): string {
  let iso = toNyDate(date);
  for (let i = 0; i < 10; i++) {
    iso = addDays(iso, 1);
    if (isNyseTradingDay(iso)) return iso;
  }
  throw new Error(
    `nextTradingDay: no trading day found within 10 days of ${toNyDate(date)}`,
  );
}

/** Returns the previous NYSE trading day strictly before `date`. */
export function prevTradingDay(date: Date | string): string {
  let iso = toNyDate(date);
  for (let i = 0; i < 10; i++) {
    iso = addDays(iso, -1);
    if (isNyseTradingDay(iso)) return iso;
  }
  throw new Error(
    `prevTradingDay: no trading day found within 10 days of ${toNyDate(date)}`,
  );
}

/** Returns the holiday record if `date` is an NYSE-observed date, else null. */
export function holidayFor(date: Date | string): NyseHoliday | null {
  return HOLIDAY_BY_DATE.get(toNyDate(date)) ?? null;
}

/** True iff `date` is Friday in NY-local time (used for weekly-rebalance cue). */
export function isFridayNY(date: Date | string): boolean {
  return dayOfWeekNY(toNyDate(date)) === 5;
}
