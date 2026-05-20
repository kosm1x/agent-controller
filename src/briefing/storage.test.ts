/**
 * proposed_briefings storage tests (V8.1 Phase 6 B1).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { BriefingSchema, type Briefing } from "./schema.js";
import {
  insertProposedBriefing,
  getProposedBriefing,
  listPendingBriefings,
} from "./storage.js";

const ISO = "2026-05-20T08:00:00.000Z";
const SHA256 = "a".repeat(64);

function makeBriefing(
  surface: Briefing["surface"] = "morning",
  generatedAt = ISO,
): Briefing {
  return BriefingSchema.parse({
    briefing_id: crypto.randomUUID(),
    surface,
    generated_at: generatedAt,
    source_window: {
      cursor_start_event_id: 1,
      cursor_end_event_id: 2,
      wall_start: ISO,
      wall_end: ISO,
    },
    active_objective_ids: [],
    self_defining_grounding: [],
    general_events_used: [],
    judgments: [
      {
        signal_id: crypto.randomUUID(),
        kind: "stalled_task",
        subject: "t-1",
        posture: "noted",
        confidence: "yellow",
        confidence_reason: "low evidence",
        why: "surfaced for awareness, nothing actionable in the window yet",
        evidence_indices: [0],
      },
    ],
    verified_against: [
      {
        type: "sqlite",
        table: "tasks",
        query_sha: SHA256,
        row_count: 1,
        queried_at: ISO,
      },
    ],
    sample_n: 1,
    concerns: [],
    critic_verdict: "pass",
  });
}

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

describe("proposed_briefings storage", () => {
  it("round-trips a briefing through insert + get", () => {
    const b = makeBriefing();
    insertProposedBriefing(b, { s2ReportId: "rpt-1" });
    const got = getProposedBriefing(b.briefing_id);
    expect(got).not.toBeNull();
    expect(got!.status).toBe("pending");
    expect(got!.s2ReportId).toBe("rpt-1");
    expect(got!.briefing.briefing_id).toBe(b.briefing_id);
  });

  it("returns null for an unknown briefing id", () => {
    expect(getProposedBriefing("nope")).toBeNull();
  });

  it("defaults expires_at to generated_at + 24h", () => {
    const b = makeBriefing("morning", "2026-05-20T08:00:00.000Z");
    insertProposedBriefing(b);
    expect(getProposedBriefing(b.briefing_id)!.expiresAt).toBe(
      "2026-05-21T08:00:00.000Z",
    );
  });

  it("supersedes a prior pending briefing on the same surface", () => {
    const first = makeBriefing("morning");
    const second = makeBriefing("morning");
    insertProposedBriefing(first);
    insertProposedBriefing(second);

    expect(getProposedBriefing(first.briefing_id)!.status).toBe("superseded");
    expect(getProposedBriefing(second.briefing_id)!.status).toBe("pending");
    // The superseded row points at its replacement.
    const row = getDatabase()
      .prepare(
        "SELECT superseded_by_briefing_id FROM proposed_briefings WHERE briefing_id = ?",
      )
      .get(first.briefing_id) as { superseded_by_briefing_id: string };
    expect(row.superseded_by_briefing_id).toBe(second.briefing_id);
  });

  it("does NOT supersede a pending briefing on a different surface", () => {
    const morning = makeBriefing("morning");
    const weekly = makeBriefing("weekly");
    insertProposedBriefing(morning);
    insertProposedBriefing(weekly);
    expect(getProposedBriefing(morning.briefing_id)!.status).toBe("pending");
    expect(getProposedBriefing(weekly.briefing_id)!.status).toBe("pending");
  });

  it("lists pending briefings, optionally filtered by surface", () => {
    insertProposedBriefing(makeBriefing("morning"));
    insertProposedBriefing(makeBriefing("weekly"));
    expect(listPendingBriefings()).toHaveLength(2);
    expect(listPendingBriefings("weekly")).toHaveLength(1);
    expect(listPendingBriefings("weekly")[0]!.surface).toBe("weekly");
  });
});
