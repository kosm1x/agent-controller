/**
 * Weekly period canonicalization for the F7/F8 weekly pipelines.
 *
 * `market_data interval='weekly'` is NOT one row per week: Alpha Vantage dates
 * the in-progress week at its latest session, so every mid-week fetch leaves a
 * mid-week-dated "weekly" row behind, and different symbols get fetched on
 * different days. `market_signals` firings come from the DAILY scans as well
 * as the weekly seed, so they land on any weekday. Joining either to a period
 * axis by exact calendar day drops most of them as "missing data"
 * (alpha_run dd629513, 2026-09-18: 35/43 signals excluded).
 *
 * Here the period IS the week, keyed by its Friday (YYYY-MM-DD, whether or
 * not that Friday traded): one bar per (symbol, week) — the newest date wins,
 * which is the completed weekly bar whenever one was fetched — and every
 * firing is bucketed to its week. A week counts only once it is over —
 * Friday strictly before today (NY) — so a partial bar never closes a period,
 * and never past the caller's `asOf`. Until a week's completed bar is fetched,
 * its newest mid-week partial stands in as the close (heals on refresh).
 *
 * Known limit: `market_signals` does not record the bar interval a firing was
 * detected on, so daily- and weekly-bar detections share one signal key.
 */
import { todayInNewYork } from "./alpha-isq.js";
import { isNyseTradingDay, prevTradingDay } from "./market-calendar.js";
import type { BarRow, FiringRow } from "./alpha-matrix.js";

/** Friday (YYYY-MM-DD) of the Monday–Sunday week containing `iso`. */
export function weekEndKey(iso: string): string {
  const d = new Date(iso.slice(0, 10) + "T12:00:00Z");
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - sinceMonday + 4);
  return d.toISOString().slice(0, 10);
}

/** Friday of the newest week that is over — the `week < today` rule below. */
export function lastCompletedWeekKey(today: string = todayInNewYork()): string {
  const week = weekEndKey(today);
  if (week < today) return week;
  const d = new Date(week + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString().slice(0, 10);
}

/**
 * A weekly bar dated inside [last NYSE session, Friday] of the newest completed
 * week is that week's CLOSE: AV dates a holiday week by its last session,
 * Polygon rows are re-keyed to the Friday. An earlier date in that week is a
 * mid-week partial; a later one belongs to the week still in progress.
 */
export function isCompletedWeekClose(
  iso: string,
  today: string = todayInNewYork(),
): boolean {
  const friday = lastCompletedWeekKey(today);
  const lastSession = isNyseTradingDay(friday)
    ? friday
    : prevTradingDay(friday);
  const day = iso.slice(0, 10);
  return day >= lastSession && day <= friday;
}

export interface WeeklySourceRow {
  symbol: string;
  provider: string;
  timestamp: string;
  close: number;
  adjusted_close: number | null;
}

/**
 * One row per (symbol, week), continuous in price, grouped by symbol and
 * ascending by week within each (consumers re-sort: `toWeeklyPeriods`).
 *
 * The two providers disagree on basis: Polygon closes are split-adjusted, AV
 * `close` is RAW (XLE 2:1 2025-12 → av 88.76 vs polygon 44.38 for the same
 * week; NVDA 10:1 2024-06 is a fake −89 % week in raw closes). A week takes
 * its Polygon row when there is one (scale 1), else its newest AV row priced
 * at `adjusted_close` and rescaled by polygon/AV-adjusted at the nearest
 * later week both providers closed (else the newest such week), so the series
 * is continuous across the seam. `scale` multiplies the row's prices.
 *
 * Continuous, not identical in measure: AV `adjusted_close` also folds in
 * dividends, Polygon adjusts for splits only — returns in the AV stretch
 * (older than Polygon's ~2y) are total returns, newer ones price returns.
 */
export function stitchWeekly<T extends WeeklySourceRow>(
  rows: T[],
): Array<{ row: T; scale: number }> {
  const bySymbol = new Map<string, Map<string, { poly?: T; av?: T }>>();
  for (const r of rows) {
    let weeks = bySymbol.get(r.symbol);
    if (!weeks) bySymbol.set(r.symbol, (weeks = new Map()));
    const week = weekEndKey(r.timestamp);
    let slot = weeks.get(week);
    if (!slot) weeks.set(week, (slot = {}));
    if (r.provider === "polygon") slot.poly = r;
    else if (
      !slot.av ||
      r.timestamp.slice(0, 10) >= slot.av.timestamp.slice(0, 10)
    )
      slot.av = r;
  }

  const adjusted = (r: T) =>
    r.adjusted_close && r.adjusted_close > 0 ? r.adjusted_close : r.close;
  const out: Array<{ row: T; scale: number }> = [];
  for (const weeks of bySymbol.values()) {
    const desc = [...weeks].sort(([a], [b]) => b.localeCompare(a));
    // Only a Thursday/Friday AV row is that week's close (Thursday: Good Friday).
    const ratio = ([week, { poly, av }]: (typeof desc)[number]) => {
      if (!poly || !av || adjusted(av) <= 0) return undefined;
      const thursday = new Date(week + "T12:00:00Z");
      thursday.setUTCDate(thursday.getUTCDate() - 1);
      return av.timestamp.slice(0, 10) >= thursday.toISOString().slice(0, 10)
        ? poly.close / adjusted(av)
        : undefined;
    };
    let k = desc.map(ratio).find((v) => v !== undefined) ?? 1;
    const stitched: Array<{ row: T; scale: number }> = [];
    for (const entry of desc) {
      k = ratio(entry) ?? k;
      const { poly, av } = entry[1];
      if (poly) stitched.push({ row: poly, scale: 1 });
      else if (av && av.close > 0)
        stitched.push({ row: av, scale: (adjusted(av) / av.close) * k });
    }
    out.push(...stitched.reverse());
  }
  return out;
}

/** `stitchWeekly` as the `BarRow[]` the weekly pipelines consume. */
export function stitchedCloses(rows: WeeklySourceRow[]): BarRow[] {
  return stitchWeekly(rows).map(({ row, scale }) => ({
    symbol: row.symbol,
    timestamp: row.timestamp,
    close: row.close * scale,
  }));
}

export function toWeeklyPeriods(
  bars: BarRow[],
  firings: FiringRow[],
  asOf: string,
  today: string = todayInNewYork(),
): { bars: BarRow[]; firings: FiringRow[] } {
  const asOfDay = asOf.slice(0, 10);
  const over = (week: string) => week <= asOfDay && week < today;

  const newest = new Map<string, BarRow>();
  for (const b of bars) {
    const week = weekEndKey(b.timestamp);
    if (!over(week)) continue;
    const key = `${b.symbol}|${week}`;
    const prev = newest.get(key);
    if (!prev || b.timestamp.slice(0, 10) >= prev.timestamp.slice(0, 10)) {
      newest.set(key, b);
    }
  }
  const weeklyBars = Array.from(newest, ([key, b]) => ({
    ...b,
    timestamp: key.slice(key.indexOf("|") + 1),
  })).sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const weeklyFirings: FiringRow[] = [];
  for (const f of firings) {
    const week = weekEndKey(f.triggered_at);
    if (!over(week)) continue;
    weeklyFirings.push({ ...f, triggered_at: week });
  }

  return { bars: weeklyBars, firings: weeklyFirings };
}
