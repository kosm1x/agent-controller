import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

const mem = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../db/index.js", () => ({ getDatabase: () => mem.db }));

import {
  computeTrackedMoves,
  formatMove,
  movesLeadLine,
  movesPromptBlock,
  safeTrackedMoves,
} from "./signal-moves.js";

const NOW = new Date("2026-08-24T12:00:00Z");

function seed(rows: [string, string, number, string][]) {
  const db = mem.db as Database.Database;
  db.exec(`CREATE TABLE signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, domain TEXT NOT NULL,
    signal_type TEXT NOT NULL, key TEXT NOT NULL, value_numeric REAL, value_text TEXT,
    metadata TEXT, geo_lat REAL, geo_lon REAL, content_hash TEXT,
    collected_at TEXT NOT NULL, source_timestamp TEXT)`);
  const ins = db.prepare(
    "INSERT INTO signals (source, domain, signal_type, key, value_numeric, collected_at) VALUES (?, 'financial', 'numeric', ?, ?, ?)",
  );
  for (const [source, key, v, at] of rows) ins.run(source, key, v, at);
}

describe("computeTrackedMoves", () => {
  beforeEach(() => {
    mem.db = new Database(":memory:");
  });
  afterEach(() => {
    (mem.db as Database.Database).close();
    vi.restoreAllMocks();
  });

  it("BTC +22 % over 24 h is a move; ETH +5 % is not; largest first", () => {
    seed([
      ["coingecko", "bitcoin", 60000, "2026-08-23 11:30:00"],
      ["coingecko", "bitcoin", 73200, "2026-08-24 11:45:00"],
      ["coingecko", "ethereum", 2400, "2026-08-23 11:30:00"],
      ["coingecko", "ethereum", 2520, "2026-08-24 11:45:00"],
      ["frankfurter", "MXN", 18.0, "2026-08-23 11:00:00"],
      ["frankfurter", "MXN", 16.0, "2026-08-24 11:45:00"],
    ]);
    const moves = computeTrackedMoves(NOW);
    expect(moves.map((m) => m.key)).toEqual(["bitcoin", "MXN"]);
    expect(moves[0].pct).toBeCloseTo(22, 0);
    expect(formatMove(moves[0])).toBe("BTC +22.0% (24h)");
    expect(formatMove(moves[1])).toBe("MXN −11.1% (24h)");
  });

  it("no prior value ≥24 h old → no move (a fresh series cannot spike)", () => {
    seed([
      ["coingecko", "bitcoin", 60000, "2026-08-24 01:00:00"],
      ["coingecko", "bitcoin", 90000, "2026-08-24 11:45:00"],
    ]);
    expect(computeTrackedMoves(NOW)).toEqual([]);
  });

  it("a stale latest (>26 h old) is ignored — the depot is down, not moving", () => {
    seed([
      ["coingecko", "bitcoin", 60000, "2026-08-21 01:00:00"],
      ["coingecko", "bitcoin", 90000, "2026-08-23 04:00:00"],
    ]);
    expect(computeTrackedMoves(NOW)).toEqual([]);
  });

  it("twice-a-day series (frankfurter) compare against a ≥20 h prior; a prior older than 48 h is not used (R1 info)", () => {
    seed([
      ["frankfurter", "MXN", 18.0, "2026-08-23 00:15:00"], // 24 h before latest → valid prior
      ["frankfurter", "MXN", 16.0, "2026-08-24 00:15:00"], // latest, 11.75 h old → within 26 h
      ["treasury", "10y", 4.0, "2026-08-20 00:15:00"], // 4 days before latest → too old
      ["treasury", "10y", 5.0, "2026-08-24 00:15:00"],
    ]);
    const moves = computeTrackedMoves(NOW);
    expect(moves.map((m) => m.key)).toEqual(["MXN"]);
  });

  it("untracked sources (usgs magnitude) never produce a move", () => {
    seed([
      ["usgs", "max_magnitude", 2.0, "2026-08-23 11:00:00"],
      ["usgs", "max_magnitude", 6.0, "2026-08-24 11:45:00"],
    ]);
    expect(computeTrackedMoves(NOW)).toEqual([]);
  });

  it("lead line and prompt block", () => {
    expect(movesLeadLine([])).toBe("");
    const m = { source: "coingecko", key: "bitcoin", from: 60000, to: 73200, pct: 22 };
    expect(movesLeadLine([m])).toBe("📈 Movimientos ≥10%: BTC +22.0% (24h)");
    expect(movesPromptBlock([m])).toContain("LEAD OBLIGATORIO");
    expect(movesPromptBlock([m])).toContain('PROHIBIDO escribir "estable"');
    expect(movesPromptBlock([])).toContain("Ninguna serie rastreada");
    expect(movesPromptBlock([])).not.toContain("PROHIBIDO");
  });

  it("safeTrackedMoves swallows a missing table", () => {
    expect(safeTrackedMoves(NOW)).toEqual([]);
  });
});
