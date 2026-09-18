/**
 * weekly-refresh-cron — a failed refresh must not die silently.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRefresh = vi.fn();
vi.mock("./watchlist-seed.js", () => ({
  refreshWeeklyWatchlist: () => mockRefresh(),
  formatSeedResult: (r: { symbol: string }) => r.symbol,
}));
const mockRecordFailure = vi.fn();
vi.mock("../rituals/scheduler.js", () => ({
  recordRitualFailure: (...a: unknown[]) => mockRecordFailure(...a),
}));
const mockSchedule = vi.fn(() => ({ stop: vi.fn() }));
vi.mock("../lib/cron.js", () => ({
  scheduleCron: (...a: unknown[]) => mockSchedule(...(a as [])),
}));

import {
  registerWeeklyRefreshCron,
  runWeeklyRefresh,
} from "./weekly-refresh-cron.js";

const log = { info: vi.fn(), warn: vi.fn() };
const ok = { symbol: "SPY", skipped: false, barsInserted: 1 };

describe("weekly-refresh-cron", () => {
  beforeEach(() => {
    mockRefresh.mockReset();
    mockRecordFailure.mockReset();
    mockSchedule.mockClear();
  });

  it("registers a daily 09:00 New York pass through scheduleCron", () => {
    registerWeeklyRefreshCron(log);
    expect(mockSchedule).toHaveBeenCalledWith(
      "weekly-bars-refresh",
      "0 9 * * *",
      expect.any(Function),
      { timezone: "America/New_York" },
    );
  });

  it("a clean refresh records no failure", async () => {
    mockRefresh.mockResolvedValue([ok]);
    await runWeeklyRefresh(log);
    expect(mockRecordFailure).not.toHaveBeenCalled();
  });

  it("per-symbol errors and a thrown refresh both reach recordRitualFailure", async () => {
    mockRefresh.mockResolvedValue([ok, { symbol: "QQQ", error: "AV 500" }]);
    await runWeeklyRefresh(log);
    expect(mockRecordFailure).toHaveBeenCalledTimes(1);
    expect(String(mockRecordFailure.mock.calls[0]![1])).toContain(
      "QQQ: AV 500",
    );

    mockRefresh.mockRejectedValue(new Error("db locked"));
    await runWeeklyRefresh(log);
    expect(mockRecordFailure).toHaveBeenCalledTimes(2);
  });
});
