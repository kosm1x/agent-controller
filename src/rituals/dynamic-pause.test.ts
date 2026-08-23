/**
 * Phase 0.3 (usability plan 2026-08-22, operator ruling 1): a scheduled task
 * whose text carries PAUSE_SCHEDULE_TAG deactivates its own row after
 * delivery — the model has no tool for that, the scheduler does it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledTaskRow } from "./dynamic.js";
import { PAUSE_SCHEDULE_TAG } from "../messaging/deliverable-filter.js";

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  submitTask: vi.fn(),
  getRouter: vi.fn(),
  sqlRun: vi.fn(),
}));

vi.mock("../db/index.js", () => ({ getDatabase: mocks.getDatabase }));
vi.mock("../dispatch/dispatcher.js", () => ({ submitTask: mocks.submitTask }));
vi.mock("../messaging/index.js", () => ({ getRouter: mocks.getRouter }));

import { handleScheduledTaskResult, watchScheduledTask } from "./dynamic.js";

const QUIMICA_ID = "cbd14c88-quimica";

function makeSchedule(
  overrides: Partial<ScheduledTaskRow> = {},
): ScheduledTaskRow {
  return {
    id: 3,
    schedule_id: QUIMICA_ID,
    name: "Química Básica — Tarjeta de Estudio Diaria",
    description: "Envía la tarjeta…",
    cron_expr: "0 13 * * *",
    tools: "[]",
    delivery: "telegram",
    email_to: null,
    email_subject: null,
    active: 1,
    last_run_at: null,
    created_at: "2026-08-01 00:00:00",
    ...overrides,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const executed: string[] = [];

beforeEach(() => {
  executed.length = 0;
  mocks.getDatabase.mockReturnValue({
    prepare: (sql: string) => ({
      run: (...args: unknown[]) => {
        executed.push(sql);
        mocks.sqlRun(sql, ...args);
        return { changes: 1 };
      },
      get: vi.fn(),
      all: vi.fn(() => []),
    }),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("scheduled-task pause sentinel", () => {
  it("deactivates the schedule and still broadcasts the question when the text carries the tag", async () => {
    const broadcastToAll = vi.fn().mockResolvedValue({ sent: 1, failed: 0 });
    mocks.getRouter.mockReturnValue({ broadcastToAll });

    watchScheduledTask("task-q13", makeSchedule());
    handleScheduledTaskResult(
      "task-q13",
      `¿Pausamos las tarjetas de química? Responde sí para pausar o contesta la tarjeta del Día 10 para seguir. ${PAUSE_SCHEDULE_TAG}`,
    );
    await flush();

    expect(
      executed.some((sql) => /UPDATE scheduled_tasks SET active = 0/.test(sql)),
    ).toBe(true);
    expect(mocks.sqlRun).toHaveBeenCalledWith(
      expect.stringMatching(/SET active = 0/),
      QUIMICA_ID,
    );
    expect(broadcastToAll).toHaveBeenCalledTimes(1);
    // The tag travels to broadcastToAll, where the deliverable filter strips it.
    expect(broadcastToAll.mock.calls[0][0]).toContain("¿Pausamos");
  });

  it("does nothing to the row when the tag is absent", async () => {
    const broadcastToAll = vi.fn().mockResolvedValue({ sent: 1, failed: 0 });
    mocks.getRouter.mockReturnValue({ broadcastToAll });

    watchScheduledTask("task-q1", makeSchedule());
    handleScheduledTaskResult("task-q1", "Día 11: Enlaces iónicos. …");
    await flush();

    expect(
      executed.some((sql) => /SET active = 0/.test(sql)),
    ).toBe(false);
    expect(broadcastToAll).toHaveBeenCalledTimes(1);
  });
});
