import { describe, expect, it } from "vitest";
import {
  isFill,
  isOrderReject,
  type Fill,
  type OrderReject,
} from "./venue-types.js";

describe("venue-types guards", () => {
  const fill: Fill = {
    fillId: "fid-1",
    clientOrderId: "coid-1",
    symbol: "AAPL",
    side: "buy",
    quantity: 10,
    price: 200,
    grossNotional: 2000,
    commission: 0,
    slippageBps: 5,
    filledAt: "2026-04-20T12:00:00Z",
  };

  const reject: OrderReject = {
    clientOrderId: "coid-2",
    reason: "insufficient_cash",
    rejectedAt: "2026-04-20T12:00:00Z",
  };

  it("isFill identifies fills", () => {
    expect(isFill(fill)).toBe(true);
    expect(isFill(reject)).toBe(false);
  });

  it("isOrderReject identifies rejects", () => {
    expect(isOrderReject(reject)).toBe(true);
    expect(isOrderReject(fill)).toBe(false);
  });
});
