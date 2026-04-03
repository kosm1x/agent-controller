/**
 * Alert router tests — tier evaluation, cross-domain correlation, dedup.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { Delta } from "./types.js";

const mockDb = {
  prepare: vi.fn().mockReturnValue({
    run: vi.fn().mockReturnValue({ lastInsertRowid: 1, changes: 1 }),
    get: vi.fn().mockReturnValue(undefined),
    all: vi.fn().mockReturnValue([]),
  }),
};

vi.mock("../db/index.js", () => ({
  getDatabase: () => mockDb,
  writeWithRetry: <T>(fn: () => T): T => fn(),
}));

vi.mock("./signal-store.js", () => ({
  contentHash: (s: string) => s.slice(0, 16).padEnd(16, "0"),
}));

import {
  evaluateDeltas,
  shouldSuppress,
  createAlert,
  getRecentAlerts,
} from "./alert-router.js";

describe("alert-router", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockDb.prepare.mockReturnValue({
      run: vi.fn().mockReturnValue({ lastInsertRowid: 1, changes: 1 }),
      get: vi.fn().mockReturnValue(undefined),
      all: vi.fn().mockReturnValue([]),
    });
  });

  describe("evaluateDeltas", () => {
    it("returns empty for no deltas", () => {
      expect(evaluateDeltas([])).toEqual([]);
    });

    it("maps critical delta to FLASH tier", () => {
      const deltas: Delta[] = [
        {
          source: "usgs",
          key: "quakes_5plus",
          previous: 1,
          current: 10,
          changeRatio: 4.5,
          severity: "critical",
        },
      ];
      const alerts = evaluateDeltas(deltas);
      expect(alerts).toHaveLength(1);
      expect(alerts[0].tier).toBe("FLASH");
    });

    it("maps high delta to PRIORITY tier", () => {
      const deltas: Delta[] = [
        {
          source: "frankfurter",
          key: "MXN",
          previous: 17,
          current: 18,
          changeRatio: 2.5,
          severity: "high",
        },
      ];
      const alerts = evaluateDeltas(deltas);
      expect(alerts).toHaveLength(1);
      expect(alerts[0].tier).toBe("PRIORITY");
    });

    it("maps single moderate delta to ROUTINE tier", () => {
      const deltas: Delta[] = [
        {
          source: "nws",
          key: "active_warnings",
          previous: 5,
          current: 15,
          changeRatio: 1.5,
          severity: "moderate",
        },
      ];
      const alerts = evaluateDeltas(deltas);
      expect(alerts).toHaveLength(1);
      expect(alerts[0].tier).toBe("ROUTINE");
    });

    it("escalates 3+ moderate in same domain to PRIORITY", () => {
      const deltas: Delta[] = [
        {
          source: "frankfurter",
          key: "MXN",
          previous: 17,
          current: 17.5,
          changeRatio: 1.5,
          severity: "moderate",
        },
        {
          source: "frankfurter",
          key: "EUR",
          previous: 0.92,
          current: 0.94,
          changeRatio: 1.2,
          severity: "moderate",
        },
        {
          source: "coingecko",
          key: "bitcoin",
          previous: 65000,
          current: 69000,
          changeRatio: 1.3,
          severity: "moderate",
        },
      ];
      const alerts = evaluateDeltas(deltas);
      // All 3 are financial domain → batch PRIORITY
      const priority = alerts.filter((a) => a.tier === "PRIORITY");
      expect(priority.length).toBeGreaterThanOrEqual(1);
    });

    it("escalates cross-domain financial+geopolitical to FLASH", () => {
      const deltas: Delta[] = [
        {
          source: "frankfurter",
          key: "MXN",
          previous: 17,
          current: 22,
          changeRatio: 3.5,
          severity: "critical",
        },
        {
          source: "gdelt",
          key: "conflict_articles",
          previous: 10,
          current: 200,
          changeRatio: 3.8,
          severity: "critical",
        },
      ];
      const alerts = evaluateDeltas(deltas);
      const flash = alerts.filter((a) => a.tier === "FLASH");
      expect(flash.length).toBe(2); // Both escalated to FLASH
    });
  });

  describe("shouldSuppress", () => {
    it("returns false when no recent alerts exist", () => {
      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue(undefined),
        run: vi.fn(),
        all: vi.fn(),
      });
      const result = shouldSuppress({
        tier: "FLASH",
        domain: "weather",
        title: "test",
        body: "test",
        signalIds: [],
        contentHash: "abc123",
      });
      expect(result).toBe(false);
    });

    it("returns true when duplicate exists within window", () => {
      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue({ id: 1, cooldown_until: null }),
        run: vi.fn(),
        all: vi.fn(),
      });
      const result = shouldSuppress({
        tier: "FLASH",
        domain: "weather",
        title: "test",
        body: "test",
        signalIds: [],
        contentHash: "abc123",
      });
      expect(result).toBe(true);
    });
  });

  describe("createAlert", () => {
    it("inserts alert and returns ID", () => {
      const runFn = vi
        .fn()
        .mockReturnValue({ lastInsertRowid: 42, changes: 1 });
      const getFn = vi.fn().mockReturnValue({ cnt: 0 });
      mockDb.prepare.mockReturnValue({
        run: runFn,
        get: getFn,
        all: vi.fn(),
      });

      const id = createAlert({
        tier: "FLASH",
        domain: "weather",
        title: "test alert",
        body: "test body",
        signalIds: [1, 2],
        contentHash: "hash123",
      });
      expect(id).toBe(42);
    });
  });

  describe("getRecentAlerts", () => {
    it("queries with hour filter", () => {
      const allFn = vi.fn().mockReturnValue([]);
      mockDb.prepare.mockReturnValue({
        all: allFn,
        get: vi.fn(),
        run: vi.fn(),
      });
      getRecentAlerts(24);
      expect(allFn).toHaveBeenCalledWith(24, 20);
    });

    it("applies tier filter", () => {
      const allFn = vi.fn().mockReturnValue([]);
      mockDb.prepare.mockReturnValue({
        all: allFn,
        get: vi.fn(),
        run: vi.fn(),
      });
      getRecentAlerts(24, "FLASH", 5);
      expect(allFn).toHaveBeenCalledWith(24, "FLASH", 5);
    });
  });
});
