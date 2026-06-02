/**
 * V8.2 Phase 3 — skip-predicate tests (spec §8 "When to skip").
 *
 * Pure + deterministic: no LLM, no DB. Pins the four reasons and the ordering
 * (red wins over an actionable kind; observational wins over mechanical).
 */

import { describe, expect, it } from "vitest";
import type { Judgment } from "../../briefing/schema.js";
import {
  shouldRunMultiOption,
  type MultiOptionInput,
} from "./should-multi-option.js";

const FLAGS = {
  allow_ignore: true,
  allow_respond: true,
  allow_edit: true,
  allow_accept: true,
};

function input(overrides: Partial<MultiOptionInput> = {}): MultiOptionInput {
  return {
    kind: "stalled_task",
    posture: "at_risk",
    confidence: "green",
    proposed_action: undefined,
    ...overrides,
  };
}

describe("shouldRunMultiOption — §8 skip predicate", () => {
  it("runs RAPID-D for a decision-worthy judgment", () => {
    expect(shouldRunMultiOption(input())).toEqual({
      run: true,
      reason: "run",
    });
  });

  it("runs when an actionable proposed_action asks the operator", () => {
    const d = shouldRunMultiOption(
      input({
        kind: "dormant_objective",
        posture: "highest_leverage",
        proposed_action: {
          surface: "ask_operator",
          capability_flags: FLAGS,
          detail: "decide direction",
        },
      }),
    );
    expect(d.run).toBe(true);
  });

  it("skips red-confidence judgments (A/B/C on thin evidence is theatre)", () => {
    expect(shouldRunMultiOption(input({ confidence: "red" }))).toEqual({
      run: false,
      reason: "red_confidence",
    });
  });

  it("red wins over an actionable kind — at_risk/recurring_blocker carve-out is a downstream surfacing concern, not a run-RAPID-D one", () => {
    // A red recurring_blocker still skips the multi-option pass here; whether it
    // surfaces optionless is Phase 4's drop-vs-surface call (§9), not this gate's.
    const d = shouldRunMultiOption(
      input({
        kind: "recurring_blocker",
        posture: "at_risk",
        confidence: "red",
      }),
    );
    expect(d).toEqual({ run: false, reason: "red_confidence" });
  });

  it("skips observational 'noted' posture", () => {
    expect(shouldRunMultiOption(input({ posture: "noted" }))).toEqual({
      run: false,
      reason: "observational",
    });
  });

  it("skips observational signal kinds (momentum, self_defining_progress)", () => {
    for (const kind of ["momentum", "self_defining_progress"] as const) {
      const d = shouldRunMultiOption(
        input({ kind, posture: "has_momentum", confidence: "yellow" }),
      );
      expect(d).toEqual({ run: false, reason: "observational" });
    }
  });

  it("skips a single mechanical action (proposed_action.surface = log_only)", () => {
    const d = shouldRunMultiOption(
      input({
        kind: "implicit_deadline",
        proposed_action: {
          surface: "log_only",
          capability_flags: FLAGS,
          detail: "ping the operator",
        },
      }),
    );
    expect(d).toEqual({ run: false, reason: "single_mechanical_action" });
  });

  it("ordering: observational beats single_mechanical_action", () => {
    // A 'momentum'/'noted' judgment that ALSO happens to carry a log_only action
    // is reported as observational (rule 2 precedes rule 3).
    const d = shouldRunMultiOption(
      input({
        kind: "momentum",
        posture: "noted",
        proposed_action: {
          surface: "log_only",
          capability_flags: FLAGS,
          detail: "x",
        },
      }),
    );
    expect(d.reason).toBe("observational");
  });

  it("ordering: red beats observational", () => {
    const d = shouldRunMultiOption(
      input({ kind: "momentum", posture: "noted", confidence: "red" }),
    );
    expect(d.reason).toBe("red_confidence");
  });

  it("type-checks against a full Judgment via Pick (compile-time contract)", () => {
    // A real Judgment is structurally assignable to MultiOptionInput.
    const j: Pick<
      Judgment,
      "kind" | "posture" | "confidence" | "proposed_action"
    > = {
      kind: "stalled_task",
      posture: "at_risk",
      confidence: "green",
    };
    expect(shouldRunMultiOption(j).run).toBe(true);
  });
});
