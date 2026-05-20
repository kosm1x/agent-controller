/**
 * Briefing renderer tests (V8.1 Phase 8).
 */

import { describe, expect, it } from "vitest";
import { BriefingSchema, type Briefing } from "./schema.js";
import { renderBriefing } from "./render.js";

const ISO = "2026-05-20T13:00:00.000Z";
const SHA256 = "a".repeat(64);

function judgment(over: Record<string, unknown> = {}) {
  return {
    signal_id: crypto.randomUUID(),
    kind: "stalled_task",
    subject: "t-1",
    posture: "noted",
    confidence: "green",
    confidence_reason: "clear evidence here",
    why: "this needs your attention for a concrete documented reason",
    evidence_indices: [0],
    ...over,
  };
}

function briefingWith(
  judgments: ReturnType<typeof judgment>[],
  extra: Record<string, unknown> = {},
): Briefing {
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
    judgments,
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
    ...extra,
  });
}

describe("renderBriefing", () => {
  it("renders the surface label, a posture section, and the promote/discard footer", () => {
    const out = renderBriefing(briefingWith([judgment()]));
    expect(out).toContain("Resumen matutino");
    expect(out).toContain("Para tu radar"); // 'noted' posture label
    expect(out).toContain("t-1");
    expect(out).toContain("descartar"); // footer
  });

  it("features the highest-leverage judgment first", () => {
    const hl = judgment({
      posture: "highest_leverage",
      subject: "obj-x",
      why: "this is the single most impactful move available to you today",
    });
    const out = renderBriefing(briefingWith([judgment(), hl]));
    expect(out).toContain("Máxima palanca hoy");
    // The HL reasoning appears before the grouped 'noted' section.
    expect(out.indexOf("most impactful move")).toBeLessThan(
      out.indexOf("Para tu radar"),
    );
  });

  it("groups at_risk / has_momentum judgments under their own headings", () => {
    const out = renderBriefing(
      briefingWith([
        judgment({ posture: "at_risk", subject: "risk-1" }),
        judgment({ posture: "has_momentum", subject: "mom-1" }),
      ]),
    );
    expect(out).toContain("En riesgo");
    expect(out).toContain("Con impulso");
  });

  it("surfaces a non-pass S2 verdict honestly", () => {
    const out = renderBriefing(
      briefingWith([judgment()], { critic_verdict: "fail_returned_anyway" }),
    );
    expect(out).toContain("fail_returned_anyway");
  });

  it("omits the verdict note when the critic passed", () => {
    const out = renderBriefing(briefingWith([judgment()]));
    expect(out).not.toContain("autoauditoría");
  });
});
