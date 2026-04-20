/**
 * v7.1 — persistence helpers for vision-detected chart patterns.
 *
 * Schema: `chart_patterns` table (see `src/db/schema.sql`). One row per
 * vision-LLM classification; confidence ∈ [0,1]; `interval` constrained to
 * `daily | weekly`.
 *
 * Reads prefer the most recent `detected_at` — the LLM re-renders/re-classifies
 * on every call, and the caller asks "what's the current read for SPY" rather
 * than walking history.
 */

import { getDatabase } from "../db/index.js";

export type ChartInterval = "daily" | "weekly";

export interface ChartPatternInput {
  symbol: string;
  interval: ChartInterval;
  pattern_label: string;
  confidence: number;
  candle_start?: number | null;
  candle_end?: number | null;
  png_path?: string | null;
  rationale?: string | null;
}

export interface ChartPatternRow extends ChartPatternInput {
  id: number;
  detected_at: number;
}

export function persistChartPattern(input: ChartPatternInput): number {
  if (!Number.isFinite(input.confidence)) {
    throw new Error("persistChartPattern: confidence must be finite");
  }
  const clamped = Math.max(0, Math.min(1, input.confidence));
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO chart_patterns
      (symbol, interval, pattern_label, confidence,
       candle_start, candle_end, png_path, rationale)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    input.symbol,
    input.interval,
    input.pattern_label,
    clamped,
    input.candle_start ?? null,
    input.candle_end ?? null,
    input.png_path ?? null,
    input.rationale ?? null,
  );
  return Number(result.lastInsertRowid);
}

export function getChartPatternById(id: number): ChartPatternRow | null {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT * FROM chart_patterns WHERE id = ?`)
    .get(id) as ChartPatternRow | undefined;
  return row ?? null;
}

export function listChartPatternsBySymbol(
  symbol: string,
  limit = 20,
): ChartPatternRow[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT * FROM chart_patterns
       WHERE symbol = ?
       ORDER BY detected_at DESC
       LIMIT ?`,
    )
    .all(symbol, Math.max(1, Math.min(500, limit))) as ChartPatternRow[];
}

export function listRecentChartPatterns(limit = 50): ChartPatternRow[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT * FROM chart_patterns
       ORDER BY detected_at DESC
       LIMIT ?`,
    )
    .all(Math.max(1, Math.min(500, limit))) as ChartPatternRow[];
}
