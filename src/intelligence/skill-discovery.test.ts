/**
 * Skill discovery tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../db/task-outcomes.js", () => ({
  queryOutcomes: vi.fn().mockReturnValue([]),
}));

vi.mock("../db/skills.js", () => ({
  listSkills: vi.fn().mockReturnValue([]),
}));

vi.mock("../memory/index.js", () => ({
  getMemoryService: () => ({
    backend: "sqlite",
    retain: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../dispatch/dispatcher.js", () => ({
  submitTask: vi.fn().mockResolvedValue({
    taskId: "auto-skill-test",
    agentType: "fast",
    classification: {},
  }),
}));

import { queryOutcomes } from "../db/task-outcomes.js";
import { listSkills } from "../db/skills.js";
import { submitTask } from "../dispatch/dispatcher.js";
import {
  detectRecurringPatterns,
  resetDiscoveryRateLimit,
} from "./skill-discovery.js";

describe("skill-discovery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    resetDiscoveryRateLimit();
  });

  it("should not propose when fewer than 3 outcomes", async () => {
    vi.mocked(queryOutcomes).mockReturnValue([
      {
        id: 1,
        task_id: "t1",
        classified_as: "fast",
        ran_on: "fast",
        tools_used: '["jarvis_file_read","jarvis_file_write"]',
        duration_ms: 2000,
        success: 1,
        feedback_signal: "none",
        tags: "[]",
        created_at: "2026-03-16",
      },
    ]);

    await detectRecurringPatterns();
    // No error, no proposal (insufficient data)
  });

  it("should detect recurring pattern with 3+ occurrences", async () => {
    const outcome = {
      id: 1,
      task_id: "t1",
      classified_as: "fast",
      ran_on: "fast",
      tools_used: '["project_list","jarvis_file_read"]',
      duration_ms: 2000,
      success: 1,
      feedback_signal: "none",
      tags: '["messaging"]',
      created_at: "2026-03-16",
    };

    vi.mocked(queryOutcomes).mockReturnValue([
      { ...outcome, id: 1, task_id: "t1" },
      { ...outcome, id: 2, task_id: "t2" },
      { ...outcome, id: 3, task_id: "t3" },
    ]);

    vi.mocked(listSkills).mockReturnValue([]);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await detectRecurringPatterns();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[skill-discovery] Proposing skill"),
    );
    consoleSpy.mockRestore();

    // The Auto-skill task MUST go to the fast HOST runner — skill_save/skill_list
    // are host-only tools (write the host mc.db) and are NOT registered in the
    // nanoclaw sandbox, so "auto" (which the coding-signal "git" in the pattern
    // would route to nanoclaw) can never persist a skill. Regression guard for
    // feedback_skill_discovery_host_tool_misroute.
    expect(submitTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining("Auto-skill:"),
        agentType: "fast",
        tools: ["skill_save", "skill_list"],
        tags: ["internal", "skill-suggestion"],
      }),
    );
  });

  it("should not propose if skill already exists with same tools", async () => {
    const outcome = {
      id: 1,
      task_id: "t1",
      classified_as: "fast",
      ran_on: "fast",
      tools_used: '["project_list","jarvis_file_read"]',
      duration_ms: 2000,
      success: 1,
      feedback_signal: "none",
      tags: "[]",
      created_at: "2026-03-16",
    };

    vi.mocked(queryOutcomes).mockReturnValue([
      { ...outcome, id: 1 },
      { ...outcome, id: 2 },
      { ...outcome, id: 3 },
    ]);

    vi.mocked(listSkills).mockReturnValue([
      {
        id: 1,
        skill_id: "existing",
        name: "review",
        description: "test",
        trigger_text: "test",
        steps: "[]",
        tools: '["project_list","jarvis_file_read"]',
        use_count: 5,
        success_count: 4,
        source: "manual",
        active: 1,
        created_at: "",
        updated_at: "",
      },
    ]);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await detectRecurringPatterns();

    // Should NOT propose — existing skill covers the same tools
    const proposalCalls = consoleSpy.mock.calls.filter((c) =>
      String(c[0]).includes("Proposing"),
    );
    expect(proposalCalls).toHaveLength(0);
    consoleSpy.mockRestore();
  });

  it("should respect 24h rate limit", async () => {
    const outcome = {
      id: 1,
      task_id: "t1",
      classified_as: "fast",
      ran_on: "fast",
      tools_used: '["project_list","jarvis_file_read"]',
      duration_ms: 2000,
      success: 1,
      feedback_signal: "none",
      tags: "[]",
      created_at: "2026-03-16",
    };

    vi.mocked(queryOutcomes).mockReturnValue([
      { ...outcome, id: 1 },
      { ...outcome, id: 2 },
      { ...outcome, id: 3 },
    ]);
    vi.mocked(listSkills).mockReturnValue([]);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // First call proposes
    await detectRecurringPatterns();
    const firstCalls = consoleSpy.mock.calls.filter((c) =>
      String(c[0]).includes("Proposing"),
    );
    expect(firstCalls).toHaveLength(1);

    // Second call within 24h — rate limited
    await detectRecurringPatterns();
    const secondCalls = consoleSpy.mock.calls.filter((c) =>
      String(c[0]).includes("Proposing"),
    );
    expect(secondCalls).toHaveLength(1); // Still just the first one

    consoleSpy.mockRestore();
  });
});
