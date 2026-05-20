/**
 * Morning-surface trigger tests (V8.1 Phase 7 + Phase 8 delivery).
 * `constructBriefing` and the Phase 8 delivery module are mocked — no real
 * inference, no real channels; `trigger_runs` is a real in-memory DB.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";

const constructMock = vi.fn();
vi.mock("../briefing/construct.js", () => ({
  constructBriefing: (...a: unknown[]) => constructMock(...a),
}));

const deliverMock = vi.fn();
const deliveryEnabledMock = vi.fn(() => false);
vi.mock("../briefing/delivery.js", () => ({
  deliverBriefing: (...a: unknown[]) => deliverMock(...a),
  isBriefingDeliveryEnabled: () => deliveryEnabledMock(),
}));

import { runMorningSurface } from "./morning-surface.js";

function triggerRunRows(): { outcome: string; detail: string | null }[] {
  return getDatabase()
    .prepare(
      `SELECT outcome, detail FROM trigger_runs WHERE trigger_kind='cron_morning'`,
    )
    .all() as { outcome: string; detail: string | null }[];
}

beforeEach(() => {
  initDatabase(":memory:");
  constructMock.mockReset();
  deliverMock.mockReset();
  deliveryEnabledMock.mockReturnValue(false); // delivery flag off by default
});

afterEach(() => {
  closeDatabase();
});

describe("runMorningSurface", () => {
  it("constructs a briefing for the 'morning' surface and records a fired run", async () => {
    constructMock.mockResolvedValue({
      ok: true,
      briefing: {
        briefing_id: "b-1",
        critic_verdict: "pass",
        judgments: [{}, {}],
      },
    });
    const result = await runMorningSurface();
    expect(constructMock).toHaveBeenCalledWith({ surface: "morning" });
    expect(result).toEqual({ ok: true, briefingId: "b-1" });
    const rows = triggerRunRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("fired");
    expect(rows[0].detail).toContain("b-1");
  });

  it("records a failed run when construction returns a typed failure", async () => {
    constructMock.mockResolvedValue({
      ok: false,
      stage: "schema",
      detail: "judgments: too short",
    });
    const result = await runMorningSurface();
    expect(result.ok).toBe(false);
    expect(result.failureStage).toBe("schema");
    const rows = triggerRunRows();
    expect(rows[0].outcome).toBe("failed");
    expect(rows[0].detail).toBe("schema");
  });

  it("catches a thrown error and records a failed run", async () => {
    constructMock.mockRejectedValue(new Error("inference adapter exploded"));
    const result = await runMorningSurface();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("inference adapter exploded");
    expect(triggerRunRows()[0].outcome).toBe("failed");
  });

  it("does NOT deliver while the delivery flag is off (default)", async () => {
    constructMock.mockResolvedValue({
      ok: true,
      briefing: { briefing_id: "b-1", critic_verdict: "pass", judgments: [{}] },
    });
    const result = await runMorningSurface();
    expect(result.delivered).toBeUndefined();
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it("delivers the briefing when the delivery flag is on", async () => {
    deliveryEnabledMock.mockReturnValue(true);
    deliverMock.mockResolvedValue({ delivered: true });
    constructMock.mockResolvedValue({
      ok: true,
      briefing: { briefing_id: "b-9", critic_verdict: "pass", judgments: [{}] },
    });
    const result = await runMorningSurface();
    expect(deliverMock).toHaveBeenCalledWith("b-9");
    expect(result.delivered).toBe(true);
    expect(triggerRunRows()[0].detail).toContain("delivered");
  });
});
