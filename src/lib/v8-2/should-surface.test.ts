/**
 * V8.2 Phase 4 — drop-vs-surface predicate tests (spec §9).
 *
 * Pure + deterministic. Pins the carve-out: only at_risk OR recurring_blocker
 * surfaces (optionless); everything else drops. This is the §8-deferred handoff.
 */

import { describe, expect, it } from "vitest";
import type { Judgment } from "../../briefing/schema.js";
import { shouldSurfaceUnfixable, type SurfaceInput } from "./should-surface.js";

function input(overrides: Partial<SurfaceInput> = {}): SurfaceInput {
  return { posture: "noted", kind: "stalled_task", ...overrides };
}

describe("shouldSurfaceUnfixable — §9 drop-vs-surface", () => {
  it("surfaces an at_risk judgment as a heads-up", () => {
    expect(shouldSurfaceUnfixable(input({ posture: "at_risk" }))).toEqual({
      surface: true,
      reason: "at_risk_heads_up",
    });
  });

  it("surfaces a recurring_blocker judgment as a heads-up", () => {
    expect(
      shouldSurfaceUnfixable(
        input({ posture: "noted", kind: "recurring_blocker" }),
      ),
    ).toEqual({ surface: true, reason: "recurring_blocker_heads_up" });
  });

  it("drops everything else", () => {
    for (const posture of [
      "noted",
      "has_momentum",
      "highest_leverage",
    ] as const) {
      const d = shouldSurfaceUnfixable(
        input({ posture, kind: "stalled_task" }),
      );
      expect(d).toEqual({ surface: false, reason: "drop" });
    }
  });

  it("at_risk wins when both carve-outs apply", () => {
    const d = shouldSurfaceUnfixable({
      posture: "at_risk",
      kind: "recurring_blocker",
    });
    expect(d.reason).toBe("at_risk_heads_up");
  });

  it("type-checks against a full Judgment via Pick (compile-time contract)", () => {
    const j: Pick<Judgment, "posture" | "kind"> = {
      posture: "at_risk",
      kind: "implicit_deadline",
    };
    expect(shouldSurfaceUnfixable(j).surface).toBe(true);
  });
});
