/**
 * V8.2 Phase 1 types — Zod contract round-trips + invariants (spec §6/§7).
 *
 * Pure (no DB): exercises the schemas, pins the deliberate posture-vocabulary
 * divergence (V8.1 'has_momentum' vs V8.2 'momentum'), and the §8
 * "proposed_options is 3-or-0, never fake A/B/C" invariant.
 */

import { describe, expect, it } from "vitest";
import {
  EvidenceRefSchema,
  AttributedClaimSchema,
  ProposedOptionSchema,
  ConfidenceBasisSchema,
  StrategicJudgmentSchema,
  DecompositionSchema,
  PostureSchema,
  RESOLVER_STATUSES,
  RAPID_D_ROLES,
  OPTION_LABELS,
  type StrategicJudgment,
  type ProposedOption,
} from "./types.js";

const EVIDENCE_REF = {
  kind: "task" as const,
  id: "t-42",
  excerpt: "task t-42 is blocked",
  retrieved_at: "2026-06-01T00:00:00.000Z",
};

function option(label: "A" | "B" | "C", rank: 1 | 2 | 3): ProposedOption {
  return {
    label,
    summary: `option ${label}`,
    tradeoffs: ["faster but riskier"],
    rank,
    generated_by_role: "synthesizer",
  };
}

/** A valid V8.1 Judgment base + the V8.2 extension fields. */
function strategicJudgment(options: ProposedOption[]): Record<string, unknown> {
  return {
    // V8.1 JudgmentSchema base
    signal_id: "11111111-1111-4111-8111-111111111111",
    kind: "stalled_task",
    subject: "task-42",
    posture: "has_momentum", // V8.1 vocabulary (normalized at persistence)
    confidence: "green",
    confidence_reason: "two independent sources agree",
    why: "the pilot moved forward this week per task-42 and the CRM log",
    evidence_indices: [0],
    // V8.2 extension
    evidence_refs: [EVIDENCE_REF],
    proposed_options: options,
    confidence_basis: {
      distinct_sources: 2,
      contradiction_count: 0,
      stale_count: 0,
    },
  };
}

describe("enum exports", () => {
  it("expose the §6/§8 vocabularies", () => {
    expect(RESOLVER_STATUSES).toEqual([
      "unresolved",
      "resolved",
      "stale",
      "contradicted",
    ]);
    expect(RAPID_D_ROLES).toContain("devils_advocate");
    expect(OPTION_LABELS).toEqual(["A", "B", "C"]);
  });
});

describe("EvidenceRef / AttributedClaim", () => {
  it("round-trips a valid evidence ref", () => {
    expect(EvidenceRefSchema.parse(EVIDENCE_REF)).toEqual(EVIDENCE_REF);
  });

  it("rejects an empty evidence id", () => {
    expect(
      EvidenceRefSchema.safeParse({ ...EVIDENCE_REF, id: "" }).success,
    ).toBe(false);
  });

  it("accepts a multi-source claim (two refs, one claim_id)", () => {
    const claim = {
      claim_id: 0,
      claim_text: "the pilot is at risk",
      evidence_refs: [EVIDENCE_REF, { ...EVIDENCE_REF, id: "t-43" }],
      resolver_status: "resolved" as const,
    };
    expect(AttributedClaimSchema.parse(claim).evidence_refs).toHaveLength(2);
  });

  it("rejects a claim with zero evidence refs", () => {
    expect(
      AttributedClaimSchema.safeParse({
        claim_id: 0,
        claim_text: "x",
        evidence_refs: [],
        resolver_status: "unresolved",
      }).success,
    ).toBe(false);
  });
});

describe("ProposedOption", () => {
  it("round-trips a valid option", () => {
    expect(ProposedOptionSchema.parse(option("A", 1)).label).toBe("A");
  });

  it("rejects rank 4 and label 'D'", () => {
    expect(
      ProposedOptionSchema.safeParse(option("A", 4 as never)).success,
    ).toBe(false);
    expect(
      ProposedOptionSchema.safeParse({ ...option("A", 1), label: "D" }).success,
    ).toBe(false);
  });
});

describe("ConfidenceBasis", () => {
  it("rejects negative counts", () => {
    expect(
      ConfidenceBasisSchema.safeParse({
        distinct_sources: -1,
        contradiction_count: 0,
        stale_count: 0,
      }).success,
    ).toBe(false);
  });
});

describe("StrategicJudgment", () => {
  it("accepts a full judgment with 3 proposed options", () => {
    const parsed: StrategicJudgment = StrategicJudgmentSchema.parse(
      strategicJudgment([option("A", 1), option("B", 2), option("C", 3)]),
    );
    expect(parsed.proposed_options).toHaveLength(3);
  });

  it("accepts the graceful-degrade case (0 options)", () => {
    expect(
      StrategicJudgmentSchema.safeParse(strategicJudgment([])).success,
    ).toBe(true);
  });

  it("rejects a partial option set (§8: never fake A/B/C — 3 or 0 only)", () => {
    expect(
      StrategicJudgmentSchema.safeParse(
        strategicJudgment([option("A", 1), option("B", 2)]),
      ).success,
    ).toBe(false);
  });

  it("requires confidence_basis (V8.2 field)", () => {
    const j = strategicJudgment([]);
    delete j.confidence_basis;
    expect(StrategicJudgmentSchema.safeParse(j).success).toBe(false);
  });
});

describe("posture vocabulary divergence (pinned)", () => {
  it("StrategicJudgment (V8.1 base) accepts 'has_momentum'", () => {
    expect(
      StrategicJudgmentSchema.safeParse(strategicJudgment([])).success,
    ).toBe(true);
  });

  it("V8.2 PostureSchema accepts 'momentum' and rejects 'has_momentum'", () => {
    expect(PostureSchema.safeParse("momentum").success).toBe(true);
    expect(PostureSchema.safeParse("has_momentum").success).toBe(false);
  });
});

describe("Decomposition", () => {
  const angle = {
    objective: "what is the state of the CRM beta pilot?",
    tool_guidance: ["crm_query" as const],
    boundaries: { status_in: ["open", "blocked"], limit: 20 },
  };

  it("accepts up to 3 angles", () => {
    const d = {
      question: "CRM pilot state?",
      angles: [angle, angle, angle],
      generated_at: "2026-06-01T00:00:00.000Z",
    };
    expect(DecompositionSchema.parse(d).angles).toHaveLength(3);
  });

  it("rejects a 4th angle (§7 ≤3 cap)", () => {
    expect(
      DecompositionSchema.safeParse({
        question: "q",
        angles: [angle, angle, angle, angle],
        generated_at: "2026-06-01T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("accepts an empty tool_guidance (let retrieval choose)", () => {
    expect(
      DecompositionSchema.safeParse({
        question: "q",
        angles: [{ ...angle, tool_guidance: [] }],
        generated_at: "2026-06-01T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("rejects an objective over 120 chars", () => {
    expect(
      DecompositionSchema.safeParse({
        question: "q",
        angles: [{ ...angle, objective: "x".repeat(121) }],
        generated_at: "2026-06-01T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});
