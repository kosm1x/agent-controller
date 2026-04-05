/**
 * Ritual scheduler tests — verify idempotency, scheduling, and task templates.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hoist mocks so vi.mock factories can reference them
const { mockSchedule, mockGet, mockPrepare, mockSubmitTask } = vi.hoisted(
  () => ({
    mockSchedule: vi.fn().mockReturnValue({ stop: vi.fn() }),
    mockGet: vi.fn(),
    mockPrepare: vi.fn().mockReturnValue({ get: vi.fn() }),
    mockSubmitTask: vi.fn().mockResolvedValue({
      taskId: "test-task-id",
      agentType: "heavy",
      classification: { score: 0.9, reason: "test", explicit: true },
    }),
  }),
);

// Wire mockPrepare → mockGet
mockPrepare.mockReturnValue({ get: mockGet });

vi.mock("node-cron", () => ({
  default: { schedule: mockSchedule },
  schedule: mockSchedule,
}));

vi.mock("../db/index.js", () => ({
  getDatabase: () => ({ prepare: mockPrepare }),
}));

vi.mock("../dispatch/dispatcher.js", () => ({
  submitTask: mockSubmitTask,
}));

vi.mock("../config.js", () => ({
  getConfig: () => ({
    tuningEnabled: false,
  }),
}));

import { startRitualScheduler, stopRitualScheduler } from "./scheduler.js";
import { createMorningBriefing } from "./morning.js";
import { createNightlyClose } from "./nightly.js";
import { createEvolutionRitual } from "./evolution.js";
import { createSignalIntelligence } from "./signal-intelligence.js";

beforeEach(() => {
  vi.clearAllMocks();
  // Re-wire after clearAllMocks
  mockPrepare.mockReturnValue({ get: mockGet });
});

afterEach(() => {
  stopRitualScheduler();
});

describe("startRitualScheduler", () => {
  it("should schedule enabled rituals", () => {
    startRitualScheduler();
    // Six rituals: signal-intelligence + morning + nightly + skill-evolution + evolution-log + weekly-review
    expect(mockSchedule).toHaveBeenCalledTimes(6);
  });

  it("should pass timezone to cron.schedule", () => {
    startRitualScheduler();
    const calls = mockSchedule.mock.calls;
    for (const call of calls) {
      expect(call[2]).toEqual(
        expect.objectContaining({ timezone: expect.any(String) }),
      );
    }
  });
});

describe("stopRitualScheduler", () => {
  it("should stop all scheduled jobs", () => {
    const mockStop = vi.fn();
    mockSchedule.mockReturnValue({ stop: mockStop });

    startRitualScheduler();
    stopRitualScheduler();

    expect(mockStop).toHaveBeenCalledTimes(6);
  });
});

describe("idempotency", () => {
  it("should skip if ritual already ran today", async () => {
    // Simulate existing task found in DB
    mockGet.mockReturnValue({ 1: 1 });

    startRitualScheduler();

    // Extract the callback from the first cron.schedule call and execute it
    const callback = mockSchedule.mock.calls[0][1] as () => Promise<void>;
    await callback();

    expect(mockSubmitTask).not.toHaveBeenCalled();
  });

  it("should submit if ritual has not run today", async () => {
    // No existing task
    mockGet.mockReturnValue(undefined);

    startRitualScheduler();

    const callback = mockSchedule.mock.calls[0][1] as () => Promise<void>;
    await callback();

    expect(mockSubmitTask).toHaveBeenCalledTimes(1);
  });
});

describe("task templates", () => {
  it("morning briefing has correct structure", () => {
    const task = createMorningBriefing("2026-03-13");
    expect(task.title).toBe("Morning briefing — 2026-03-13");
    expect(task.agentType).toBe("heavy");
    expect(task.tools).toContain("jarvis_file_read");
    expect(task.description).toContain("Jarvis");
    expect(task.description).toContain("Eisenhower");
  });

  it("nightly close has correct structure", () => {
    const task = createNightlyClose("2026-03-13");
    expect(task.title).toBe("Nightly close — 2026-03-13");
    expect(task.agentType).toBe("fast");
    expect(task.tools).toContain("jarvis_file_read");
    expect(task.tools).toContain("gmail_send");
    expect(task.description).toContain("Jarvis");
    expect(task.description).toContain("reflection");
    expect(task.description).toContain("Do NOT");
  });

  it("signal intelligence has correct structure", () => {
    const task = createSignalIntelligence("2026-03-25");
    expect(task.title).toBe("Signal intelligence — 2026-03-25");
    expect(task.agentType).toBe("heavy");
    expect(task.tools).toContain("exa_search");
    expect(task.tools).toContain("web_search");
    expect(task.tools).toContain("user_fact_set");
    expect(task.tools).toContain("gmail_send");
    expect(task.requiredTools).toContain("exa_search");
    expect(task.description).toContain("signal");
  });

  it("evolution ritual has correct structure", () => {
    const task = createEvolutionRitual("2026-03-18");
    expect(task.title).toBe("Skill evolution — 2026-03-18");
    expect(task.agentType).toBe("heavy");
    expect(task.tools).toContain("evolution_get_data");
    expect(task.tools).toContain("evolution_deactivate_skill");
    expect(task.tools).toContain("memory_store");
    expect(task.description).toContain("evolution mode");
  });
});
