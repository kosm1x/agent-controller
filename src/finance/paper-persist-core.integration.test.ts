/**
 * Paper-ledger SQL (paper-persist-core) on the real schema
 * (`initDatabase(":memory:")`), reached through the equity wrapper.
 *
 * The wrapper tests hold one account and mostly one position at a time, so
 * a statement that touched or returned more rows than its key names would
 * look correct there. Here the account each statement is for sits between
 * two neighbour accounts (acct-a < acct-b < acct-c) holding the same
 * symbols, and the bystander rows are read back with an independent query
 * and must be unchanged and not returned. Inside acct-b the written symbols
 * (AAPL, MSFT) sit between a lower one (AA) and a higher one (ZZ), so the
 * symbol term of the position key also has a neighbour on both sides.
 * Shares, prices and P&L in one row all differ, so a swapped column shows.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import {
  applyBuyToPortfolio,
  applySellToPortfolio,
  initAccount,
  insertFill,
  insertPortfolioThesis,
  readBalance,
  readFills,
  readPortfolio,
  readPosition,
  updateCash,
} from "./paper-persist.js";

const SQLITE_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const T1 = "2026-03-02T15:00:00Z";
const T2 = "2026-03-09T15:00:00Z";
const T3 = "2026-03-16T15:00:00Z";

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

/** Every position row as [account, symbol, shares, avg_cost, opened_at, last_updated]. */
function allPositions() {
  return (
    getDatabase()
      .prepare(
        `SELECT account, symbol, shares, avg_cost, opened_at, last_updated
           FROM paper_portfolio ORDER BY account, symbol`,
      )
      .all() as Array<Record<string, unknown>>
  ).map((r) => [
    r.account,
    r.symbol,
    r.shares,
    r.avg_cost,
    r.opened_at,
    r.last_updated,
  ]);
}

describe("balance statements on the real paper_balance table", () => {
  it("updateCash and readBalance touch and return only the named account, not a neighbour on either side", () => {
    initAccount("acct-a", 1000);
    initAccount("acct-b", 2000);
    initAccount("acct-c", 3000);
    updateCash("acct-b", 750, T1);

    expect(readBalance("acct-b")).toEqual({
      account: "acct-b",
      cash: 750,
      initial_cash: 2000,
      last_updated: T1,
    });
    for (const [account, cash] of [
      ["acct-a", 1000],
      ["acct-c", 3000],
    ] as const) {
      const row = readBalance(account);
      expect(row).toMatchObject({ account, cash, initial_cash: cash });
      expect(row?.last_updated).toMatch(SQLITE_DATETIME);
    }
    expect(readBalance("acct-0")).toBeNull();
    expect(readBalance("acct-bb")).toBeNull();
  });
});

describe("position statements on the real paper_portfolio table", () => {
  beforeEach(() => {
    // acct-b's rows are inserted out of symbol order, so row ids do not
    // follow it. "AA" < "AAPL" < "MSFT" < "ZZ" in string order.
    const buys: Array<[string, string, number, number]> = [
      ["acct-a", "AAPL", 10, 200],
      ["acct-a", "MSFT", 6, 310],
      ["acct-b", "MSFT", 5, 300],
      ["acct-b", "ZZ", 9, 90],
      ["acct-b", "AAPL", 4, 100],
      ["acct-b", "AA", 2, 70],
      ["acct-c", "AAPL", 7, 150],
      ["acct-c", "MSFT", 3, 320],
    ];
    for (const [account, symbol, shares, fillPrice] of buys) {
      applyBuyToPortfolio({ account, symbol, shares, fillPrice, nowIso: T1 });
    }
  });

  const BYSTANDERS = [
    ["acct-a", "AAPL", 10, 200, T1, T1],
    ["acct-a", "MSFT", 6, 310, T1, T1],
    ["acct-c", "AAPL", 7, 150, T1, T1],
    ["acct-c", "MSFT", 3, 320, T1, T1],
  ];
  const B_LOW = ["acct-b", "AA", 2, 70, T1, T1];
  const B_HIGH = ["acct-b", "ZZ", 9, 90, T1, T1];

  it("readPortfolio and readPosition return only the named account's rows", () => {
    expect(
      readPortfolio("acct-b").map((r) => [r.account, r.symbol, r.shares]),
    ).toEqual([
      ["acct-b", "AA", 2],
      ["acct-b", "AAPL", 4],
      ["acct-b", "MSFT", 5],
      ["acct-b", "ZZ", 9],
    ]);
    expect(readPosition("acct-b", "MSFT")).toMatchObject({
      account: "acct-b",
      symbol: "MSFT",
      shares: 5,
      avg_cost: 300,
    });
    expect(readPosition("acct-0", "MSFT")).toBeNull();
    expect(readPosition("acct-bb", "MSFT")).toBeNull();
    expect(readPortfolio("acct-0")).toEqual([]);
  });

  it("a second buy updates only that account's position", () => {
    applyBuyToPortfolio({
      account: "acct-b",
      symbol: "AAPL",
      shares: 12,
      fillPrice: 125,
      nowIso: T2,
    });
    // (4 × 100 + 12 × 125) / 16 = 118.75
    expect(allPositions()).toEqual([
      BYSTANDERS[0],
      BYSTANDERS[1],
      B_LOW,
      ["acct-b", "AAPL", 16, 118.75, T1, T2],
      ["acct-b", "MSFT", 5, 300, T1, T1],
      B_HIGH,
      BYSTANDERS[2],
      BYSTANDERS[3],
    ]);
  });

  it("a partial sell updates only that position; a full exit deletes only that row", () => {
    expect(
      applySellToPortfolio({
        account: "acct-b",
        symbol: "AAPL",
        shares: 1,
        fillPrice: 180,
        nowIso: T2,
      }),
    ).toEqual({ realizedPnl: 80, fullyExited: false });
    expect(
      applySellToPortfolio({
        account: "acct-b",
        symbol: "MSFT",
        shares: 5,
        fillPrice: 330,
        nowIso: T3,
      }),
    ).toEqual({ realizedPnl: 150, fullyExited: true });

    expect(allPositions()).toEqual([
      BYSTANDERS[0],
      BYSTANDERS[1],
      B_LOW,
      ["acct-b", "AAPL", 3, 100, T1, T2],
      B_HIGH,
      BYSTANDERS[2],
      BYSTANDERS[3],
    ]);
  });
});

describe("fill statements on the real paper_fills table", () => {
  function fill(
    fillId: string,
    account: string,
    symbol: string,
    filledAt: string,
  ): void {
    insertFill({
      fillId,
      thesisId: null,
      account,
      symbol,
      side: "sell",
      shares: 3,
      fillPrice: 201.5,
      grossNotional: 604.5,
      commission: 0.25,
      slippageBps: 7,
      realizedPnl: 4.5,
      filledAt,
    });
  }

  beforeEach(() => {
    // Fill ids sort f-mid < f-new < f-old, insertion order is mid, old, new,
    // and filled_at sorts old < mid < new: no order agrees with another.
    fill("f-a", "acct-a", "AAPL", T3);
    fill("f-mid", "acct-b", "AAPL", T2);
    fill("f-old", "acct-b", "MSFT", T1);
    fill("f-new", "acct-b", "AAPL", T3);
    fill("f-c", "acct-c", "AAPL", T3);
  });

  it("insertFill writes each value to its own column; readFills returns only the account's fills, newest first", () => {
    const rows = readFills({ account: "acct-b" });
    expect(rows.map((r) => r.fill_id)).toEqual(["f-new", "f-mid", "f-old"]);
    expect(rows[0]).toMatchObject({
      fill_id: "f-new",
      thesis_id: null,
      account: "acct-b",
      symbol: "AAPL",
      side: "sell",
      shares: 3,
      fill_price: 201.5,
      gross_notional: 604.5,
      commission: 0.25,
      slippage_bps: 7,
      realized_pnl: 4.5,
      filled_at: T3,
    });
    expect(readFills({ account: "acct-0" })).toEqual([]);
  });

  it("readFills applies limit, symbol and since only when given", () => {
    const ids = (opts: Parameters<typeof readFills>[0]) =>
      readFills(opts).map((r) => r.fill_id);
    expect(ids({ account: "acct-b", limit: 1 })).toEqual(["f-new"]);
    expect(ids({ account: "acct-b", symbol: "MSFT" })).toEqual(["f-old"]);
    expect(ids({ account: "acct-b", since: "2026-03-05T00:00:00Z" })).toEqual([
      "f-new",
      "f-mid",
    ]);
  });
});

describe("thesis statement on the real trade_theses table", () => {
  it("insertPortfolioThesis writes the timestamp to entry_time and the exit rule to exit_condition", () => {
    const id = insertPortfolioThesis(
      {
        account: "acct-b",
        alphaRunId: "alpha-run",
        backtestRunId: "bt-run",
        regime: null,
        shipBlocked: false,
        overrideShip: false,
        targetWeights: { AAPL: 0.25, MSFT: 0.75 },
      },
      T2,
    );
    expect(
      getDatabase()
        .prepare(
          `SELECT symbol, entry_signal, entry_time, exit_condition, outcome
             FROM trade_theses WHERE id = ?`,
        )
        .get(id),
    ).toEqual({
      symbol: "PORTFOLIO",
      entry_signal: "weekly_rebalance",
      entry_time: T2,
      exit_condition: "next_weekly_rebalance",
      outcome: "open",
    });
  });
});
