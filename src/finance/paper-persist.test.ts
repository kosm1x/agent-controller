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
  DEFAULT_ACCOUNT,
  DEFAULT_INITIAL_CASH,
  applyBuyToPortfolio,
  applySellToPortfolio,
  initAccount,
  insertFill,
  insertPortfolioThesis,
  linkFillsToThesis,
  readBalance,
  readFills,
  readPortfolio,
  readPosition,
  updateCash,
} from "./paper-persist.js";

describe("initAccount + readBalance", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("creates a default-account row on first call", () => {
    const row = initAccount();
    expect(row.account).toBe(DEFAULT_ACCOUNT);
    expect(row.cash).toBe(DEFAULT_INITIAL_CASH);
    expect(row.initial_cash).toBe(DEFAULT_INITIAL_CASH);
  });

  it("is idempotent across repeated calls (no overwrite)", () => {
    initAccount();
    updateCash(DEFAULT_ACCOUNT, 50_000, new Date().toISOString());
    const row = initAccount();
    expect(row.cash).toBe(50_000); // not reset
  });

  it("supports custom account + initial cash", () => {
    initAccount("alt", 500_000);
    const row = readBalance("alt");
    expect(row?.cash).toBe(500_000);
    expect(row?.initial_cash).toBe(500_000);
  });

  it("readBalance returns null for unknown account", () => {
    expect(readBalance("nonexistent")).toBeNull();
  });
});

describe("portfolio: buy / sell / avg-cost", () => {
  beforeEach(() => {
    db = freshDb();
    initAccount();
  });

  it("first buy inserts a row with fill_price as avg_cost", () => {
    applyBuyToPortfolio({
      account: DEFAULT_ACCOUNT,
      symbol: "AAPL",
      shares: 10,
      fillPrice: 200,
      nowIso: "2026-04-20T12:00:00Z",
    });
    const pos = readPosition(DEFAULT_ACCOUNT, "AAPL");
    expect(pos?.shares).toBe(10);
    expect(pos?.avg_cost).toBe(200);
  });

  it("second buy recomputes weighted-average cost", () => {
    applyBuyToPortfolio({
      account: DEFAULT_ACCOUNT,
      symbol: "AAPL",
      shares: 10,
      fillPrice: 200,
      nowIso: "2026-04-20T12:00:00Z",
    });
    applyBuyToPortfolio({
      account: DEFAULT_ACCOUNT,
      symbol: "AAPL",
      shares: 10,
      fillPrice: 220,
      nowIso: "2026-04-27T12:00:00Z",
    });
    const pos = readPosition(DEFAULT_ACCOUNT, "AAPL");
    expect(pos?.shares).toBe(20);
    // (10×200 + 10×220) / 20 = 4200/20 = 210
    expect(pos?.avg_cost).toBeCloseTo(210, 10);
  });

  it("sell computes realized P&L against avg_cost", () => {
    applyBuyToPortfolio({
      account: DEFAULT_ACCOUNT,
      symbol: "AAPL",
      shares: 10,
      fillPrice: 200,
      nowIso: "2026-04-20T12:00:00Z",
    });
    const result = applySellToPortfolio({
      account: DEFAULT_ACCOUNT,
      symbol: "AAPL",
      shares: 4,
      fillPrice: 230,
      nowIso: "2026-04-27T12:00:00Z",
    });
    expect(result.realizedPnl).toBeCloseTo((230 - 200) * 4, 10);
    expect(result.fullyExited).toBe(false);
    const pos = readPosition(DEFAULT_ACCOUNT, "AAPL");
    expect(pos?.shares).toBe(6);
    expect(pos?.avg_cost).toBe(200); // unchanged on sell
  });

  it("full exit deletes the row (no stale avg_cost)", () => {
    applyBuyToPortfolio({
      account: DEFAULT_ACCOUNT,
      symbol: "AAPL",
      shares: 10,
      fillPrice: 200,
      nowIso: "2026-04-20T12:00:00Z",
    });
    const result = applySellToPortfolio({
      account: DEFAULT_ACCOUNT,
      symbol: "AAPL",
      shares: 10,
      fillPrice: 230,
      nowIso: "2026-04-27T12:00:00Z",
    });
    expect(result.fullyExited).toBe(true);
    expect(readPosition(DEFAULT_ACCOUNT, "AAPL")).toBeNull();
  });

  it("throws when trying to sell more than held", () => {
    applyBuyToPortfolio({
      account: DEFAULT_ACCOUNT,
      symbol: "AAPL",
      shares: 5,
      fillPrice: 200,
      nowIso: "2026-04-20T12:00:00Z",
    });
    expect(() =>
      applySellToPortfolio({
        account: DEFAULT_ACCOUNT,
        symbol: "AAPL",
        shares: 10,
        fillPrice: 230,
        nowIso: "2026-04-27T12:00:00Z",
      }),
    ).toThrow(/insufficient shares/);
  });

  it("throws when selling a symbol never held", () => {
    expect(() =>
      applySellToPortfolio({
        account: DEFAULT_ACCOUNT,
        symbol: "MSFT",
        shares: 1,
        fillPrice: 300,
        nowIso: "2026-04-27T12:00:00Z",
      }),
    ).toThrow(/insufficient shares/);
  });

  it("readPortfolio returns all account positions sorted by symbol", () => {
    applyBuyToPortfolio({
      account: DEFAULT_ACCOUNT,
      symbol: "MSFT",
      shares: 5,
      fillPrice: 300,
      nowIso: "2026-04-20T12:00:00Z",
    });
    applyBuyToPortfolio({
      account: DEFAULT_ACCOUNT,
      symbol: "AAPL",
      shares: 10,
      fillPrice: 200,
      nowIso: "2026-04-20T12:00:00Z",
    });
    const rows = readPortfolio();
    expect(rows.map((r) => r.symbol)).toEqual(["AAPL", "MSFT"]);
  });
});

describe("fills", () => {
  beforeEach(() => {
    db = freshDb();
    initAccount();
  });

  it("insertFill + readFills round-trip", () => {
    insertFill({
      fillId: "f-1",
      thesisId: null,
      account: DEFAULT_ACCOUNT,
      symbol: "AAPL",
      side: "buy",
      shares: 10,
      fillPrice: 200.1,
      grossNotional: 2001,
      commission: 0,
      slippageBps: 5,
      realizedPnl: null,
      filledAt: "2026-04-20T12:00:00Z",
    });
    const rows = readFills();
    expect(rows.length).toBe(1);
    expect(rows[0]!.fill_id).toBe("f-1");
    expect(rows[0]!.side).toBe("buy");
  });

  it("filters by symbol + since", () => {
    for (let i = 0; i < 3; i++) {
      insertFill({
        fillId: `f-${i}`,
        thesisId: null,
        account: DEFAULT_ACCOUNT,
        symbol: i === 1 ? "MSFT" : "AAPL",
        side: "buy",
        shares: 1,
        fillPrice: 100,
        grossNotional: 100,
        commission: 0,
        slippageBps: 0,
        realizedPnl: null,
        filledAt: `2026-04-2${i}T12:00:00Z`,
      });
    }
    const aaplOnly = readFills({ symbol: "AAPL" });
    expect(aaplOnly.length).toBe(2);
    // since filter is inclusive (filled_at >= ?). After 2026-04-21 00:00 UTC
    // there are 2 fills (f-1 @ 2026-04-21 and f-2 @ 2026-04-22).
    const recent = readFills({ since: "2026-04-21T00:00:00Z" });
    expect(recent.length).toBe(2);
    const veryRecent = readFills({ since: "2026-04-22T00:00:00Z" });
    expect(veryRecent.length).toBe(1);
  });

  it("UNIQUE on fill_id rejects duplicates", () => {
    insertFill({
      fillId: "dup",
      thesisId: null,
      account: DEFAULT_ACCOUNT,
      symbol: "AAPL",
      side: "buy",
      shares: 1,
      fillPrice: 100,
      grossNotional: 100,
      commission: 0,
      slippageBps: 0,
      realizedPnl: null,
      filledAt: "2026-04-20T12:00:00Z",
    });
    expect(() =>
      insertFill({
        fillId: "dup",
        thesisId: null,
        account: DEFAULT_ACCOUNT,
        symbol: "AAPL",
        side: "buy",
        shares: 1,
        fillPrice: 100,
        grossNotional: 100,
        commission: 0,
        slippageBps: 0,
        realizedPnl: null,
        filledAt: "2026-04-20T12:00:00Z",
      }),
    ).toThrow();
  });
});

describe("linkFillsToThesis (audit W-R2-4)", () => {
  beforeEach(() => {
    db = freshDb();
    initAccount();
  });

  it("links fills by UUID to a thesis id", () => {
    insertFill({
      fillId: "f-A",
      thesisId: null,
      account: DEFAULT_ACCOUNT,
      symbol: "AAPL",
      side: "buy",
      shares: 1,
      fillPrice: 100,
      grossNotional: 100,
      commission: 0,
      slippageBps: 0,
      realizedPnl: null,
      filledAt: "2026-04-20T12:00:00Z",
    });
    insertFill({
      fillId: "f-B",
      thesisId: null,
      account: DEFAULT_ACCOUNT,
      symbol: "MSFT",
      side: "buy",
      shares: 1,
      fillPrice: 200,
      grossNotional: 200,
      commission: 0,
      slippageBps: 0,
      realizedPnl: null,
      filledAt: "2026-04-20T12:00:00Z",
    });
    const thesisId = insertPortfolioThesis(
      {
        account: DEFAULT_ACCOUNT,
        alphaRunId: "a",
        backtestRunId: "b",
        regime: null,
        shipBlocked: false,
        overrideShip: false,
        targetWeights: { AAPL: 0.5, MSFT: 0.5 },
      },
      "2026-04-20T12:00:00Z",
    );
    const linked = linkFillsToThesis(thesisId, ["f-A", "f-B"]);
    expect(linked).toBe(2);
    const rows = db
      .prepare(`SELECT fill_id, thesis_id FROM paper_fills`)
      .all() as Array<{ fill_id: string; thesis_id: number | null }>;
    expect(rows.every((r) => r.thesis_id === thesisId)).toBe(true);
  });

  it("empty fill list is a no-op", () => {
    expect(linkFillsToThesis(1, [])).toBe(0);
  });

  it("does not affect unrelated fills", () => {
    insertFill({
      fillId: "f-A",
      thesisId: null,
      account: DEFAULT_ACCOUNT,
      symbol: "AAPL",
      side: "buy",
      shares: 1,
      fillPrice: 100,
      grossNotional: 100,
      commission: 0,
      slippageBps: 0,
      realizedPnl: null,
      filledAt: "2026-04-20T12:00:00Z",
    });
    insertFill({
      fillId: "f-B",
      thesisId: null,
      account: DEFAULT_ACCOUNT,
      symbol: "MSFT",
      side: "buy",
      shares: 1,
      fillPrice: 200,
      grossNotional: 200,
      commission: 0,
      slippageBps: 0,
      realizedPnl: null,
      filledAt: "2026-04-20T12:00:00Z",
    });
    linkFillsToThesis(42, ["f-A"]);
    const rowB = db
      .prepare(`SELECT thesis_id FROM paper_fills WHERE fill_id='f-B'`)
      .get() as { thesis_id: number | null };
    expect(rowB.thesis_id).toBeNull();
  });
});

describe("insertPortfolioThesis", () => {
  beforeEach(() => {
    db = freshDb();
    initAccount();
  });

  it("writes sentinel row with full metadata", () => {
    const id = insertPortfolioThesis(
      {
        account: DEFAULT_ACCOUNT,
        alphaRunId: "alpha-1",
        backtestRunId: "bt-1",
        regime: null,
        shipBlocked: true,
        overrideShip: true,
        targetWeights: { AAPL: 0.5, MSFT: 0.5 },
      },
      "2026-04-20T12:00:00Z",
    );
    const row = db
      .prepare(`SELECT * FROM trade_theses WHERE id = ?`)
      .get(id) as {
      symbol: string;
      thesis_text: string;
      entry_signal: string;
      metadata: string;
      outcome: string;
    };
    expect(row.symbol).toBe("PORTFOLIO");
    expect(row.entry_signal).toBe("weekly_rebalance");
    expect(row.outcome).toBe("open");
    const thesis = JSON.parse(row.thesis_text);
    expect(thesis.alpha_run_id).toBe("alpha-1");
    expect(thesis.override_ship).toBe(true);
    const md = JSON.parse(row.metadata);
    expect(md.target_weights.AAPL).toBe(0.5);
  });
});
