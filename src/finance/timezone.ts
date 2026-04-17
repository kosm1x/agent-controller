/**
 * Timezone normalization — every adapter's timestamps land as
 * America/New_York ISO 8601 strings before persistence.
 *
 * Why NY: NYSE hours are the canonical reference for every downstream
 * F-module (indicators, signals, rituals, backtester). Storing in NY
 * avoids per-call conversions and matches what operators say out loud
 * ("market opens 9:30 ET").
 *
 * DST: always go through Intl.DateTimeFormat with timeZone option.
 * Never compute offsets manually — spring-forward / fall-back weeks
 * have shipped bugs every time someone tried arithmetic.
 */

const NY_TZ = "America/New_York";

/**
 * Convert an Alpha Vantage intraday timestamp (US/Eastern, no TZ suffix)
 * to an NY ISO 8601 string with proper DST-aware offset.
 *
 * Input shape: "2026-04-17 15:59:00" (wall clock, already Eastern).
 */
export function fromAlphaVantageIntraday(raw: string): string {
  // AV intraday is already wall-clock Eastern; we just need to attach the
  // correct offset (-04:00 or -05:00 depending on DST at that timestamp).
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})$/);
  if (!m) {
    throw new Error(`Unparseable Alpha Vantage intraday timestamp: ${raw}`);
  }
  const [, y, mo, d, h, mi, s] = m;
  // Construct as if UTC to get a Date object pinned to wall time, then
  // derive the NY offset for that instant by cross-checking.
  const asUtc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
  );
  const offset = nyOffsetForInstant(asUtc);
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${offset}`;
}

/**
 * Convert Alpha Vantage daily timestamp ("YYYY-MM-DD") to a 16:00 ET
 * close ISO string with the correct DST offset for that trading day.
 */
export function fromAlphaVantageDaily(rawDate: string): string {
  const m = rawDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`Unparseable AV daily date: ${rawDate}`);
  const [, y, mo, d] = m;
  const closeUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), 20, 0, 0); // 20:00 UTC ≈ 16:00 ET
  const offset = nyOffsetForInstant(closeUtc);
  return `${y}-${mo}-${d}T16:00:00${offset}`;
}

/**
 * Convert Polygon Unix milliseconds UTC to NY ISO 8601.
 */
export function fromPolygonUnixMs(unixMs: number): string {
  if (!Number.isFinite(unixMs) || unixMs < 0) {
    throw new Error(`Invalid Polygon unix ms: ${unixMs}`);
  }
  return formatInstantAsNyIso(unixMs);
}

/**
 * FRED returns YYYY-MM-DD date-only for daily-cadence macro series.
 * Keep as-is (no time component, no offset).
 */
export function fromFredDate(rawDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    throw new Error(`Unparseable FRED date: ${rawDate}`);
  }
  return rawDate;
}

/**
 * Accept/reject timestamp ranges to catch provider glitches (year 1970
 * epoch, future-dated, pre-market-history noise).
 */
export function isReasonableTimestamp(iso: string): boolean {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  const lower = Date.UTC(1990, 0, 1);
  const upper = Date.now() + 7 * 24 * 60 * 60 * 1000; // +7 days tolerance
  return t >= lower && t <= upper;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Derive the NY ±HH:MM offset string for a UTC instant.
 * Uses Intl.DateTimeFormat to ask "what does the clock say in NY at this moment"
 * and infers the offset from that vs the UTC clock.
 */
function nyOffsetForInstant(utcMs: number): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: NY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(utcMs));
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const nyWallUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    // hour "24" in en-CA means midnight-of-next-day; normalize to 0
    Number(map.hour) === 24 ? 0 : Number(map.hour),
    Number(map.minute),
    Number(map.second),
  );
  // Correct for hour=24 rollover (1-day advance) so offset arithmetic stays sane.
  const rolloverAdjust = Number(map.hour) === 24 ? 24 * 60 * 60 * 1000 : 0;
  const offsetMinutes = (nyWallUtc + rolloverAdjust - utcMs) / 60000;
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(Math.floor(abs % 60)).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

/** Format a UTC instant as full NY ISO 8601 with offset. */
function formatInstantAsNyIso(utcMs: number): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: NY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(utcMs));
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const hour = Number(map.hour) === 24 ? "00" : map.hour;
  const offset = nyOffsetForInstant(utcMs);
  return `${map.year}-${map.month}-${map.day}T${hour}:${map.minute}:${map.second}${offset}`;
}
