/**
 * Alert delivery tests — formatting and delivery of FLASH/PRIORITY alerts.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

const mockGetUndelivered = vi.fn().mockReturnValue([]);
const mockMarkDelivered = vi.fn();

vi.mock("./alert-router.js", () => ({
  getUndeliveredAlerts: (...args: unknown[]) => mockGetUndelivered(...args),
  markDelivered: (...args: unknown[]) => mockMarkDelivered(...args),
}));

import { deliverPendingAlerts } from "./alert-delivery.js";

describe("alert-delivery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockGetUndelivered.mockReturnValue([]);
    mockMarkDelivered.mockReset();
  });

  it("returns 0 when no alerts pending", async () => {
    const broadcast = vi.fn().mockResolvedValue(undefined);
    const count = await deliverPendingAlerts(broadcast);
    expect(count).toBe(0);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("delivers FLASH alerts via broadcast and marks delivered", async () => {
    mockGetUndelivered.mockImplementation((tier: string) =>
      tier === "FLASH"
        ? [
            {
              id: 1,
              tier: "FLASH",
              domain: "weather",
              title: "🔴 usgs/quakes_5plus: critical",
              body: "Magnitude 7.2 earthquake",
              signals_json: "[]",
              content_hash: "abc",
              cooldown_until: null,
              created_at: "2026-04-03T22:00:00Z",
              delivered_at: null,
              delivered_via: null,
            },
          ]
        : [],
    );

    const broadcast = vi.fn().mockResolvedValue(undefined);
    const count = await deliverPendingAlerts(broadcast);

    expect(count).toBe(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[0][0]).toContain("FLASH");
    expect(mockMarkDelivered).toHaveBeenCalledWith(1, "telegram");
  });

  it("handles broadcast failure gracefully", async () => {
    mockGetUndelivered.mockImplementation((tier: string) =>
      tier === "FLASH"
        ? [
            {
              id: 2,
              tier: "FLASH",
              domain: "cyber",
              title: "test",
              body: "test",
              signals_json: "[]",
              content_hash: "def",
              cooldown_until: null,
              created_at: "2026-04-03T22:00:00Z",
              delivered_at: null,
              delivered_via: null,
            },
          ]
        : [],
    );

    const broadcast = vi.fn().mockRejectedValue(new Error("network error"));
    const count = await deliverPendingAlerts(broadcast);

    expect(count).toBe(0);
    expect(mockMarkDelivered).not.toHaveBeenCalled();
  });

  it("batches multiple alerts of same tier into one message", async () => {
    mockGetUndelivered.mockImplementation((tier: string) =>
      tier === "PRIORITY"
        ? [
            {
              id: 3,
              tier: "PRIORITY",
              domain: "financial",
              title: "alert 1",
              body: "body 1",
              signals_json: "[]",
              content_hash: "a",
              cooldown_until: null,
              created_at: "2026-04-03T22:00:00Z",
              delivered_at: null,
              delivered_via: null,
            },
            {
              id: 4,
              tier: "PRIORITY",
              domain: "financial",
              title: "alert 2",
              body: "body 2",
              signals_json: "[]",
              content_hash: "b",
              cooldown_until: null,
              created_at: "2026-04-03T22:00:00Z",
              delivered_at: null,
              delivered_via: null,
            },
          ]
        : [],
    );

    const broadcast = vi.fn().mockResolvedValue(undefined);
    const count = await deliverPendingAlerts(broadcast);

    expect(count).toBe(2);
    expect(broadcast).toHaveBeenCalledTimes(1); // batched into one message
    expect(mockMarkDelivered).toHaveBeenCalledTimes(2);
  });
});
