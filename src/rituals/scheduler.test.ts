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
      agentType: "fast",
      classification: { score: 0.9, reason: "test", explicit: true },
    }),
  }),
);

// Wire mockPrepare → mockGet + mockAll
const mockAll = vi.fn().mockReturnValue([]);
mockPrepare.mockReturnValue({ get: mockGet, all: mockAll });

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

import {
  selectStaleContainersForPrune,
  startRitualScheduler,
  stopRitualScheduler,
} from "./scheduler.js";
import { createMorningBriefing } from "./morning.js";
import { createNightlyClose } from "./nightly.js";
import { createEvolutionRitual } from "./evolution.js";
import { createSignalIntelligence } from "./signal-intelligence.js";
import { createEvolutionLogEntry } from "./evolution-log.js";
import { createDayNarrative } from "./day-narrative.js";
import { createWeeklyReview } from "./weekly-review.js";

beforeEach(() => {
  vi.clearAllMocks();
  // Re-wire after clearAllMocks
  mockAll.mockReturnValue([]);
  mockPrepare.mockReturnValue({ get: mockGet, all: mockAll });
});

afterEach(() => {
  stopRitualScheduler();
});

describe("startRitualScheduler", () => {
  it("should schedule enabled rituals", () => {
    startRitualScheduler();
    // Fifteen: 7 base rituals (+ day-narrative) + 2 F9 market rituals (morning-scan + eod-scan)
    //   + 1 KB backup + 1 autonomous improvement + 1 diff digest + 1 canary + 1 memory consolidation + 1 stale-artifact-prune (v7.7.3)
    expect(mockSchedule).toHaveBeenCalledTimes(15);
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

    expect(mockStop).toHaveBeenCalledTimes(15);
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

  // F9 audit W-R2-3: scheduler-level trading-day gate for market rituals.
  // On a non-trading day the scheduler must short-circuit before submitTask —
  // even if the LLM instruction to check market_calendar is ignored.
  it("should skip market rituals on NYSE non-trading days", async () => {
    mockGet.mockReturnValue(undefined); // alreadyRanToday = false

    // Spy on the calendar module so we force !isNyseTradingDay.
    const calendarModule = await import("../finance/market-calendar.js");
    const spy = vi
      .spyOn(calendarModule, "isNyseTradingDay")
      .mockReturnValue(false);

    startRitualScheduler();

    // Find the cron callback for market-morning-scan (index may shift if other
    // rituals change; look it up by inspecting the schedule registry.)
    const { rituals } = await import("./config.js");
    const morningIdx = rituals
      .filter((r) => (r.id === "overnight-tuning" ? false : r.enabled))
      .findIndex((r) => r.id === "market-morning-scan");
    expect(morningIdx).toBeGreaterThanOrEqual(0);
    const callback = mockSchedule.mock.calls[
      morningIdx
    ][1] as () => Promise<void>;
    await callback();

    expect(mockSubmitTask).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("task templates", () => {
  it("morning briefing has correct structure", () => {
    const task = createMorningBriefing("2026-03-13");
    expect(task.title).toBe("Morning briefing — 2026-03-13");
    expect(task.agentType).toBe("fast");
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
    expect(task.agentType).toBe("fast");
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

  it("evolution log has correct structure", () => {
    const task = createEvolutionLogEntry("2026-04-05");
    expect(task.title).toBe("Evolution log — 2026-04-05");
    expect(task.agentType).toBe("fast");
    expect(task.tools).toContain("jarvis_file_read");
    expect(task.tools).toContain("file_read");
    // Mechanical count injected — no LLM estimation
    expect(task.description).toContain("Pre-computed metrics");
    expect(task.description).toContain("Conversations today: 0");
  });

  it("day narrative has correct structure", () => {
    const task = createDayNarrative("2026-04-17");
    expect(task.title).toBe("Day log narrative — 2026-04-17");
    expect(task.agentType).toBe("fast");
    expect(task.tools).toContain("jarvis_file_read");
    expect(task.tools).toContain("jarvis_file_write");
    // Source path — raw log — must be read, never modified
    expect(task.description).toContain("logs/day-logs/2026-04-17.md");
    // Companion path — narrative output
    expect(task.description).toContain("logs/day-narratives/2026-04-17.md");
    // Immutability rule must be stated in the prompt
    expect(task.description).toMatch(/inmutable|Do NOT modify/i);
  });

  it("weekly review has correct structure", () => {
    const task = createWeeklyReview("2026-04-05");
    expect(task.title).toBe("Weekly review — 2026-04-05");
    expect(task.agentType).toBe("fast");
    expect(task.tools).toContain("jarvis_file_read");
    expect(task.tools).toContain("gmail_send");
  });

  // F9 audit R1: end-to-end reachability — every tool name referenced in
  // market-ritual templates MUST resolve in the real builtin registry. This
  // catches regressions like round-1 C1 (telegram_send doesn't exist).
  // Tools registered dynamically at runtime (MCP servers, Google Workspace
  // bridge, etc.) — not part of BuiltinToolSource. Rituals are allowed to
  // reference these; the regression we're guarding against is *phantom* tool
  // names that exist nowhere (like F9 round-1 C1's `telegram_send`).
  const RUNTIME_REGISTERED_TOOLS = new Set<string>([
    "gmail_send",
    "gmail_read",
    "gmail_search",
    "gdocs_read",
    "gdocs_read_full",
    "gsheets_read",
    "gsheets_write",
    "gdrive_list",
    "calendar_list",
    "calendar_create",
  ]);

  it("market-morning-scan tools all exist in the registry", async () => {
    const { createMarketMorningScan } =
      await import("./market-morning-scan.js");
    const { ToolRegistry } = await import("../tools/registry.js");
    const { BuiltinToolSource } = await import("../tools/sources/builtin.js");
    const reg = new ToolRegistry();
    await new BuiltinToolSource().registerTools(reg);
    const tpl = createMarketMorningScan("2026-04-20");
    for (const t of tpl.tools ?? []) {
      if (RUNTIME_REGISTERED_TOOLS.has(t)) continue;
      expect(reg.get(t), `tool missing: ${t}`).toBeDefined();
    }
    for (const t of tpl.requiredTools ?? []) {
      expect(
        tpl.tools,
        `requiredTools entry ${t} must appear in tools`,
      ).toContain(t);
    }
  });

  it("market-eod-scan tools all exist in the registry", async () => {
    const { createMarketEodScan } = await import("./market-eod-scan.js");
    const { ToolRegistry } = await import("../tools/registry.js");
    const { BuiltinToolSource } = await import("../tools/sources/builtin.js");
    const reg = new ToolRegistry();
    await new BuiltinToolSource().registerTools(reg);
    const tpl = createMarketEodScan("2026-04-20");
    for (const t of tpl.tools ?? []) {
      if (RUNTIME_REGISTERED_TOOLS.has(t)) continue;
      expect(reg.get(t), `tool missing: ${t}`).toBeDefined();
    }
    for (const t of tpl.requiredTools ?? []) {
      expect(
        tpl.tools,
        `requiredTools entry ${t} must appear in tools`,
      ).toContain(t);
    }
  });
});

// v7.7.4 audit follow-up — the stale-artifact prune filter MUST NOT
// match long-running monitoring containers that share the `mc-` prefix
// (mc-grafana, mc-prometheus, mc-node-exporter). The strict
// mc-<prefix>-<13-digit-timestamp> name regex from
// generateContainerName() is the safety boundary.
describe("selectStaleContainersForPrune", () => {
  const now = Date.parse("2026-04-14T23:00:00Z");
  const oldCreatedAt = "2026-04-04 18:45:36 +0000 UTC"; // 10 days old
  const freshCreatedAt = "2026-04-14 22:30:00 +0000 UTC"; // 30 min old

  it("protects mc-grafana from deletion (the blocker from audit C1)", () => {
    const out = selectStaleContainersForPrune(
      `f7b72b232513\tmc-grafana\t${oldCreatedAt}`,
      now,
    );
    expect(out).toEqual([]);
  });

  it("protects mc-prometheus from deletion", () => {
    const out = selectStaleContainersForPrune(
      `abc123\tmc-prometheus\t${oldCreatedAt}`,
      now,
    );
    expect(out).toEqual([]);
  });

  it("protects mc-node-exporter from deletion", () => {
    const out = selectStaleContainersForPrune(
      `abc124\tmc-node-exporter\t${oldCreatedAt}`,
      now,
    );
    expect(out).toEqual([]);
  });

  it("protects any mc- prefix container without the 13-digit timestamp suffix", () => {
    const out = selectStaleContainersForPrune(
      `abc125\tmc-somebody-else\t${oldCreatedAt}\nabc126\tmc-foo\t${oldCreatedAt}`,
      now,
    );
    expect(out).toEqual([]);
  });

  it("removes runner containers matching mc-<prefix>-<13-digit-timestamp>", () => {
    const ts = "1776123456789"; // exactly 13 digits
    const out = selectStaleContainersForPrune(
      `deadbeef\tmc-task-${ts}\t${oldCreatedAt}`,
      now,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("deadbeef");
    expect(out[0]!.name).toBe(`mc-task-${ts}`);
  });

  it("removes runner containers with sanitized multi-word prefix", () => {
    const out = selectStaleContainersForPrune(
      `id1\tmc-heavy-runner-task-1776123456789\t${oldCreatedAt}`,
      now,
    );
    expect(out).toHaveLength(1);
  });

  it("does not remove runner containers younger than 6 hours", () => {
    const out = selectStaleContainersForPrune(
      `id1\tmc-task-1776123456789\t${freshCreatedAt}`,
      now,
    );
    expect(out).toEqual([]);
  });

  it("handles mixed output — grafana survives, orphan gets removed", () => {
    const mixed = [
      `f7b72b232513\tmc-grafana\t${oldCreatedAt}`,
      `deadbeef0001\tmc-task-1776000000000\t${oldCreatedAt}`,
      `deadbeef0002\tmc-prometheus\t${oldCreatedAt}`,
      `deadbeef0003\tmc-node-exporter\t${oldCreatedAt}`,
      `deadbeef0004\tmc-heavy-1776000000001\t${oldCreatedAt}`,
    ].join("\n");
    const out = selectStaleContainersForPrune(mixed, now);
    expect(out.map((c) => c.name)).toEqual([
      "mc-task-1776000000000",
      "mc-heavy-1776000000001",
    ]);
  });

  it("skips lines with malformed CreatedAt (NaN from Date.parse)", () => {
    const out = selectStaleContainersForPrune(
      `id1\tmc-task-1776000000000\tnot-a-date`,
      now,
    );
    expect(out).toEqual([]);
  });

  it("skips empty lines and lines with missing columns", () => {
    const out = selectStaleContainersForPrune(
      `\nid1\tmc-task-1776000000000\nid2\t\t${oldCreatedAt}\n`,
      now,
    );
    expect(out).toEqual([]);
  });

  it("caps the batch at PRUNE_BATCH_CAP=50 to prevent arg-list overflow", () => {
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      const ts = (1776000000000 + i).toString();
      lines.push(`id${i}\tmc-task-${ts}\t${oldCreatedAt}`);
    }
    const out = selectStaleContainersForPrune(lines.join("\n"), now);
    expect(out).toHaveLength(50);
  });

  it("rejects names with invalid chars (uppercase, underscore)", () => {
    const lines = [
      `id1\tmc-Task-1776000000000\t${oldCreatedAt}`, // uppercase T
      `id2\tmc_task-1776000000000\t${oldCreatedAt}`, // underscore
      `id3\tmc-task-177600000000a\t${oldCreatedAt}`, // letter in timestamp
    ].join("\n");
    const out = selectStaleContainersForPrune(lines, now);
    expect(out).toEqual([]);
  });
});
