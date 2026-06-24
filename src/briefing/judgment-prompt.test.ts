/**
 * Judgment prompt renderer tests (V8.1 Phase 6 B2).
 *
 * As of 2026-06-23 the prompt renders day-log-grounded `stalled_project`
 * signals + active projects (NorthStar/task-table detectors retired).
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

const stalledProjectSignal: DetectionSignal = {
  kind: "stalled_project",
  severity: "info",
  summary: 'Project "Salones WA" last mentioned in the day-log 13d ago',
  slug: "salones-wa",
  name: "Salones WA",
  daysSinceMention: 13,
};

function makeInput(
  overrides: Partial<JudgmentPromptInput> = {},
): JudgmentPromptInput {
  return {
    surface: "morning",
    activeObjectives: [
      {
        id: "salones-wa",
        title: "Salones WA",
        description: "salon booking bot",
      },
    ],
    cohort: [cohortMember("EurekaMD")],
    generalEvents: [
      { eventId: "evt-1", title: "Sprint", summary: "the beta sprint" },
    ],
    episodicSamples: [{ eventId: "evt-1", text: "a chunk" }],
    detectionSignals: [stalledProjectSignal],
    recentlyDiscarded: [],
    evidenceSources: ["day-log", "active projects", "general_events"],
    ...overrides,
  };
}

describe("renderJudgmentPrompt", () => {
  it("renders the surface in upper case", () => {
    expect(renderJudgmentPrompt(makeInput({ surface: "weekly" }))).toContain(
      "WEEKLY briefing",
    );
  });

  it("includes active projects, cohort, general events, and episodic samples", () => {
    const p = renderJudgmentPrompt(makeInput());
    expect(p).toContain("Salones WA (salones-wa): salon booking bot");
    expect(p).toContain("[proyecto] EurekaMD");
    expect(p).toContain("Sprint: the beta sprint");
    expect(p).toContain("[evt-1] a chunk");
  });

  it("renders stalled_project signals under the Stalled projects heading", () => {
    const p = renderJudgmentPrompt(makeInput());
    const heading = p.indexOf("Stalled projects");
    expect(heading).toBeGreaterThan(-1);
    expect(p).toContain("last mentioned in the day-log 13d ago");
    expect(p.indexOf("last mentioned in the day-log 13d ago")).toBeGreaterThan(
      heading,
    );
    // The retired detector buckets are gone from the prompt.
    expect(p).not.toContain("Stalled tasks:");
    expect(p).not.toContain("Recurring blockers:");
    expect(p).not.toContain("Dormant objectives:");
  });

  it("warns the author that day-log silence is ambiguous (not necessarily drift)", () => {
    const p = renderJudgmentPrompt(makeInput());
    const note = p.indexOf("day-log silence is AMBIGUOUS");
    expect(note).toBeGreaterThan(p.indexOf("Stalled projects"));
    expect(p).toContain('Do NOT assert "drift"');
  });

  it("renders '(none)' for an empty input section", () => {
    const p = renderJudgmentPrompt(
      makeInput({ detectionSignals: [], generalEvents: [] }),
    );
    expect(p).toContain("(none)");
  });

  it("renders the discarded-signals list when populated", () => {
    const p = renderJudgmentPrompt(
      makeInput({ recentlyDiscarded: ["salones-wa quiet but expected"] }),
    );
    expect(p).toContain("salones-wa quiet but expected");
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
      makeInput({ evidenceSources: ["day-log", "cohort"] }),
    );
    expect(p).toContain("EVIDENCE SOURCES");
    expect(p).toContain("[0] day-log");
    expect(p).toContain("[1] cohort");
  });
});
