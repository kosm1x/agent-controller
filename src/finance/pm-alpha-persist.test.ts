import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { resolve } from "path";

let db: Database.Database;

function freshDb() {
  const d = new Database(":memory:");
  const schema = readFileSync(resolve(__dirname, "../db/schema.sql"), "utf8");
  const f1 = schema.substring(schema.indexOf("-- F1 Data Layer"));
  d.exec(f1);
  return d;
}

vi.mock("../db/index.js", () => ({
  getDatabase: () => db,
}));

import {
  listRecentPmAlphaRuns,
  persistPmAlphaRun,
  readLatestPmAlphaRun,
  readPmAlphaByRunId,
} from "./pm-alpha-persist.js";
import type { PmAlphaResult, PmTokenResult } from "./pm-alpha.js";

function mkResult(
  runId: string,
  ts: string,
  tokens: PmTokenResult[],
): PmAlphaResult {
  return {
    runId,
    runTimestamp: ts,
    nMarkets: new Set(tokens.map((t) => t.marketId)).size,
    nActive: tokens.filter((t) => !t.excluded).length,
    totalExposure: tokens.reduce((s, t) => s + Math.abs(t.weight), 0),
    tokens,
    durationMs: 42,
  };
}

function mkToken(overrides: Partial<PmTokenResult> = {}): PmTokenResult {
  return {
    marketId: "0xm1",
    slug: "test",
    outcome: "Yes",
    tokenId: "tk-1",
    marketPrice: 0.4,
    pEstimate: 0.42,
    edge: 0.02,
    whaleFlowUsd: null,
    sentimentTilt: 0.02,
    kellyRaw: 0.013,
    weight: 0.0027,
    liquidityUsd: 50_000,
    resolutionDate: "2026-07-15T00:00:00Z",
    excluded: false,
    excludeReason: null,
    ...overrides,
  };
}

describe("persistPmAlphaRun + readPmAlphaByRunId", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("round-trips a 2-token run", () => {
    const yes = mkToken();
    const no = mkToken({ outcome: "No", marketPrice: 0.6, weight: -0.0027 });
    const result = mkResult("run-1", "2026-04-20T16:00:00Z", [yes, no]);

    const stats = persistPmAlphaRun(result);
    expect(stats.runId).toBe("run-1");
    expect(stats.rowsInserted).toBe(2);

    const read = readPmAlphaByRunId("run-1");
    expect(read).not.toBeNull();
    expect(read!.runId).toBe("run-1");
    expect(read!.tokens.length).toBe(2);
    expect(read!.nActive).toBe(2);
    expect(read!.nMarkets).toBe(1);
    expect(read!.totalExposure).toBeCloseTo(0.0054, 6);
  });

  it("preserves excluded rows with excludeReason", () => {
    const excl = mkToken({
      outcome: "Yes",
      excluded: true,
      excludeReason: "low_liquidity",
      weight: 0,
    });
    const result = mkResult("run-excl", "2026-04-20T16:00:00Z", [excl]);
    persistPmAlphaRun(result);
    const read = readPmAlphaByRunId("run-excl");
    expect(read!.tokens[0]!.excluded).toBe(true);
    expect(read!.tokens[0]!.excludeReason).toBe("low_liquidity");
  });

  it("ON CONFLICT DO NOTHING: duplicate (run_id, market_id, outcome) silently drops (audit W8 round 2)", () => {
    const t = mkToken();
    const result = mkResult("run-dup", "2026-04-20T16:00:00Z", [t, t]);
    const stats = persistPmAlphaRun(result);
    // rowsInserted reflects the REAL persist count via .changes, not attempts.
    expect(stats.rowsInserted).toBe(1);
    const count = (
      db.prepare(`SELECT COUNT(*) AS n FROM pm_signal_weights`).get() as {
        n: number;
      }
    ).n;
    expect(count).toBe(1);
  });

  it("readPmAlphaByRunId returns null for unknown run", () => {
    expect(readPmAlphaByRunId("nonexistent")).toBeNull();
  });
});

describe("readLatestPmAlphaRun", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("returns null when no runs persisted", () => {
    expect(readLatestPmAlphaRun()).toBeNull();
  });

  it("returns the most-recent run by timestamp", () => {
    persistPmAlphaRun(mkResult("older", "2026-04-18T00:00:00Z", [mkToken()]));
    persistPmAlphaRun(mkResult("newer", "2026-04-20T00:00:00Z", [mkToken()]));
    const latest = readLatestPmAlphaRun();
    expect(latest!.runId).toBe("newer");
  });
});

describe("listRecentPmAlphaRuns", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("returns summary rows in timestamp DESC order, respecting limit", () => {
    persistPmAlphaRun(mkResult("r1", "2026-04-18T00:00:00Z", [mkToken()]));
    persistPmAlphaRun(mkResult("r2", "2026-04-19T00:00:00Z", [mkToken()]));
    persistPmAlphaRun(mkResult("r3", "2026-04-20T00:00:00Z", [mkToken()]));
    const all = listRecentPmAlphaRuns(10);
    expect(all.map((r) => r.runId)).toEqual(["r3", "r2", "r1"]);
    const top2 = listRecentPmAlphaRuns(2);
    expect(top2.length).toBe(2);
    expect(top2[0]!.runId).toBe("r3");
  });

  it("summary fields match re-read detail", () => {
    const yes = mkToken({ weight: 0.005 });
    const no = mkToken({ outcome: "No", weight: -0.003 });
    persistPmAlphaRun(mkResult("r-sum", "2026-04-20T00:00:00Z", [yes, no]));
    const [s] = listRecentPmAlphaRuns(1);
    expect(s!.nMarkets).toBe(1);
    expect(s!.nActive).toBe(2);
    expect(s!.totalExposure).toBeCloseTo(0.008, 6);
  });
});
