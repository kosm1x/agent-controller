/**
 * Signal digest memory — usability plan Phase 5.4.
 *
 * Compares the depot's tracked numeric series (coingecko / frankfurter /
 * treasury rows in `signals`) against their value ~24 h earlier. A move of
 * ≥ MOVE_THRESHOLD_PCT is (a) injected into the signal-intelligence prompt
 * as a mandatory lead and (b) prepended DETERMINISTICALLY to the delivered
 * digest by the delivery seam — the model cannot omit it, and "estables"
 * next to a +22 % line is visibly wrong (the BTC +22 % case).
 */

import { getDatabase } from "../db/index.js";

export const MOVE_THRESHOLD_PCT = 10;
const LATEST_WINDOW_H = 26;
const MIN_SPAN_H = 20;
const MAX_SPAN_H = 48;
export const TRACKED_SOURCES: ReadonlyArray<string> = [
  "coingecko",
  "frankfurter",
  "treasury",
];

export interface TrackedMove {
  source: string;
  key: string;
  from: number;
  to: number;
  pct: number;
}

interface Row {
  source: string;
  key: string;
  value_numeric: number;
  collected_at: string;
}

const LABELS: Record<string, string> = {
  bitcoin: "BTC",
  ethereum: "ETH",
};

function label(m: TrackedMove): string {
  return LABELS[m.key] ?? m.key.toUpperCase();
}

/** All tracked series with |24h change| ≥ threshold, largest first. */
export function computeTrackedMoves(
  now = new Date(),
  thresholdPct = MOVE_THRESHOLD_PCT,
): TrackedMove[] {
  const db = getDatabase();
  const placeholders = TRACKED_SOURCES.map(() => "?").join(",");
  // Latest within LATEST_WINDOW_H (frankfurter/treasury collect ~2×/day —
  // R1 audit info: a 6 h window excluded them); prior = the newest row at
  // least MIN_SPAN_H before the latest but not older than MAX_SPAN_H, so a
  // collection gap cannot compare against a days-old value.
  const latest = db
    .prepare(
      `SELECT source, key, value_numeric, collected_at FROM signals
       WHERE source IN (${placeholders}) AND signal_type = 'numeric' AND value_numeric IS NOT NULL
         AND collected_at >= datetime(?, ?) AND collected_at <= datetime(?)
       ORDER BY collected_at DESC`,
    )
    .all(...TRACKED_SOURCES, now.toISOString(), `-${LATEST_WINDOW_H} hours`, now.toISOString()) as Row[];
  const seen = new Map<string, Row>();
  for (const r of latest) {
    const k = `${r.source}/${r.key}`;
    if (!seen.has(k)) seen.set(k, r);
  }
  const prior = db.prepare(
    `SELECT value_numeric FROM signals
     WHERE source = ? AND key = ? AND signal_type = 'numeric' AND value_numeric IS NOT NULL
       AND collected_at <= datetime(?, ?) AND collected_at >= datetime(?, ?)
     ORDER BY collected_at DESC LIMIT 1`,
  );
  const moves: TrackedMove[] = [];
  for (const r of seen.values()) {
    const p = prior.get(
      r.source,
      r.key,
      r.collected_at,
      `-${MIN_SPAN_H} hours`,
      r.collected_at,
      `-${MAX_SPAN_H} hours`,
    ) as { value_numeric: number } | undefined;
    if (!p || !(p.value_numeric > 0)) continue;
    const pct = ((r.value_numeric - p.value_numeric) / p.value_numeric) * 100;
    if (Math.abs(pct) >= thresholdPct) {
      moves.push({ source: r.source, key: r.key, from: p.value_numeric, to: r.value_numeric, pct });
    }
  }
  moves.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
  return moves;
}

export function formatMove(m: TrackedMove): string {
  const sign = m.pct >= 0 ? "+" : "−";
  return `${label(m)} ${sign}${Math.abs(m.pct).toFixed(1)}% (24h)`;
}

/** One line, or "" — prepended to the delivered digest. */
export function movesLeadLine(moves: TrackedMove[]): string {
  if (moves.length === 0) return "";
  return `📈 Movimientos ≥${MOVE_THRESHOLD_PCT}%: ${moves.map(formatMove).join(" · ")}`;
}

/** Prompt block for the signal-intelligence template. */
export function movesPromptBlock(moves: TrackedMove[]): string {
  if (moves.length === 0) {
    return `\n\n## Movimientos 24h en series rastreadas\nNinguna serie rastreada (BTC, ETH, FX, tesoro) se movió ≥${MOVE_THRESHOLD_PCT}% en 24 h.`;
  }
  return (
    `\n\n## Movimientos 24h en series rastreadas — LEAD OBLIGATORIO\n` +
    moves.map((m) => `- ${formatMove(m)}: ${m.from} → ${m.to}`).join("\n") +
    `\n\nLa PRIMERA línea del digest debe ser este movimiento. PROHIBIDO escribir "estable"/"estables"/"sin cambios" sobre crypto/FX hoy: una serie rastreada se movió.`
  );
}

/** Convenience for the delivery seam: swallow DB errors, never block delivery. */
export function safeTrackedMoves(now = new Date()): TrackedMove[] {
  try {
    return computeTrackedMoves(now);
  } catch (err) {
    console.error("[rituals] signal-moves failed (no lead line):", err);
    return [];
  }
}
