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
  markBriefingDelivered,
  getResolvablePendingBriefing,
  transitionBriefing,
  getRecentlyDiscardedSubjects,
  expireStalePendingBriefings,
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

describe("delivery + resolution storage (Phase 8)", () => {
  it("markBriefingDelivered stamps delivered_at and makes the briefing resolvable", () => {
    const b = makeBriefing();
    insertProposedBriefing(b);
    // Not resolvable until delivered.
    expect(getResolvablePendingBriefing()).toBeNull();

    markBriefingDelivered(b.briefing_id);
    const resolvable = getResolvablePendingBriefing();
    expect(resolvable).not.toBeNull();
    expect(resolvable!.briefingId).toBe(b.briefing_id);
    expect(resolvable!.deliveredAt).not.toBeNull();
  });

  it("markBriefingDelivered is idempotent — keeps the first timestamp", () => {
    const b = makeBriefing();
    insertProposedBriefing(b);
    markBriefingDelivered(b.briefing_id);
    const first = getProposedBriefing(b.briefing_id)!.deliveredAt;
    markBriefingDelivered(b.briefing_id);
    expect(getProposedBriefing(b.briefing_id)!.deliveredAt).toBe(first);
  });

  it("transitionBriefing moves a pending row, and is a no-op once resolved", () => {
    const b = makeBriefing();
    insertProposedBriefing(b);
    expect(transitionBriefing(b.briefing_id, "promoted")).toBe(true);
    expect(getProposedBriefing(b.briefing_id)!.status).toBe("promoted");
    // The row is no longer pending — a second transition is rejected.
    expect(transitionBriefing(b.briefing_id, "discarded")).toBe(false);
    expect(getProposedBriefing(b.briefing_id)!.status).toBe("promoted");
  });

  it("getResolvablePendingBriefing ignores a resolved briefing", () => {
    const b = makeBriefing();
    insertProposedBriefing(b);
    markBriefingDelivered(b.briefing_id);
    transitionBriefing(b.briefing_id, "discarded");
    expect(getResolvablePendingBriefing()).toBeNull();
  });

  it("getRecentlyDiscardedSubjects collects subjects from discarded briefings", () => {
    const b = makeBriefing();
    insertProposedBriefing(b);
    expect(getRecentlyDiscardedSubjects()).toEqual([]);
    transitionBriefing(b.briefing_id, "discarded");
    expect(getRecentlyDiscardedSubjects()).toEqual(["t-1"]);
  });

  it("getRecentlyDiscardedSubjects excludes a discard older than the window", () => {
    const b = makeBriefing();
    insertProposedBriefing(b);
    transitionBriefing(b.briefing_id, "discarded");
    // Backdate the discard well outside the 7-day window.
    getDatabase()
      .prepare(
        `UPDATE proposed_briefings SET discarded_at = datetime('now','-30 days')
          WHERE briefing_id = ?`,
      )
      .run(b.briefing_id);
    expect(getRecentlyDiscardedSubjects()).toEqual([]);
  });

  it("expireStalePendingBriefings expires a delivered, past-expiry briefing", () => {
    const b = makeBriefing();
    insertProposedBriefing(b, { expiresAt: "2020-01-01T00:00:00.000Z" });
    markBriefingDelivered(b.briefing_id);
    expect(expireStalePendingBriefings()).toBe(1);
    expect(getProposedBriefing(b.briefing_id)!.status).toBe("expired");
  });

  it("expireStalePendingBriefings leaves an un-delivered or un-expired briefing alone", () => {
    // Un-delivered, past expiry — not delivered, so not swept.
    const undelivered = makeBriefing();
    insertProposedBriefing(undelivered, {
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    // Delivered but not yet expired.
    const fresh = makeBriefing("weekly");
    insertProposedBriefing(fresh, { expiresAt: "2099-01-01T00:00:00.000Z" });
    markBriefingDelivered(fresh.briefing_id);

    expect(expireStalePendingBriefings()).toBe(0);
    expect(getProposedBriefing(undelivered.briefing_id)!.status).toBe(
      "pending",
    );
    expect(getProposedBriefing(fresh.briefing_id)!.status).toBe("pending");
  });
});
