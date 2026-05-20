/**
 * Briefing schema tests (V8.1 Phase 6 B1).
 */

import { describe, it, expect } from "vitest";
import {
  BriefingSchema,
  JudgmentSchema,
  validateBriefingInvariants,
  type Briefing,
} from "./schema.js";

const ISO = "2026-05-20T08:00:00.000Z";
const SHA256 = "a".repeat(64);
const citation = {
  type: "sqlite" as const,
  table: "tasks",
  query_sha: SHA256,
  row_count: 5,
  queried_at: ISO,
};

function makeJudgment(overrides: Record<string, unknown> = {}) {
  return {
    signal_id: crypto.randomUUID(),
    kind: "stalled_task",
    subject: "task-123",
    posture: "at_risk",
    confidence: "green",
    confidence_reason: "stalled 12 days",
    why: "the task has not advanced and the deadline is close, see evidence",
    evidence_indices: [0],
    ...overrides,
  };
}

function makeBriefing(overrides: Record<string, unknown> = {}) {
  return {
    briefing_id: crypto.randomUUID(),
    surface: "morning",
    generated_at: ISO,
    source_window: {
      cursor_start_event_id: 10,
      cursor_end_event_id: 50,
      wall_start: ISO,
      wall_end: ISO,
    },
    active_objective_ids: ["NorthStar/objectives/x.md"],
    self_defining_grounding: ["project:eureka"],
    general_events_used: ["evt-1"],
    judgments: [makeJudgment()],
    verified_against: [citation],
    sample_n: 5,
    concerns: [],
    critic_verdict: "pass",
    ...overrides,
  };
}

/** Parse to a typed Briefing (assumes the input is schema-valid). */
const parsed = (o: Record<string, unknown>): Briefing =>
  BriefingSchema.parse(o);

describe("BriefingSchema", () => {
  it("accepts a well-formed briefing", () => {
    expect(BriefingSchema.safeParse(makeBriefing()).success).toBe(true);
  });

  it("requires at least one judgment", () => {
    expect(
      BriefingSchema.safeParse(makeBriefing({ judgments: [] })).success,
    ).toBe(false);
  });

  it("rejects more than 15 judgments", () => {
    const many = Array.from({ length: 16 }, () => makeJudgment());
    expect(
      BriefingSchema.safeParse(makeBriefing({ judgments: many })).success,
    ).toBe(false);
  });

  it("requires at least one citation in verified_against", () => {
    expect(
      BriefingSchema.safeParse(makeBriefing({ verified_against: [] })).success,
    ).toBe(false);
  });
});

describe("JudgmentSchema", () => {
  it("rejects a too-short confidence_reason", () => {
    expect(
      JudgmentSchema.safeParse(makeJudgment({ confidence_reason: "short" }))
        .success,
    ).toBe(false);
  });

  it("rejects a too-short why", () => {
    expect(
      JudgmentSchema.safeParse(makeJudgment({ why: "too short" })).success,
    ).toBe(false);
  });

  it("requires at least one evidence index", () => {
    expect(
      JudgmentSchema.safeParse(makeJudgment({ evidence_indices: [] })).success,
    ).toBe(false);
  });
});

describe("validateBriefingInvariants", () => {
  it("passes a consistent briefing", () => {
    expect(validateBriefingInvariants(parsed(makeBriefing()))).toEqual([]);
  });

  it("flags cursor_end before cursor_start", () => {
    const b = parsed(
      makeBriefing({
        source_window: {
          cursor_start_event_id: 50,
          cursor_end_event_id: 10,
          wall_start: ISO,
          wall_end: ISO,
        },
      }),
    );
    expect(validateBriefingInvariants(b)).toContainEqual(
      expect.stringContaining("cursor_end_event_id"),
    );
  });

  it("flags an evidence_index past verified_against bounds", () => {
    const b = parsed(
      makeBriefing({ judgments: [makeJudgment({ evidence_indices: [0, 3] })] }),
    );
    expect(validateBriefingInvariants(b)).toContainEqual(
      expect.stringContaining("out of range"),
    );
  });

  it("flags more than one highest_leverage posture", () => {
    const b = parsed(
      makeBriefing({
        judgments: [
          makeJudgment({ posture: "highest_leverage" }),
          makeJudgment({ posture: "highest_leverage" }),
        ],
      }),
    );
    expect(validateBriefingInvariants(b)).toContainEqual(
      expect.stringContaining("highest_leverage"),
    );
  });

  it("flags a highest_leverage_pick that matches no judgment", () => {
    const b = parsed(
      makeBriefing({ highest_leverage_pick: crypto.randomUUID() }),
    );
    expect(validateBriefingInvariants(b)).toContainEqual(
      expect.stringContaining("matches no judgment"),
    );
  });

  it("flags a highest_leverage_pick pointing at a non-highest_leverage judgment", () => {
    const j = makeJudgment({ posture: "at_risk" });
    const b = parsed(
      makeBriefing({
        judgments: [j],
        highest_leverage_pick: j.signal_id,
      }),
    );
    expect(validateBriefingInvariants(b)).toContainEqual(
      expect.stringContaining("expected 'highest_leverage'"),
    );
  });

  it("accepts a matching highest_leverage_pick", () => {
    const j = makeJudgment({ posture: "highest_leverage" });
    const b = parsed(
      makeBriefing({ judgments: [j], highest_leverage_pick: j.signal_id }),
    );
    expect(validateBriefingInvariants(b)).toEqual([]);
  });

  it("flags duplicate judgment signal_ids", () => {
    const j = makeJudgment();
    const b = parsed(makeBriefing({ judgments: [j, { ...j }] }));
    expect(validateBriefingInvariants(b)).toContainEqual(
      expect.stringContaining("not unique"),
    );
  });
});
