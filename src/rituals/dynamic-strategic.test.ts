/**
 * Sync-surfacing seam in the dynamic scheduler (operator ruling 2026-08-03):
 * injection targeting, deterministic outbound append, and the consent stamp
 * firing only on a verified ≥1-channel delivery.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledTaskRow } from "./dynamic.js";

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  submitTask: vi.fn(),
  getRouter: vi.fn(),
  pickSyncJudgment: vi.fn(),
  markJudgmentSurfaced: vi.fn(),
}));

vi.mock("../db/index.js", () => ({ getDatabase: mocks.getDatabase }));
vi.mock("../dispatch/dispatcher.js", () => ({ submitTask: mocks.submitTask }));
vi.mock("../messaging/index.js", () => ({ getRouter: mocks.getRouter }));
vi.mock("../lib/v8-2/sync-surfacing.js", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../lib/v8-2/sync-surfacing.js")>();
  return {
    ...real,
    pickSyncJudgment: mocks.pickSyncJudgment,
    markJudgmentSurfaced: mocks.markJudgmentSurfaced,
  };
});

import {
  handleScheduledTaskFailure,
  handleScheduledTaskResult,
  maybeStrategicInjection,
  watchScheduledTask,
} from "./dynamic.js";

const SYNC_ID = "sync-schedule-uuid";

function makeSchedule(
  overrides: Partial<ScheduledTaskRow> = {},
): ScheduledTaskRow {
  return {
    id: 1,
    schedule_id: SYNC_ID,
    name: "Morning Sync",
    description: "Briefing narrativo",
    cron_expr: "0 8 * * *",
    tools: "[]",
    delivery: "telegram",
    email_to: null,
    email_subject: null,
    active: 1,
    last_run_at: null,
    created_at: "2026-08-03 00:00:00",
    ...overrides,
  };
}

const JUDGMENT = {
  id: 127,
  subject: "PipeSong",
  prose: "El proyecto avanza. Detalle adicional.",
  confidence: "green" as const,
  posture: "highest_leverage",
  critic_trail_json: JSON.stringify({ verdict: "approved" }),
};

/** Flush the fire-and-forget broadcast chain. */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  process.env.V82_SYNC_SCHEDULE_ID = SYNC_ID;
  // updateScheduleRun path — a permissive stub DB.
  mocks.getDatabase.mockReturnValue({
    prepare: () => ({ run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) }),
  });
  mocks.pickSyncJudgment.mockReturnValue(JUDGMENT);
});

afterEach(() => {
  delete process.env.V82_SYNC_SCHEDULE_ID;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("maybeStrategicInjection", () => {
  it("returns the injection for the designated schedule", () => {
    const inj = maybeStrategicInjection(makeSchedule());
    expect(inj?.judgmentId).toBe(127);
    expect(inj?.line).toContain("🧭 Lectura estratégica");
    expect(inj?.promptBlock).toContain("LECTURA ESTRATÉGICA DE HOY");
  });

  it("returns null when the env flag is unset", () => {
    delete process.env.V82_SYNC_SCHEDULE_ID;
    expect(maybeStrategicInjection(makeSchedule())).toBeNull();
    expect(mocks.pickSyncJudgment).not.toHaveBeenCalled();
  });

  it("returns null for any other schedule", () => {
    expect(
      maybeStrategicInjection(makeSchedule({ schedule_id: "other" })),
    ).toBeNull();
    expect(mocks.pickSyncJudgment).not.toHaveBeenCalled();
  });

  it("returns null when no judgment qualifies today", () => {
    mocks.pickSyncJudgment.mockReturnValue(null);
    expect(maybeStrategicInjection(makeSchedule())).toBeNull();
  });

  it("degrades to null (sync unaffected) when the pick throws", () => {
    mocks.pickSyncJudgment.mockImplementation(() => {
      throw new Error("no such column: surfaced_at");
    });
    expect(maybeStrategicInjection(makeSchedule())).toBeNull();
  });

  it("injects for exactly telegram delivery — email never broadcasts, 'both' can lose the line to the email-retry branch", () => {
    expect(
      maybeStrategicInjection(makeSchedule({ delivery: "email" })),
    ).toBeNull();
    expect(
      maybeStrategicInjection(makeSchedule({ delivery: "both" })),
    ).toBeNull();
    expect(mocks.pickSyncJudgment).not.toHaveBeenCalled();
  });

  it("a failed/cancelled strategic run releases the in-flight suppression (qa R2-C1)", () => {
    mocks.getRouter.mockReturnValue({
      broadcastToAll: vi.fn().mockResolvedValue({ sent: 1, failed: 0 }),
    });
    const inj = maybeStrategicInjection(makeSchedule());
    watchScheduledTask("task-cancelled", makeSchedule(), 0, inj);
    expect(maybeStrategicInjection(makeSchedule())).toBeNull(); // suppressed
    // The router's task.failed AND task.cancelled paths both land here — the
    // map entry must be consumed so tomorrow's injection isn't suppressed.
    handleScheduledTaskFailure("task-cancelled", "cancelled (cascade)");
    expect(maybeStrategicInjection(makeSchedule())).not.toBeNull();
    expect(mocks.markJudgmentSurfaced).not.toHaveBeenCalled(); // no stamp on a dead run
  });

  it("skips while another strategic run of the same schedule is in flight (no double-append)", async () => {
    mocks.getRouter.mockReturnValue({
      broadcastToAll: vi.fn().mockResolvedValue({ sent: 1, failed: 0 }),
    });
    const first = maybeStrategicInjection(makeSchedule());
    expect(first).not.toBeNull();
    watchScheduledTask("task-race", makeSchedule(), 0, first);
    // Second pick while the first run has not completed → suppressed.
    expect(maybeStrategicInjection(makeSchedule())).toBeNull();
    // After the first run completes (map entry consumed) it is allowed again.
    handleScheduledTaskResult("task-race", "Narrativa.");
    await flush();
    expect(maybeStrategicInjection(makeSchedule())).not.toBeNull();
  });
});

describe("handleScheduledTaskResult strategic delivery", () => {
  it("appends the line and stamps surfaced_at when ≥1 channel delivered", async () => {
    const broadcastToAll = vi.fn().mockResolvedValue({ sent: 1, failed: 0 });
    mocks.getRouter.mockReturnValue({ broadcastToAll });

    const inj = maybeStrategicInjection(makeSchedule());
    watchScheduledTask("task-1", makeSchedule(), 0, inj);
    handleScheduledTaskResult("task-1", "Narrativa del día.");
    await flush();

    expect(broadcastToAll).toHaveBeenCalledTimes(1);
    const outbound = broadcastToAll.mock.calls[0][0] as string;
    expect(outbound.startsWith("Narrativa del día.")).toBe(true);
    expect(outbound).toContain("🧭 Lectura estratégica");
    expect(mocks.markJudgmentSurfaced).toHaveBeenCalledWith(127);
  });

  it("does NOT stamp when the broadcast resolved with 0 sends", async () => {
    const broadcastToAll = vi.fn().mockResolvedValue({ sent: 0, failed: 1 });
    mocks.getRouter.mockReturnValue({ broadcastToAll });

    watchScheduledTask(
      "task-2",
      makeSchedule(),
      0,
      maybeStrategicInjection(makeSchedule()),
    );
    handleScheduledTaskResult("task-2", "Narrativa.");
    await flush();

    expect(broadcastToAll).toHaveBeenCalledTimes(1);
    expect(mocks.markJudgmentSurfaced).not.toHaveBeenCalled();
  });

  it("does NOT stamp when the broadcast rejects", async () => {
    const broadcastToAll = vi
      .fn()
      .mockRejectedValue(new Error("telegram down"));
    mocks.getRouter.mockReturnValue({ broadcastToAll });

    watchScheduledTask(
      "task-3",
      makeSchedule(),
      0,
      maybeStrategicInjection(makeSchedule()),
    );
    handleScheduledTaskResult("task-3", "Narrativa.");
    await flush();

    expect(mocks.markJudgmentSurfaced).not.toHaveBeenCalled();
  });

  it("leaves a non-strategic schedule's message byte-identical", async () => {
    const broadcastToAll = vi.fn().mockResolvedValue({ sent: 1, failed: 0 });
    mocks.getRouter.mockReturnValue({ broadcastToAll });

    watchScheduledTask("task-4", makeSchedule({ schedule_id: "other" }));
    handleScheduledTaskResult("task-4", "Reporte normal.");
    await flush();

    expect(broadcastToAll).toHaveBeenCalledWith("Reporte normal.");
    expect(mocks.markJudgmentSurfaced).not.toHaveBeenCalled();
  });
});
