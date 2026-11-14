/**
 * Paper-ledger position SQL for the three-column key
 * (account, market_id, outcome) on the real schema
 * (`initDatabase(":memory:")`), reached through the PM wrapper.
 *
 * The position written sits between two neighbours in EACH key column:
 * acct-a < acct-m < acct-z (same market and outcome), mkt-a < mkt-m < mkt-z
 * (same account and outcome, so several markets hold the same outcome) and
 * No < Push < Yes (same account and market). It is persisted last, so row ids
 * do not follow key order. Every neighbour is read back with an independent
 * query and must be unchanged. Shares, prices and P&L in one row all differ.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import {
  applyPmBuyToPortfolio,
  applyPmSellToPortfolio,
  readPmPortfolio,
  readPmPosition,
} from "./pm-paper-persist.js";

const T1 = "2026-03-02T15:00:00Z";
const T2 = "2026-03-09T15:00:00Z";
const T3 = "2026-03-16T15:00:00Z";

type Pos = [string, string, string, number, number, string, string];

/** Neighbours as [account, market_id, outcome, shares, avg_cost, opened_at, last_updated]. */
const NEIGHBOURS: Pos[] = [
  ["acct-a", "mkt-m", "Push", 3, 0.0625, T1, T1],
  ["acct-m", "mkt-a", "Push", 6, 0.1875, T1, T1],
  ["acct-m", "mkt-m", "No", 9, 0.4375, T1, T1],
  ["acct-m", "mkt-m", "Yes", 10, 0.5625, T1, T1],
  ["acct-m", "mkt-z", "Push", 7, 0.3125, T1, T1],
  ["acct-z", "mkt-m", "Push", 5, 0.125, T1, T1],
];

/** Every position row, sorted by the full key. */
function allPositions(): Pos[] {
  return (
    getDatabase()
      .prepare(
        `SELECT account, market_id, outcome, shares, avg_cost, opened_at, last_updated
           FROM pm_paper_portfolio ORDER BY account, market_id, outcome`,
      )
      .all() as Array<Record<string, unknown>>
  ).map(
    (r) =>
      [
        r.account,
        r.market_id,
        r.outcome,
        r.shares,
        r.avg_cost,
        r.opened_at,
        r.last_updated,
      ] as Pos,
  );
}

/** NEIGHBOURS with the target row (if any) at its place in key order. */
function withTarget(target: Pos | null): Pos[] {
  return [
    ...NEIGHBOURS.slice(0, 3),
    ...(target ? [target] : []),
    ...NEIGHBOURS.slice(3),
  ];
}

beforeEach(() => {
  initDatabase(":memory:");
  for (const [account, marketId, outcome, shares, fillPrice] of [
    NEIGHBOURS[5]!,
    NEIGHBOURS[0]!,
    NEIGHBOURS[4]!,
    NEIGHBOURS[1]!,
    NEIGHBOURS[3]!,
    NEIGHBOURS[2]!,
  ]) {
    applyPmBuyToPortfolio({
      account,
      marketId,
      outcome,
      tokenId: `tok-${marketId}-${outcome}`,
      slug: null,
      shares,
      fillPrice,
      nowIso: T1,
    });
  }
  applyPmBuyToPortfolio({
    account: "acct-m",
    marketId: "mkt-m",
    outcome: "Push",
    tokenId: null,
    slug: "mkt-m-slug",
    shares: 8,
    fillPrice: 0.5,
    nowIso: T1,
  });
});

afterEach(() => {
  closeDatabase();
});

describe("PM position statements on the real pm_paper_portfolio table", () => {
  it("readPmPosition and readPmPortfolio return only the keyed rows", () => {
    expect(readPmPosition("acct-m", "mkt-m", "Push")).toMatchObject({
      account: "acct-m",
      market_id: "mkt-m",
      outcome: "Push",
      token_id: null,
      slug: "mkt-m-slug",
      shares: 8,
      avg_cost: 0.5,
    });
    expect(readPmPosition("acct-m", "mkt-m", "Maybe")).toBeNull();
    expect(readPmPosition("acct-m", "mkt-0", "Push")).toBeNull();
    expect(
      readPmPortfolio("acct-m").map((r) => [r.market_id, r.outcome, r.shares]),
    ).toEqual([
      ["mkt-a", "Push", 6],
      ["mkt-m", "No", 9],
      ["mkt-m", "Push", 8],
      ["mkt-m", "Yes", 10],
      ["mkt-z", "Push", 7],
    ]);
  });

  it("a second buy updates only the keyed position", () => {
    applyPmBuyToPortfolio({
      account: "acct-m",
      marketId: "mkt-m",
      outcome: "Push",
      tokenId: null,
      slug: null,
      shares: 12,
      fillPrice: 0.25,
      nowIso: T2,
    });
    // (8 × 0.5 + 12 × 0.25) / 20 = 0.35
    expect(allPositions()).toEqual(
      withTarget(["acct-m", "mkt-m", "Push", 20, 0.35, T1, T2]),
    );
  });

  it("a partial sell updates only the keyed position; a full exit deletes only that row", () => {
    expect(
      applyPmSellToPortfolio({
        account: "acct-m",
        marketId: "mkt-m",
        outcome: "Push",
        shares: 2,
        fillPrice: 0.875,
        nowIso: T2,
      }),
    ).toEqual({ realizedPnl: 0.75, fullyExited: false });
    expect(allPositions()).toEqual(
      withTarget(["acct-m", "mkt-m", "Push", 6, 0.5, T1, T2]),
    );
    expect(
      applyPmSellToPortfolio({
        account: "acct-m",
        marketId: "mkt-m",
        outcome: "Push",
        shares: 6,
        fillPrice: 0.75,
        nowIso: T3,
      }),
    ).toEqual({ realizedPnl: 1.5, fullyExited: true });
    expect(allPositions()).toEqual(withTarget(null));
  });
});
