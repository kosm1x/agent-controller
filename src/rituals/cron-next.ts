/**
 * Pure cron helpers shared by the dynamic scheduler and `/rituales`.
 *
 * `cronMatchesAt` is the 5-field matcher that used to be private to
 * dynamic.ts (`cronMatchesNow`); it is timezone-parametric so the `/rituales`
 * listing can compute the next fire of market rituals (America/New_York) as
 * well as MX ones. `nextCronFire` is a minute-step scan — at most 8 days —
 * which is plenty for a phone listing and needs no extra dependency.
 */

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DOW_ES = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

const formatters = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "numeric",
      hour12: false,
      weekday: "short",
      day: "numeric",
      month: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Check if a single cron field matches a value. Supports *, ranges, lists, steps. */
export function fieldMatches(
  field: string,
  value: number,
  min: number,
  max: number,
): boolean {
  if (field === "*") return true;

  for (const part of field.split(",")) {
    if (part.includes("/")) {
      const [range, stepStr] = part.split("/");
      const step = parseInt(stepStr);
      if (isNaN(step) || step <= 0) continue;
      let rangeMin = min;
      let rangeMax = max;
      if (range !== "*") {
        if (range.includes("-")) {
          const [a, b] = range.split("-").map(Number);
          rangeMin = a;
          rangeMax = b;
        } else {
          rangeMin = parseInt(range);
          rangeMax = max;
        }
      }
      if (value >= rangeMin && value <= rangeMax) {
        if ((value - rangeMin) % step === 0) return true;
      }
    } else if (part.includes("-")) {
      const [a, b] = part.split("-").map(Number);
      if (value >= a && value <= b) return true;
    } else {
      if (parseInt(part) === value) return true;
    }
  }
  return false;
}

/** True when the 5-field cron expression matches the wall-clock minute of `at` in `timeZone`. */
export function cronMatchesAt(
  cronExpr: string,
  at: Date,
  timeZone: string,
): boolean {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 5) return false;
  const p = partsFormatter(timeZone).formatToParts(at);
  const get = (type: string) => p.find((x) => x.type === type)?.value ?? "";
  // "24" is what hour12:false yields for midnight in some ICU builds.
  const hour = parseInt(get("hour")) % 24;
  const minute = parseInt(get("minute"));
  const dom = parseInt(get("day"));
  const month = parseInt(get("month"));
  const dow = DOW.indexOf(get("weekday"));
  return (
    fieldMatches(parts[0], minute, 0, 59) &&
    fieldMatches(parts[1], hour, 0, 23) &&
    fieldMatches(parts[2], dom, 1, 31) &&
    fieldMatches(parts[3], month, 1, 12) &&
    fieldMatches(parts[4], dow, 0, 6)
  );
}

const MAX_SCAN_MINUTES = 8 * 24 * 60;

/**
 * Next fire strictly after `from` (minute resolution), or null when nothing
 * matches in the next 8 days (yearly one-shots such as `0 9 27 7 *`).
 */
export function nextCronFire(
  cronExpr: string,
  from: Date,
  timeZone: string,
): Date | null {
  const start = new Date(from);
  start.setUTCSeconds(0, 0);
  const minuteField = cronExpr.trim().split(/\s+/)[0] ?? "*";
  // A fixed minute (every production ritual) only needs one probe per hour:
  // align to that minute, then step 60 (R1 audit W8: 188 ms → <2 ms).
  const fixedMinute = /^\d{1,2}$/.test(minuteField) ? Number(minuteField) : null;
  let first = 1;
  let step = 1;
  if (fixedMinute !== null) {
    const delta = (fixedMinute - start.getUTCMinutes() + 60) % 60;
    first = delta === 0 ? 60 : delta;
    step = 60;
  }
  for (let i = first; i <= MAX_SCAN_MINUTES; i += step) {
    const at = new Date(start.getTime() + i * 60_000);
    if (cronMatchesAt(cronExpr, at, timeZone)) return at;
  }
  return null;
}

/** `0 8 * * 1-5` → "L-V 08:00"; `30 16 * * 1-5` → "L-V 16:30"; `0 20 * * 5` → "vie 20:00"; else the raw expression. */
export function describeCron(cronExpr: string): string {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 5) return cronExpr;
  const [min, hour, dom, month, dow] = parts;
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour) || dom !== "*" || month !== "*") {
    return cronExpr;
  }
  const hhmm = `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  if (dow === "*") return `diario ${hhmm}`;
  if (dow === "1-5") return `L-V ${hhmm}`;
  if (/^\d$/.test(dow)) return `${DOW_ES[Number(dow)]} ${hhmm}`;
  return `${dow} ${hhmm}`;
}

/** "mar 25 ago 12:00" in the given zone — the phone listing's next-fire label. */
export function formatFire(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("es-MX", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(at)
    .replace(/\.,?/g, "")
    .replace(/,/g, "");
}
