/**
 * F8.1a — persistence + retrieval helpers for PM alpha runs.
 *
 * Writers:
 *   persistPmAlphaRun(result) → batch-inserts pm_signal_weights rows (one per
 *                                token, active + excluded) in a single DB
 *                                transaction. Returns the row count written.
 *
 * Readers:
 *   readPmAlphaByRunId(runId)  → reconstructs a PmAlphaResult from stored rows
 *   readLatestPmAlphaRun()     → most-recent persisted run or null
 *   listRecentPmAlphaRuns(n)   → summary list for explain/audit
 *
 * Schema: pm_signal_weights (see schema.sql). Additive from session 82.
 */

import { getDatabase } from "../db/index.js";
import type {
  PmAlphaResult,
  PmTokenResult,
  PmExcludeReason,
} from "./pm-alpha.js";

export interface PersistPmAlphaStats {
  runId: string;
  rowsInserted: number;
}

export function persistPmAlphaRun(result: PmAlphaResult): PersistPmAlphaStats {
  const db = getDatabase();
  // Audit W8 round 1 + round 2: use ON CONFLICT ... DO NOTHING so a pathological
  // market with duplicate outcome labels (shouldn't happen, but seeding has no
  // client-side dedup) doesn't abort the whole transaction. ON CONFLICT is
  // narrower than blanket `INSERT OR IGNORE` — suppresses only the targeted
  // UNIQUE collision, NOT NULL/CHECK violations still surface as errors.
  const insert = db.prepare(
    `INSERT INTO pm_signal_weights
      (run_id, run_timestamp, market_id, slug, outcome, token_id,
       market_price, p_estimate, edge, whale_flow_usd, sentiment_tilt,
       kelly_raw, weight, liquidity_usd, resolution_date,
       excluded, exclude_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, market_id, outcome) DO NOTHING`,
  );

  let rowsInserted = 0;
  const tx = db.transaction((tokens: PmTokenResult[]) => {
    for (const t of tokens) {
      // Count actual inserted rows via `.changes`, not attempts. Audit
      // round-2-W-R2-2: previous impl lied about the real persist count.
      const res = insert.run(
        result.runId,
        result.runTimestamp,
        t.marketId,
        t.slug,
        t.outcome,
        t.tokenId,
        t.marketPrice,
        t.pEstimate,
        t.edge,
        t.whaleFlowUsd,
        t.sentimentTilt,
        t.kellyRaw,
        t.weight,
        t.liquidityUsd,
        t.resolutionDate,
        t.excluded ? 1 : 0,
        t.excludeReason,
      );
      rowsInserted += Number(res.changes);
    }
  });
  tx(result.tokens);

  return { runId: result.runId, rowsInserted };
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

interface PmRow {
  run_id: string;
  run_timestamp: string;
  market_id: string;
  slug: string | null;
  outcome: string;
  token_id: string | null;
  market_price: number;
  p_estimate: number;
  edge: number;
  whale_flow_usd: number | null;
  sentiment_tilt: number;
  kelly_raw: number;
  weight: number;
  liquidity_usd: number | null;
  resolution_date: string | null;
  excluded: number;
  exclude_reason: string | null;
}

function rowToToken(r: PmRow): PmTokenResult {
  return {
    marketId: r.market_id,
    slug: r.slug,
    outcome: r.outcome,
    tokenId: r.token_id,
    marketPrice: r.market_price,
    pEstimate: r.p_estimate,
    edge: r.edge,
    whaleFlowUsd: r.whale_flow_usd,
    sentimentTilt: r.sentiment_tilt,
    kellyRaw: r.kelly_raw,
    weight: r.weight,
    liquidityUsd: r.liquidity_usd,
    resolutionDate: r.resolution_date,
    excluded: r.excluded === 1,
    excludeReason: (r.exclude_reason as PmExcludeReason | null) ?? null,
  };
}

export function readPmAlphaByRunId(runId: string): PmAlphaResult | null {
  const db = getDatabase();
  const rows = db
    .prepare(`SELECT * FROM pm_signal_weights WHERE run_id = ? ORDER BY id ASC`)
    .all(runId) as PmRow[];
  if (rows.length === 0) return null;

  const tokens = rows.map(rowToToken);
  const first = rows[0]!;
  const nActive = tokens.filter((t) => !t.excluded).length;
  const totalExposure = tokens.reduce((s, t) => s + Math.abs(t.weight), 0);
  // Count unique markets for nMarkets
  const marketIds = new Set(rows.map((r) => r.market_id));
  return {
    runId: first.run_id,
    runTimestamp: first.run_timestamp,
    nMarkets: marketIds.size,
    nActive,
    totalExposure,
    tokens,
    durationMs: 0, // not persisted
  };
}

export function readLatestPmAlphaRun(): PmAlphaResult | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT run_id FROM pm_signal_weights
         ORDER BY run_timestamp DESC, id DESC LIMIT 1`,
    )
    .get() as { run_id?: string } | undefined;
  if (!row?.run_id) return null;
  return readPmAlphaByRunId(row.run_id);
}

export interface PmRunSummary {
  runId: string;
  runTimestamp: string;
  nMarkets: number;
  nActive: number;
  totalExposure: number;
}

export function listRecentPmAlphaRuns(limit = 10): PmRunSummary[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT run_id, run_timestamp,
              COUNT(DISTINCT market_id) AS n_markets,
              SUM(CASE WHEN excluded=0 THEN 1 ELSE 0 END) AS n_active,
              SUM(ABS(weight)) AS total_exposure
         FROM pm_signal_weights
         GROUP BY run_id
         ORDER BY run_timestamp DESC
         LIMIT ?`,
    )
    .all(limit) as Array<{
    run_id: string;
    run_timestamp: string;
    n_markets: number;
    n_active: number;
    total_exposure: number;
  }>;
  return rows.map((r) => ({
    runId: r.run_id,
    runTimestamp: r.run_timestamp,
    nMarkets: r.n_markets,
    nActive: r.n_active,
    totalExposure: r.total_exposure,
  }));
}
