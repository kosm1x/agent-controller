/**
 * Briefing delivery tests (V8.1 Phase 8). The messaging router is mocked —
 * no real channels; the proposed_briefings table is a real in-memory DB.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, initDatabase } from "../db/index.js";

const sendMock = vi.fn();
let routerImpl: unknown = {
  sendBriefingToOwner: (...a: unknown[]) => sendMock(...a),
};
vi.mock("../messaging/index.js", () => ({
  getRouter: () => routerImpl,
}));

import { BriefingSchema, type Briefing } from "./schema.js";
import { deliverBriefing } from "./delivery.js";
import {
  getProposedBriefing,
  insertProposedBriefing,
  transitionBriefing,
} from "./storage.js";

const ISO = "2026-05-20T08:00:00.000Z";
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

beforeEach(() => {
  initDatabase(":memory:");
  sendMock.mockReset();
  sendMock.mockResolvedValue({ sent: 2, failed: 0 });
  routerImpl = { sendBriefingToOwner: (...a: unknown[]) => sendMock(...a) };
});

afterEach(() => {
  closeDatabase();
});

describe("deliverBriefing", () => {
  it("renders, sends, and stamps delivered_at", async () => {
    const b = makeBriefing();
    insertProposedBriefing(b);

    const result = await deliverBriefing(b.briefing_id);

    expect(result).toEqual({ delivered: true });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(String(sendMock.mock.calls[0]![0])).toContain("Resumen matutino");
    expect(getProposedBriefing(b.briefing_id)!.deliveredAt).not.toBeNull();
  });

  it("returns not-found for an unknown briefing id", async () => {
    expect(await deliverBriefing("nope")).toEqual({
      delivered: false,
      reason: "not-found",
    });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("does not deliver a briefing that is no longer pending", async () => {
    const b = makeBriefing();
    insertProposedBriefing(b);
    transitionBriefing(b.briefing_id, "discarded");
    expect(await deliverBriefing(b.briefing_id)).toEqual({
      delivered: false,
      reason: "not-pending",
    });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("reports send-failed and does NOT stamp delivered_at when the send throws", async () => {
    const b = makeBriefing();
    insertProposedBriefing(b);
    sendMock.mockRejectedValue(new Error("telegram down"));

    const result = await deliverBriefing(b.briefing_id);

    expect(result).toEqual({ delivered: false, reason: "send-failed" });
    expect(getProposedBriefing(b.briefing_id)!.deliveredAt).toBeNull();
  });

  it("reports send-failed when every channel failed (sent === 0) — audit W3", async () => {
    const b = makeBriefing();
    insertProposedBriefing(b);
    sendMock.mockResolvedValue({ sent: 0, failed: 3 });

    const result = await deliverBriefing(b.briefing_id);

    expect(result).toEqual({ delivered: false, reason: "send-failed" });
    // delivered_at must NOT be stamped — the briefing reached no channel.
    expect(getProposedBriefing(b.briefing_id)!.deliveredAt).toBeNull();
  });

  it("delivers when at least one channel succeeds despite a partial failure", async () => {
    const b = makeBriefing();
    insertProposedBriefing(b);
    sendMock.mockResolvedValue({ sent: 1, failed: 2 });

    const result = await deliverBriefing(b.briefing_id);

    expect(result).toEqual({ delivered: true });
    expect(getProposedBriefing(b.briefing_id)!.deliveredAt).not.toBeNull();
  });

  it("reports no-router when the messaging router is unavailable", async () => {
    routerImpl = null;
    const b = makeBriefing();
    insertProposedBriefing(b);
    expect(await deliverBriefing(b.briefing_id)).toEqual({
      delivered: false,
      reason: "no-router",
    });
  });
});
