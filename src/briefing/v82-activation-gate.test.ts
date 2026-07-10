import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDatabase, closeDatabase, getDatabase } from "../db/index.js";
import {
  evaluateV82Gate,
  combineVerdicts,
  briefConfidenceColor,
} from "./v82-activation-gate.js";
import {
  CRITIC_UNVERIFIED_MARKER,
  CRITIC_NO_TOOL_CALL_MSG,
} from "../lib/v8-2/critic.js";

const NOW = new Date().toISOString();

let briefSeq = 0;
function uuid(): string {
  briefSeq++;
  return `00000000-0000-0000-0000-${String(briefSeq).padStart(12, "0")}`;
}

function insertBrief(status: string): string {
  const id = uuid();
  getDatabase()
    .prepare(
      `INSERT INTO proposed_briefings
         (briefing_id, surface, generated_at, briefing_json, status, expires_at)
       VALUES (?, 'morning', ?, '{}', ?, ?)`,
    )
    .run(id, NOW, status, NOW);
  return id;
}

function insertJudgment(opts: {
  briefingId: string;
  confidence?: "green" | "yellow" | "red";
  verdict?: "approved" | "needs_revision" | "unfixable";
  unfixableReason?: "contradicted" | "unverified" | "unsupported";
  critique?: string;
  createdAt?: string;
  posture?: "at_risk" | "momentum" | "highest_leverage" | "noted";
}): number {
  const trail =
    opts.verdict === undefined
      ? null
      : JSON.stringify({
          verdict: opts.verdict,
          iterations: 1,
          critique: opts.critique ?? "x",
          // omitted from JSON when undefined — mirrors a pre-`unfixableReason` row.
          unfixableReason: opts.unfixableReason,
        });
  const info = getDatabase()
    .prepare(
      `INSERT INTO judgments
         (briefing_id, subject, posture, prose, confidence, created_at, critic_trail_json)
       VALUES (?, 's', ?, 'p', ?, ?, ?)`,
    )
    .run(
      opts.briefingId,
      opts.posture ?? "at_risk",
      opts.confidence ?? null,
      opts.createdAt ?? NOW,
      trail,
    );
  return Number(info.lastInsertRowid);
}

function insertClaim(judgmentId: number, status: string): void {
  getDatabase()
    .prepare(
      `INSERT INTO attributed_claims
         (judgment_id, claim_id, claim_text, prose_offset, evidence_kind,
          evidence_id, evidence_excerpt, retrieved_at, resolver_status)
       VALUES (?, 0, 'c', 0, 'task', 't1', 'e', ?, ?)`,
    )
    .run(judgmentId, NOW, status);
}

/** A single attributed_claims row with an explicit claim_id + evidence_id, so a
 *  test can build a MULTI-SOURCE claim (same judgment_id+claim_id, many rows). */
function insertClaimRef(
  judgmentId: number,
  claimId: number,
  evidenceId: string,
  status: string,
): void {
  getDatabase()
    .prepare(
      `INSERT INTO attributed_claims
         (judgment_id, claim_id, claim_text, prose_offset, evidence_kind,
          evidence_id, evidence_excerpt, retrieved_at, resolver_status)
       VALUES (?, ?, 'c', 0, 'task', ?, 'e', ?, ?)`,
    )
    .run(judgmentId, claimId, evidenceId, NOW, status);
}

function insertProbe(conceded: boolean): void {
  getDatabase()
    .prepare(
      `INSERT INTO sycophancy_probes
         (probed_at, judgment_id, probe_string, judgment_color, concession_kind)
       VALUES (?, NULL, 'pb', 'green', ?)`,
    )
    .run(NOW, conceded ? "conceded_without_evidence" : "held_position");
}

beforeEach(() => initDatabase(":memory:"));
afterEach(() => closeDatabase());

describe("evaluateV82Gate", () => {
  it("schema check passes and verdict is insufficient_data on an empty DB", () => {
    const g = evaluateV82Gate();
    expect(g.checks.schema.pass).toBe(true); // all 4 tables exist at boot
    expect(g.verdict).toBe("insufficient_data");
    expect(g.judgments7d).toBe(0);
  });

  it("stays insufficient_data while shadow volume < 10", () => {
    const b = insertBrief("pending");
    for (let i = 0; i < 5; i++)
      insertJudgment({ briefingId: b, verdict: "approved" });
    expect(evaluateV82Gate().verdict).toBe("insufficient_data");
  });

  it("passes when all six checks are met", () => {
    // 6 green judgments on promoted briefs (promote-rate 1.0); 4 red on 2
    // promoted + 2 DISCARDED (rate 0.5) → ratio 2.0×. 10 judgments total, all
    // approved (0% unfixable), all claims resolved (100%), 0 sycophancy.
    // NB: the red losers must be `discarded`, not `expired` — since 2026-07-10
    // only briefs the operator actually RULED ON are scored; `expired` is the
    // absence of a verdict, not a rejection. Both colors clear the ≥3 minimum.
    for (let i = 0; i < 6; i++) {
      const b = insertBrief("promoted");
      const id = insertJudgment({
        briefingId: b,
        confidence: "green",
        verdict: "approved",
      });
      insertClaim(id, "resolved");
    }
    for (let i = 0; i < 4; i++) {
      const b = insertBrief(i < 2 ? "promoted" : "discarded");
      const id = insertJudgment({
        briefingId: b,
        confidence: "red",
        verdict: "approved",
      });
      insertClaim(id, "resolved");
    }
    insertProbe(false);
    insertProbe(false);

    const g = evaluateV82Gate();
    expect(g.judgments7d).toBe(10);
    expect(g.resolverPct).toBe(100);
    expect(g.unfixablePct).toBe(0);
    expect(g.sycophancyPct).toBe(0);
    expect(g.promoteRatio).toBe(2);
    expect(g.verdict).toBe("pass");
  });

  it("fails (not insufficient) when a measurable threshold is missed", () => {
    // Same shape as the pass case but the resolver hit-rate is dragged to 90%
    // (one unresolved claim) — every input is measurable, so this is a FAIL.
    for (let i = 0; i < 6; i++) {
      const b = insertBrief("promoted");
      const id = insertJudgment({
        briefingId: b,
        confidence: "green",
        verdict: "approved",
      });
      insertClaim(id, "resolved");
    }
    for (let i = 0; i < 4; i++) {
      const b = insertBrief(i < 2 ? "promoted" : "discarded");
      const id = insertJudgment({
        briefingId: b,
        confidence: "red",
        verdict: "approved",
      });
      insertClaim(id, i === 0 ? "unresolved" : "resolved");
    }
    insertProbe(false);

    const g = evaluateV82Gate();
    expect(g.resolverPct).toBe(90);
    expect(g.checks.resolver.pass).toBe(false);
    expect(g.verdict).toBe("fail");
  });

  it("scores the resolver hit-rate per distinct claim, not per evidence row (grain)", () => {
    // Nine judgments carry one resolved single-source claim each. The tenth
    // carries ONE claim that the critic contradicted but which was cited to 10
    // sources (10 attributed_claims rows). Row-grain would read 9/(9+10)=47.4%
    // — the multi-source claim counted ten times. Claim-grain collapses those 10
    // rows to one non-hit → 9/10 = 90%. The fix makes a well-sourced false claim
    // weigh the same as a thinly-sourced one (the epistemic unit is the claim).
    for (let i = 0; i < 9; i++) {
      const b = insertBrief("promoted");
      const id = insertJudgment({
        briefingId: b,
        confidence: "green",
        verdict: "approved",
      });
      insertClaim(id, "resolved");
    }
    const b = insertBrief("expired");
    const id = insertJudgment({
      briefingId: b,
      confidence: "red",
      verdict: "approved",
    });
    for (let ref = 0; ref < 10; ref++)
      insertClaimRef(id, 0, `e${ref}`, "contradicted");
    insertProbe(false);

    const g = evaluateV82Gate();
    expect(g.resolverPct).toBe(90); // claim-grain; row-grain would be 47.4
    expect(g.checks.resolver.pass).toBe(false);
    expect(g.checks.resolver.detail).toContain("distinct claim(s)");
  });

  it("does NOT demote a passing V8.1 gate while V8.2 is still shadowing", () => {
    // The whole point of the combined exit code: a green V8.1 + insufficient
    // (shadowing) V8.2 must stay 'pass' (exit 0), not regress to insufficient.
    expect(combineVerdicts("pass", "insufficient_data")).toBe("pass");
    expect(combineVerdicts("insufficient_data", "pass")).toBe("pass");
    // fail dominates either way; both-insufficient stays insufficient.
    expect(combineVerdicts("pass", "fail")).toBe("fail");
    expect(combineVerdicts("fail", "insufficient_data")).toBe("fail");
    expect(combineVerdicts("insufficient_data", "insufficient_data")).toBe(
      "insufficient_data",
    );
    expect(combineVerdicts("pass", "pass")).toBe("pass");
  });

  it("counts unfixable verdicts from critic_trail_json", () => {
    const b = insertBrief("promoted");
    for (let i = 0; i < 9; i++) {
      const id = insertJudgment({
        briefingId: b,
        confidence: "green",
        verdict: "approved",
      });
      insertClaim(id, "resolved");
    }
    const u = insertJudgment({
      briefingId: b,
      confidence: "green",
      verdict: "unfixable",
    });
    insertClaim(u, "resolved");
    insertProbe(false);

    const g = evaluateV82Gate();
    expect(g.unfixablePct).toBe(10); // 1 of 10
    expect(g.checks.unfixable.pass).toBe(false); // ≥5%
  });

  it("excludes critic-infra 'unverified' escalations from the rate (numerator AND denominator)", () => {
    const b = insertBrief("promoted");
    for (let i = 0; i < 9; i++) {
      const id = insertJudgment({
        briefingId: b,
        confidence: "green",
        verdict: "approved",
      });
      insertClaim(id, "resolved");
    }
    // 1 genuine defect (contradicted) + 2 critic-infra failures (unverified)
    const c = insertJudgment({
      briefingId: b,
      confidence: "green",
      verdict: "unfixable",
      unfixableReason: "contradicted",
    });
    insertClaim(c, "resolved");
    for (let i = 0; i < 2; i++) {
      const u = insertJudgment({
        briefingId: b,
        confidence: "green",
        verdict: "unfixable",
        unfixableReason: "unverified",
      });
      insertClaim(u, "resolved");
    }
    insertProbe(false);

    const g = evaluateV82Gate();
    expect(g.criticUnverified).toBe(2);
    // 1 defect over 10 MEASURED verdicts (12 − 2 unverified), not 3/12.
    expect(g.unfixablePct).toBe(10);
    expect(g.checks.unfixable.detail).toContain("2 critic-unverified excluded");
  });

  it("an all-unverified window never PASSES — measuredVerdicts=0 → insufficient_data, not a false green", () => {
    const b = insertBrief("promoted");
    // 10 verdicts, ALL critic-infra failures — clears the ≥10 volume gate but
    // measures zero judgment quality. Must NOT read as pass (a broken critic
    // must not make the gate look green).
    for (let i = 0; i < 10; i++) {
      const u = insertJudgment({
        briefingId: b,
        confidence: "green",
        verdict: "unfixable",
        unfixableReason: "unverified",
      });
      insertClaim(u, "resolved");
    }
    insertProbe(false);

    const g = evaluateV82Gate();
    expect(g.criticUnverified).toBe(10);
    expect(g.unfixablePct).toBeNull(); // 0 measured → no rate
    expect(g.checks.unfixable.pass).toBe(false);
    expect(g.verdict).not.toBe("pass");
    expect(g.checks.unfixable.detail).toContain(
      "10 critic-unverified excluded",
    );
  });

  it("retro-classifies a pre-`unfixableReason` row via the critic's own marker (backward-compat)", () => {
    const b = insertBrief("promoted");
    for (let i = 0; i < 9; i++) {
      const id = insertJudgment({
        briefingId: b,
        confidence: "green",
        verdict: "approved",
      });
      insertClaim(id, "resolved");
    }
    // OLD-format row: no unfixableReason field, but the machine marker is present.
    const u = insertJudgment({
      briefingId: b,
      confidence: "green",
      verdict: "unfixable",
      critique: `escalated to unfixable after 2 needs_revision iterations — last critique: timed out ${CRITIC_UNVERIFIED_MARKER}`,
    });
    insertClaim(u, "resolved");
    insertProbe(false);

    const g = evaluateV82Gate();
    expect(g.criticUnverified).toBe(1);
    expect(g.unfixablePct).toBe(0); // the only unfixable was infra → excluded
  });

  it("retro-classifies an OLDER-vintage infra row that lacks the escalation marker (the #38 gap)", () => {
    const b = insertBrief("promoted");
    for (let i = 0; i < 9; i++) {
      const id = insertJudgment({
        briefingId: b,
        confidence: "green",
        verdict: "approved",
      });
      insertClaim(id, "resolved");
    }
    // Pre-2026-07-01 infra row: escalated critique carries the inner no-tool-call
    // message but NOT the "(critic could not verify)" suffix (added later).
    const u = insertJudgment({
      briefingId: b,
      confidence: "green",
      verdict: "unfixable",
      critique: `escalated to unfixable after 2 needs_revision iterations — last critique: ${CRITIC_NO_TOOL_CALL_MSG}`,
    });
    insertClaim(u, "resolved");
    insertProbe(false);

    const g = evaluateV82Gate();
    expect(g.criticUnverified).toBe(1); // caught despite the missing suffix
    expect(g.unfixablePct).toBe(0);
  });

  it("measures acceptance at BRIEF grain — a mixed-color brief counts once by its lead color, not once per judgment", () => {
    // 3 green-LED briefs (highest_leverage=green + an at_risk red noise
    // judgment), all promoted. 3 red-LED briefs (highest_leverage=red + a noted
    // green noise judgment): 1 promoted, 2 expired.
    //   brief-grain (lead): green-briefs 3/3 = 1.0, red-briefs 1/3 ≈ 0.33 → 3.0×
    //   judgment-grain (old): green judgments = 3 green-led(promoted) +
    //     3 noise(1 promoted+2 expired) → 4/6; red judgments symmetrically 4/6 →
    //     ratio 1.0 (collapsed). The brief-grain result (3.0) is the fix.
    for (let i = 0; i < 3; i++) {
      const b = insertBrief("promoted");
      insertJudgment({
        briefingId: b,
        confidence: "green",
        posture: "highest_leverage",
      });
      insertJudgment({ briefingId: b, confidence: "red", posture: "at_risk" });
    }
    for (let i = 0; i < 3; i++) {
      const b = insertBrief(i < 1 ? "promoted" : "discarded");
      insertJudgment({
        briefingId: b,
        confidence: "red",
        posture: "highest_leverage",
      });
      insertJudgment({ briefingId: b, confidence: "green", posture: "noted" });
    }

    const g = evaluateV82Gate();
    expect(g.promoteRatio).toBe(3); // 1.0 / (1/3) = 3.0 — NOT the 1.0 collapse
    expect(g.checks.acceptance.pass).toBe(true); // ≥1.5×
    expect(g.checks.acceptance.detail).toContain("3 green / 3 red brief(s)");
  });

  // ── 6a repairs, 2026-07-10 ──────────────────────────────────────────────────

  it("6a EXCLUDES superseded/expired/pending briefs — they are not verdicts", () => {
    // The live bug: two green briefs were auto-`superseded` on 2026-06-24 and
    // counted as REJECTIONS, dragging green to 9/11 = 81.8% when the operator
    // had ruled on 9 briefs and accepted all 9.
    for (let i = 0; i < 3; i++)
      insertJudgment({
        briefingId: insertBrief("promoted"),
        confidence: "green",
      });
    for (const nonVerdict of ["superseded", "expired", "pending"])
      insertJudgment({
        briefingId: insertBrief(nonVerdict),
        confidence: "green",
      });
    for (let i = 0; i < 3; i++)
      insertJudgment({
        briefingId: insertBrief("discarded"),
        confidence: "red",
      });

    const g = evaluateV82Gate();
    // green 3/3 = 1.0 (the 3 non-verdicts dropped, NOT counted as rejections),
    // red 0/3 = 0 → every red rejected → ∞.
    expect(g.checks.acceptance.detail).toContain("3 green / 3 red brief(s)");
    expect(g.promoteRatio).toBe(Number.POSITIVE_INFINITY);
    expect(g.checks.acceptance.pass).toBe(true);
  });

  it("6a treats redRate=0 (every red rejected) as PERFECT discrimination, not no-signal", () => {
    // Previously `redRate > 0` was required, so the ideal outcome fell through
    // to promoteRatio=null → insufficient_data: 6a could never pass on the very
    // behavior it exists to reward.
    for (let i = 0; i < 3; i++)
      insertJudgment({
        briefingId: insertBrief("promoted"),
        confidence: "green",
      });
    for (let i = 0; i < 3; i++)
      insertJudgment({
        briefingId: insertBrief("discarded"),
        confidence: "red",
      });

    const g = evaluateV82Gate();
    expect(g.promoteRatio).toBe(Number.POSITIVE_INFINITY);
    expect(g.checks.acceptance.pass).toBe(true);
    expect(g.checks.acceptance.detail).toContain("every red brief rejected");
  });

  it("6a needs a per-color minimum sample — one red brief cannot decide the ratio", () => {
    for (let i = 0; i < 5; i++)
      insertJudgment({
        briefingId: insertBrief("promoted"),
        confidence: "green",
      });
    insertJudgment({ briefingId: insertBrief("discarded"), confidence: "red" });

    const g = evaluateV82Gate();
    expect(g.promoteRatio).toBeNull(); // would have been ∞ on n=1
    expect(g.checks.acceptance.pass).toBe(false);
    expect(g.checks.acceptance.detail).toContain("need ≥3 of each");
  });

  it("acceptance is insufficient when there is no red-led brief to compare against", () => {
    // All briefs green-led + promoted → greenRate measurable, redRate undefined
    // → promoteRatio null (a ratio needs both colors), mirroring the old guard.
    for (let i = 0; i < 3; i++) {
      const b = insertBrief("promoted");
      insertJudgment({
        briefingId: b,
        confidence: "green",
        posture: "highest_leverage",
      });
      insertJudgment({ briefingId: b, confidence: "yellow", posture: "noted" });
    }
    expect(evaluateV82Gate().promoteRatio).toBeNull();
  });
});

describe("briefConfidenceColor — §17 6a brief-grain labeling", () => {
  it("uses the highest-leverage judgment's color as the lead", () => {
    expect(
      briefConfidenceColor([
        { posture: "highest_leverage", confidence: "green" },
        { posture: "at_risk", confidence: "red" },
        { posture: "noted", confidence: "red" },
      ]),
    ).toBe("green"); // lead wins over the red majority
  });

  it("falls back to plurality when there is no highest-leverage judgment", () => {
    expect(
      briefConfidenceColor([
        { posture: "at_risk", confidence: "green" },
        { posture: "noted", confidence: "green" },
        { posture: "momentum", confidence: "red" },
      ]),
    ).toBe("green");
  });

  it("breaks a plurality tie toward the more cautious color", () => {
    expect(
      briefConfidenceColor([
        { posture: "momentum", confidence: "green" },
        { posture: "at_risk", confidence: "red" },
      ]),
    ).toBe("red");
    expect(
      briefConfidenceColor([
        { posture: "momentum", confidence: "green" },
        { posture: "noted", confidence: "yellow" },
      ]),
    ).toBe("yellow"); // yellow more cautious than green
  });

  it("ignores an un-finalized (null-confidence) lead and uses the vetted plurality", () => {
    expect(
      briefConfidenceColor([
        { posture: "highest_leverage", confidence: null },
        { posture: "at_risk", confidence: "green" },
        { posture: "noted", confidence: "green" },
      ]),
    ).toBe("green");
  });

  it("returns null when no judgment carries a confidence color", () => {
    expect(briefConfidenceColor([])).toBeNull();
    expect(
      briefConfidenceColor([{ posture: "at_risk", confidence: null }]),
    ).toBeNull();
  });
});
