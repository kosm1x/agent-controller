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
import type { BarRow, FiringRow } from "./alpha-matrix.js";

/** Friday (YYYY-MM-DD) of the Monday–Sunday week containing `iso`. */
export function weekEndKey(iso: string): string {
  const d = new Date(iso.slice(0, 10) + "T12:00:00Z");
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - sinceMonday + 4);
  return d.toISOString().slice(0, 10);
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
