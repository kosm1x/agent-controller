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
  DEFAULT_PM_ACCOUNT,
  DEFAULT_PM_INITIAL_CASH,
  applyPmBuyToPortfolio,
  applyPmSellToPortfolio,
  initPmAccount,
  insertPmFill,
  insertPmPortfolioThesis,
  linkPmFillsToThesis,
  readPmBalance,
  readPmFills,
  readPmPortfolio,
  readPmPosition,
  updatePmCash,
} from "./pm-paper-persist.js";

describe("initPmAccount + readPmBalance", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("creates default-account row with $10K USDC on first call", () => {
    const row = initPmAccount();
    expect(row.account).toBe(DEFAULT_PM_ACCOUNT);
    expect(row.cash_usdc).toBe(DEFAULT_PM_INITIAL_CASH);
    expect(row.initial_cash).toBe(DEFAULT_PM_INITIAL_CASH);
  });

  it("is idempotent — repeat calls do not reset consumption", () => {
    initPmAccount();
    updatePmCash(DEFAULT_PM_ACCOUNT, 5_000, new Date().toISOString());
    const row = initPmAccount();
    expect(row.cash_usdc).toBe(5_000);
  });

  it("supports custom initial cash", () => {
    initPmAccount("alt", 50_000);
    expect(readPmBalance("alt")?.cash_usdc).toBe(50_000);
  });

  it("readPmBalance returns null for unknown account", () => {
    expect(readPmBalance("nonexistent")).toBeNull();
  });
});

describe("portfolio: buy / sell / avg-cost", () => {
  beforeEach(() => {
    db = freshDb();
    initPmAccount();
  });

  it("first buy inserts row with fill_price as avg_cost", () => {
    applyPmBuyToPortfolio({
      account: DEFAULT_PM_ACCOUNT,
      marketId: "0xm1",
      outcome: "Yes",
      tokenId: "tk-yes",
      slug: "will-btc-hit-200k",
      shares: 100,
      fillPrice: 0.4,
      nowIso: "2026-04-20T12:00:00Z",
    });
    const pos = readPmPosition(DEFAULT_PM_ACCOUNT, "0xm1", "Yes");
    expect(pos?.shares).toBe(100);
    expect(pos?.avg_cost).toBe(0.4);
    expect(pos?.token_id).toBe("tk-yes");
  });

  it("second buy recomputes weighted-average cost", () => {
    applyPmBuyToPortfolio({
      account: DEFAULT_PM_ACCOUNT,
      marketId: "0xm1",
      outcome: "Yes",
      tokenId: "tk-yes",
      slug: null,
      shares: 100,
      fillPrice: 0.4,
      nowIso: "2026-04-20T12:00:00Z",
    });
    applyPmBuyToPortfolio({
      account: DEFAULT_PM_ACCOUNT,
      marketId: "0xm1",
      outcome: "Yes",
      tokenId: "tk-yes",
      slug: null,
      shares: 100,
      fillPrice: 0.5,
      nowIso: "2026-04-27T12:00:00Z",
    });
    const pos = readPmPosition(DEFAULT_PM_ACCOUNT, "0xm1", "Yes");
    expect(pos?.shares).toBe(200);
    // (100×0.4 + 100×0.5) / 200 = 0.45
    expect(pos?.avg_cost).toBeCloseTo(0.45, 10);
  });

  it("sell computes realized P&L against avg_cost", () => {
    applyPmBuyToPortfolio({
      account: DEFAULT_PM_ACCOUNT,
      marketId: "0xm1",
      outcome: "Yes",
      tokenId: null,
      slug: null,
      shares: 100,
      fillPrice: 0.4,
      nowIso: "2026-04-20T12:00:00Z",
    });
    const result = applyPmSellToPortfolio({
      account: DEFAULT_PM_ACCOUNT,
      marketId: "0xm1",
      outcome: "Yes",
      shares: 40,
      fillPrice: 0.55,
      nowIso: "2026-04-27T12:00:00Z",
    });
    // (0.55 - 0.4) × 40 = 6.0
    expect(result.realizedPnl).toBeCloseTo(6.0, 10);
    expect(result.fullyExited).toBe(false);
    const pos = readPmPosition(DEFAULT_PM_ACCOUNT, "0xm1", "Yes");
    expect(pos?.shares).toBe(60);
    expect(pos?.avg_cost).toBe(0.4); // unchanged on sell
  });

  it("full exit deletes the row", () => {
    applyPmBuyToPortfolio({
      account: DEFAULT_PM_ACCOUNT,
      marketId: "0xm1",
      outcome: "Yes",
      tokenId: null,
      slug: null,
      shares: 100,
      fillPrice: 0.4,
      nowIso: "2026-04-20T12:00:00Z",
    });
    const result = applyPmSellToPortfolio({
      account: DEFAULT_PM_ACCOUNT,
      marketId: "0xm1",
      outcome: "Yes",
      shares: 100,
      fillPrice: 0.55,
      nowIso: "2026-04-27T12:00:00Z",
    });
    expect(result.fullyExited).toBe(true);
    expect(readPmPosition(DEFAULT_PM_ACCOUNT, "0xm1", "Yes")).toBeNull();
  });

  it("throws when selling more than held", () => {
    applyPmBuyToPortfolio({
      account: DEFAULT_PM_ACCOUNT,
      marketId: "0xm1",
      outcome: "Yes",
      tokenId: null,
      slug: null,
      shares: 50,
      fillPrice: 0.4,
      nowIso: "2026-04-20T12:00:00Z",
    });
    expect(() =>
      applyPmSellToPortfolio({
        account: DEFAULT_PM_ACCOUNT,
        marketId: "0xm1",
        outcome: "Yes",
        shares: 100,
        fillPrice: 0.5,
        nowIso: "2026-04-27T12:00:00Z",
      }),
    ).toThrow(/insufficient shares/);
  });

  it("throws when selling a token never held", () => {
    expect(() =>
      applyPmSellToPortfolio({
        account: DEFAULT_PM_ACCOUNT,
        marketId: "0xmissing",
        outcome: "Yes",
        shares: 1,
        fillPrice: 0.5,
        nowIso: "2026-04-27T12:00:00Z",
      }),
    ).toThrow(/insufficient shares/);
  });

  it("separate outcomes in same market tracked independently", () => {
    applyPmBuyToPortfolio({
      account: DEFAULT_PM_ACCOUNT,
      marketId: "0xm1",
      outcome: "Yes",
      tokenId: "tk-yes",
      slug: null,
      shares: 100,
      fillPrice: 0.4,
      nowIso: "2026-04-20T12:00:00Z",
    });
    applyPmBuyToPortfolio({
      account: DEFAULT_PM_ACCOUNT,
      marketId: "0xm1",
      outcome: "No",
      tokenId: "tk-no",
      slug: null,
      shares: 50,
      fillPrice: 0.6,
      nowIso: "2026-04-20T12:00:00Z",
    });
    const rows = readPmPortfolio();
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.outcome).sort()).toEqual(["No", "Yes"]);
  });
});

describe("fills", () => {
  beforeEach(() => {
    db = freshDb();
    initPmAccount();
  });

  it("insertPmFill + readPmFills round-trip", () => {
    insertPmFill({
      fillId: "f-1",
      thesisId: null,
      account: DEFAULT_PM_ACCOUNT,
      marketId: "0xm1",
      outcome: "Yes",
      tokenId: "tk-1",
      side: "buy",
      shares: 100,
      fillPrice: 0.4,
      grossNotional: 40,
      slippageBps: 20,
      realizedPnl: null,
      filledAt: "2026-04-20T12:00:00Z",
    });
    const rows = readPmFills();
    expect(rows.length).toBe(1);
    expect(rows[0]!.fill_id).toBe("f-1");
    expect(rows[0]!.side).toBe("buy");
  });

  it("filters by marketId + outcome + since", () => {
    for (let i = 0; i < 3; i++) {
      insertPmFill({
        fillId: `f-${i}`,
        thesisId: null,
        account: DEFAULT_PM_ACCOUNT,
        marketId: i === 1 ? "0xm2" : "0xm1",
        outcome: i === 2 ? "No" : "Yes",
        tokenId: null,
        side: "buy",
        shares: 1,
        fillPrice: 0.5,
        grossNotional: 0.5,
        slippageBps: 0,
        realizedPnl: null,
        filledAt: `2026-04-2${i}T12:00:00Z`,
      });
    }
    expect(readPmFills({ marketId: "0xm1" }).length).toBe(2);
    expect(readPmFills({ outcome: "No" }).length).toBe(1);
    expect(readPmFills({ since: "2026-04-22T00:00:00Z" }).length).toBe(1);
  });

  it("UNIQUE on fill_id rejects duplicates", () => {
    insertPmFill({
      fillId: "dup",
      thesisId: null,
      account: DEFAULT_PM_ACCOUNT,
      marketId: "0xm1",
      outcome: "Yes",
      tokenId: null,
      side: "buy",
      shares: 1,
      fillPrice: 0.5,
      grossNotional: 0.5,
      slippageBps: 0,
      realizedPnl: null,
      filledAt: "2026-04-20T12:00:00Z",
    });
    expect(() =>
      insertPmFill({
        fillId: "dup",
        thesisId: null,
        account: DEFAULT_PM_ACCOUNT,
        marketId: "0xm1",
        outcome: "Yes",
        tokenId: null,
        side: "buy",
        shares: 1,
        fillPrice: 0.5,
        grossNotional: 0.5,
        slippageBps: 0,
        realizedPnl: null,
        filledAt: "2026-04-20T12:00:00Z",
      }),
    ).toThrow();
  });
});

describe("linkPmFillsToThesis", () => {
  beforeEach(() => {
    db = freshDb();
    initPmAccount();
  });

  it("links fills by UUID", () => {
    insertPmFill({
      fillId: "f-A",
      thesisId: null,
      account: DEFAULT_PM_ACCOUNT,
      marketId: "0xm1",
      outcome: "Yes",
      tokenId: null,
      side: "buy",
      shares: 1,
      fillPrice: 0.5,
      grossNotional: 0.5,
      slippageBps: 0,
      realizedPnl: null,
      filledAt: "2026-04-20T12:00:00Z",
    });
    const thesisId = insertPmPortfolioThesis(
      {
        account: DEFAULT_PM_ACCOUNT,
        pmAlphaRunId: "pmalpha-1",
        shipOverride: false,
        targetWeights: { "0xm1": { outcome: "Yes", weight: 0.01 } },
      },
      "2026-04-20T12:00:00Z",
    );
    const linked = linkPmFillsToThesis(thesisId, ["f-A"]);
    expect(linked).toBe(1);
    const row = db
      .prepare(`SELECT thesis_id FROM pm_paper_fills WHERE fill_id='f-A'`)
      .get() as { thesis_id: number };
    expect(row.thesis_id).toBe(thesisId);
  });

  it("empty fill list is a no-op", () => {
    expect(linkPmFillsToThesis(42, [])).toBe(0);
  });
});

describe("insertPmPortfolioThesis", () => {
  beforeEach(() => {
    db = freshDb();
    initPmAccount();
  });

  it("writes sentinel row with PM-specific entry_signal + kind:pm metadata", () => {
    const id = insertPmPortfolioThesis(
      {
        account: DEFAULT_PM_ACCOUNT,
        pmAlphaRunId: "pmalpha-1",
        shipOverride: false,
        targetWeights: { "0xm1": { outcome: "Yes", weight: 0.01 } },
        notes: "test",
      },
      "2026-04-20T12:00:00Z",
    );
    const row = db
      .prepare(`SELECT * FROM trade_theses WHERE id = ?`)
      .get(id) as {
      symbol: string;
      entry_signal: string;
      thesis_text: string;
      outcome: string;
    };
    expect(row.symbol).toBe("PORTFOLIO");
    expect(row.entry_signal).toBe("pm_weekly_rebalance");
    expect(row.outcome).toBe("open");
    const thesis = JSON.parse(row.thesis_text);
    expect(thesis.kind).toBe("pm");
    expect(thesis.pm_alpha_run_id).toBe("pmalpha-1");
  });
});
