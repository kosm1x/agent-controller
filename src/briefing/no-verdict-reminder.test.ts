/**
 * §17 no-verdict reminder tests — V8.5 Phase 4.6.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, initDatabase } from "../db/index.js";
import { BriefingSchema, type Briefing } from "./schema.js";
import {
  insertProposedBriefing,
  markBriefingDelivered,
  transitionBriefing,
} from "./storage.js";
import { runNoVerdictReminder } from "./no-verdict-reminder.js";

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

/** In-window clock: briefs generated at ISO expire ISO+24h. */
const NOW_IN_WINDOW = () => new Date("2026-05-20T20:00:00.000Z");

function seedDeliveredPending(surface: Briefing["surface"] = "morning") {
  const b = makeBriefing(surface);
  insertProposedBriefing(b);
  markBriefingDelivered(b.briefing_id);
  return b;
}

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
  vi.restoreAllMocks();
});

describe("runNoVerdictReminder", () => {
  it("no pending brief → no_pending_brief, nothing sent", async () => {
    const send = vi.fn(async () => ({ sent: 1, failed: 0 }));
    const result = await runNoVerdictReminder({ send, now: NOW_IN_WINDOW });
    expect(result).toEqual({ sent: false, reason: "no_pending_brief" });
    expect(send).not.toHaveBeenCalled();
  });

  it("undelivered pending brief is not resolvable → no reminder", async () => {
    insertProposedBriefing(makeBriefing()); // never markBriefingDelivered
    const send = vi.fn(async () => ({ sent: 1, failed: 0 }));
    const result = await runNoVerdictReminder({ send, now: NOW_IN_WINDOW });
    expect(result.reason).toBe("no_pending_brief");
    expect(send).not.toHaveBeenCalled();
  });

  it("delivered pending brief → sends ONE reminder carrying the exact verdict vocabulary", async () => {
    const b = seedDeliveredPending();
    const send = vi.fn(async (_text: string) => ({ sent: 1, failed: 0 }));

    const first = await runNoVerdictReminder({ send, now: NOW_IN_WINDOW });
    expect(first).toEqual({
      sent: true,
      reason: "sent",
      briefingId: b.briefing_id,
    });
    expect(send).toHaveBeenCalledTimes(1);
    const text = send.mock.calls[0][0];
    expect(text).toContain('"sirve"');
    expect(text).toContain('"descarta"');

    // Send-once guard: a second invocation (restart, manual run) is a no-op.
    const second = await runNoVerdictReminder({ send, now: NOW_IN_WINDOW });
    expect(second.reason).toBe("already_reminded");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("expired brief → no reminder", async () => {
    seedDeliveredPending();
    const send = vi.fn(async () => ({ sent: 1, failed: 0 }));
    const afterExpiry = () => new Date("2026-05-21T09:00:00.000Z"); // > ISO+24h
    const result = await runNoVerdictReminder({ send, now: afterExpiry });
    expect(result.reason).toBe("expired");
    expect(send).not.toHaveBeenCalled();
  });

  it("resolved brief (promoted) → no reminder", async () => {
    const b = seedDeliveredPending();
    transitionBriefing(b.briefing_id, "promoted");
    const send = vi.fn(async () => ({ sent: 1, failed: 0 }));
    const result = await runNoVerdictReminder({ send, now: NOW_IN_WINDOW });
    expect(result.reason).toBe("no_pending_brief");
    expect(send).not.toHaveBeenCalled();
  });

  it("zero delivery does NOT consume the brief's one shot", async () => {
    seedDeliveredPending();
    const dead = vi.fn(async () => ({ sent: 0, failed: 2 }));
    const first = await runNoVerdictReminder({
      send: dead,
      now: NOW_IN_WINDOW,
    });
    expect(first.reason).toBe("zero_delivery");

    const alive = vi.fn(async () => ({ sent: 1, failed: 0 }));
    const second = await runNoVerdictReminder({
      send: alive,
      now: NOW_IN_WINDOW,
    });
    expect(second.reason).toBe("sent");
  });

  it("guard is per-brief: a NEW brief after a reminded one still gets its reminder", async () => {
    seedDeliveredPending();
    const send = vi.fn(async () => ({ sent: 1, failed: 0 }));
    await runNoVerdictReminder({ send, now: NOW_IN_WINDOW });

    // A new morning brief supersedes the old pending one.
    const next = seedDeliveredPending();
    const result = await runNoVerdictReminder({ send, now: NOW_IN_WINDOW });
    expect(result).toEqual({
      sent: true,
      reason: "sent",
      briefingId: next.briefing_id,
    });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
