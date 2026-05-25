/**
 * Judgment prompt renderer tests (V8.1 Phase 6 B2).
 */

import { describe, it, expect } from "vitest";
import type { CohortMember } from "../cohort/self-defining.js";
import type { DetectionSignal } from "../detection/signals.js";
import {
  renderJudgmentPrompt,
  type JudgmentPromptInput,
} from "./judgment-prompt.js";

function cohortMember(label: string): CohortMember {
  return {
    id: 1,
    member_id: `project:${label}`,
    member_kind: "project",
    label,
    source_ref: `ref/${label}`,
    salience: 5,
    signals: {},
    first_seen_at: "2026-05-01T00:00:00.000Z",
    last_rolled_at: "2026-05-20T00:00:00.000Z",
    active: true,
  };
}

const stalledSignal: DetectionSignal = {
  kind: "stalled_task",
  severity: "at_risk",
  summary: "Task X stalled 12d",
  taskId: "t-1",
  title: "Task X",
  status: "blocked",
  priority: "high",
  daysSinceActivity: 12,
};

const blockerSignal: DetectionSignal = {
  kind: "recurring_blocker",
  severity: "at_risk",
  summary: "Blocker recurred across 3 tasks",
  blockerSignature: "abc",
  taskCount: 3,
  taskIds: ["t-1", "t-2", "t-3"],
  firstSeenAt: "2026-05-10T00:00:00.000Z",
  lastSeenAt: "2026-05-23T00:00:00.000Z",
};

function makeInput(
  overrides: Partial<JudgmentPromptInput> = {},
): JudgmentPromptInput {
  return {
    surface: "morning",
    activeObjectives: [
      { id: "NorthStar/objectives/x.md", title: "Obj X", description: "do x" },
    ],
    cohort: [cohortMember("EurekaMD")],
    generalEvents: [
      { eventId: "evt-1", title: "Sprint", summary: "the beta sprint" },
    ],
    episodicSamples: [{ eventId: "evt-1", text: "a chunk" }],
    detectionSignals: [stalledSignal, blockerSignal],
    recentlyDiscarded: [],
    evidenceSources: ["tasks table", "NorthStar objectives", "general_events"],
    ...overrides,
  };
}

describe("renderJudgmentPrompt", () => {
  it("renders the surface in upper case", () => {
    expect(renderJudgmentPrompt(makeInput({ surface: "weekly" }))).toContain(
      "WEEKLY briefing",
    );
  });

  it("includes objectives, cohort, general events, and episodic samples", () => {
    const p = renderJudgmentPrompt(makeInput());
    expect(p).toContain("Obj X (NorthStar/objectives/x.md): do x");
    expect(p).toContain("[proyecto] EurekaMD");
    expect(p).toContain("Sprint: the beta sprint");
    expect(p).toContain("[evt-1] a chunk");
  });

  it("groups detection signals under their kind headings", () => {
    const p = renderJudgmentPrompt(makeInput());
    const stalledIdx = p.indexOf("Stalled tasks:");
    const blockerIdx = p.indexOf("Recurring blockers:");
    expect(p).toContain("Task X stalled 12d");
    expect(p).toContain("Blocker recurred across 3 tasks");
    // The stalled summary sits under the Stalled heading, the blocker under its own.
    expect(p.indexOf("Task X stalled 12d")).toBeGreaterThan(stalledIdx);
    expect(p.indexOf("Task X stalled 12d")).toBeLessThan(blockerIdx);
    expect(p.indexOf("Blocker recurred across 3 tasks")).toBeGreaterThan(
      blockerIdx,
    );
  });

  it("renders '(none)' for an empty input section", () => {
    const p = renderJudgmentPrompt(
      makeInput({ detectionSignals: [], generalEvents: [] }),
    );
    expect(p).toContain("(none)");
  });

  it("renders the discarded-signals list when populated", () => {
    const p = renderJudgmentPrompt(
      makeInput({ recentlyDiscarded: ["t-99 stale deadline"] }),
    );
    expect(p).toContain("t-99 stale deadline");
  });

  it("instructs strict JSON output with the judgment shape", () => {
    const p = renderJudgmentPrompt(makeInput());
    expect(p).toContain("Return ONLY a JSON object");
    expect(p).toContain('"judgments"');
    expect(p).toContain('posture "highest_leverage"');
  });

  it("does NOT ask the LLM for signal_id or highest_leverage_pick (A2)", () => {
    // The model cannot reliably generate UUIDs; constructBriefing assigns
    // signal_id and derives the pick. Asking the LLM for them produced the
    // 2026-05-22 morning-briefing schema failure.
    const p = renderJudgmentPrompt(makeInput());
    expect(p).not.toContain('"signal_id"');
    expect(p).not.toContain('"highest_leverage_pick"');
    expect(p).toContain("the system assigns judgment identity");
  });

  it("renders the evidence sources as a numbered list", () => {
    const p = renderJudgmentPrompt(
      makeInput({ evidenceSources: ["tasks table", "cohort"] }),
    );
    expect(p).toContain("EVIDENCE SOURCES");
    expect(p).toContain("[0] tasks table");
    expect(p).toContain("[1] cohort");
  });

  // 2026-05-25: the morning briefing rendered 6 tasks across May 14/19/22/23
  // and the LLM judge wrote "23-24 mayo consecutivos". The fix surfaces the
  // temporal spread so the LLM has the ground truth to reason about.
  describe("recurring_blocker temporal-spread rendering", () => {
    it("includes first_seen, last_seen, and span_days for blocker signals", () => {
      const p = renderJudgmentPrompt(makeInput());
      // blockerSignal: 2026-05-10 → 2026-05-23 = 13 whole days = "spanning 14 days"
      expect(p).toContain("first_seen=2026-05-10T00:00:00.000Z");
      expect(p).toContain("last_seen=2026-05-23T00:00:00.000Z");
      expect(p).toContain("spanning 14 days");
    });

    it("renders 'same day' when first_seen == last_seen", () => {
      const sameDay: DetectionSignal = {
        ...blockerSignal,
        firstSeenAt: "2026-05-23T00:00:00.000Z",
        lastSeenAt: "2026-05-23T03:00:00.000Z",
      };
      const p = renderJudgmentPrompt(
        makeInput({ detectionSignals: [sameDay] }),
      );
      expect(p).toContain("same day");
    });

    it("renders 'spanning 2 days' when first_seen is 1 day before last_seen", () => {
      const twoDays: DetectionSignal = {
        ...blockerSignal,
        firstSeenAt: "2026-05-22T00:00:00.000Z",
        lastSeenAt: "2026-05-23T00:00:00.000Z",
      };
      const p = renderJudgmentPrompt(
        makeInput({ detectionSignals: [twoDays] }),
      );
      expect(p).toContain("spanning 2 days");
    });

    it("falls back to 'same day' when a timestamp is unparseable (R3 audit fold)", () => {
      const garbage: DetectionSignal = {
        ...blockerSignal,
        firstSeenAt: "not-a-date",
        lastSeenAt: "2026-05-23T00:00:00.000Z",
      };
      const p = renderJudgmentPrompt(
        makeInput({ detectionSignals: [garbage] }),
      );
      // Under-reports rather than mis-parses: the failure mode is visible
      // because the bracket still renders with the literal strings.
      expect(p).toContain("first_seen=not-a-date");
      expect(p).toContain("same day");
    });

    it("accepts SQLite naive-UTC timestamps (no 'Z' suffix)", () => {
      const sqliteTs: DetectionSignal = {
        ...blockerSignal,
        firstSeenAt: "2026-05-15 03:23:32",
        lastSeenAt: "2026-05-23 14:12:05",
      };
      const p = renderJudgmentPrompt(
        makeInput({ detectionSignals: [sqliteTs] }),
      );
      expect(p).toContain("first_seen=2026-05-15 03:23:32");
      expect(p).toContain("last_seen=2026-05-23 14:12:05");
      // 8d 10h gap → floor = 8 whole days → "spanning 9 days"
      expect(p).toContain("spanning 9 days");
    });
  });
});
