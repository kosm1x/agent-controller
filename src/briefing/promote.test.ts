/**
 * Briefing promote/discard tests (V8.1 Phase 8). Real in-memory DB.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { BriefingSchema, type Briefing } from "./schema.js";
import {
  insertProposedBriefing,
  markBriefingDelivered,
  getProposedBriefing,
} from "./storage.js";
import { resolveBriefingOnOperatorReply } from "./promote.js";

// Dynamic, not a hardcoded date: insertProposedBriefing() defaults expires_at
// to generated_at + 24h, so a fixed past date silently rots — every briefing
// auto-expires once the calendar passes generated_at + 1 day. The EXPIRES test
// overrides expires_at explicitly, so "now" here keeps every other briefing live.
const ISO = new Date().toISOString();
const SHA256 = "a".repeat(64);

function makeBriefing(): Briefing {
  return BriefingSchema.parse({
    briefing_id: crypto.randomUUID(),
    surface: "morning",
    generated_at: ISO,
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
        confidence: "green",
        confidence_reason: "clear evidence here",
        why: "surfaced for awareness with a concrete documented reason",
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

/** Insert + deliver a briefing, with an optional explicit expiry. */
function deliverNew(expiresAt?: string): string {
  const b = makeBriefing();
  insertProposedBriefing(b, expiresAt ? { expiresAt } : {});
  markBriefingDelivered(b.briefing_id);
  return b.briefing_id;
}

function triagePolicy(surface: string) {
  return getDatabase()
    .prepare(
      `SELECT promote_count, discard_count, last_outcome
         FROM triage_policies WHERE surface = ?`,
    )
    .get(surface) as
    | { promote_count: number; discard_count: number; last_outcome: string }
    | undefined;
}

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

describe("resolveBriefingOnOperatorReply", () => {
  it("returns null when no delivered briefing is pending", () => {
    expect(resolveBriefingOnOperatorReply("hola")).toBeNull();
  });

  it("does NOT resolve an undelivered pending briefing", () => {
    const b = makeBriefing();
    insertProposedBriefing(b); // persisted but never delivered
    expect(resolveBriefingOnOperatorReply("hola")).toBeNull();
    expect(getProposedBriefing(b.briefing_id)!.status).toBe("pending");
  });

  it("PROMOTES on any non-rejecting reply and bumps the triage counter", () => {
    const id = deliverNew();
    const result = resolveBriefingOnOperatorReply("gracias, lo reviso");
    expect(result).toMatchObject({ briefingId: id, resolution: "promoted" });
    expect(getProposedBriefing(id)!.status).toBe("promoted");
    expect(triagePolicy("morning")).toMatchObject({
      promote_count: 1,
      discard_count: 0,
      last_outcome: "promoted",
    });
  });

  it("DISCARDS on an explicit rejection phrase", () => {
    const id = deliverNew();
    const result = resolveBriefingOnOperatorReply("descartar por ahora");
    expect(result).toMatchObject({ briefingId: id, resolution: "discarded" });
    expect(getProposedBriefing(id)!.status).toBe("discarded");
    expect(triagePolicy("morning")).toMatchObject({
      promote_count: 0,
      discard_count: 1,
    });
  });

  it("PROMOTES an engagement reply that merely defers ('lo veo más tarde')", () => {
    // audit W5 — "más tarde" / "no ahora" are engagement, not rejection.
    const id = deliverNew();
    const result = resolveBriefingOnOperatorReply(
      "gracias, lo veo más tarde con calma",
    );
    expect(result).toMatchObject({ briefingId: id, resolution: "promoted" });
  });

  it("EXPIRES a delivered briefing whose expiry has passed, regardless of reply", () => {
    const id = deliverNew("2020-01-01T00:00:00.000Z"); // long past
    const result = resolveBriefingOnOperatorReply("gracias");
    expect(result).toMatchObject({ briefingId: id, resolution: "expired" });
    expect(getProposedBriefing(id)!.status).toBe("expired");
    // An expiry is not a promote/discard outcome — no triage row written.
    expect(triagePolicy("morning")).toBeUndefined();
  });

  it("is a no-op on the second reply — the briefing is already resolved", () => {
    deliverNew();
    expect(resolveBriefingOnOperatorReply("gracias")!.resolution).toBe(
      "promoted",
    );
    expect(resolveBriefingOnOperatorReply("otra cosa")).toBeNull();
  });
});
