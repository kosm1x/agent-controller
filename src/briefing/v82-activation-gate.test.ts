import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDatabase, closeDatabase, getDatabase } from "../db/index.js";
import {
  evaluateV82Gate,
  combineVerdicts,
  COMBINED_VERDICT_LABEL,
} from "./v82-activation-gate.js";
import type { GateVerdict } from "./v82-activation-gate.js";
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

  it("passes when all five checks are met", () => {
    // 10 judgments over a mixed-color, mixed-verdict window: all approved (0%
    // unfixable), all claims resolved (100%), 0 sycophancy. The green/red and
    // promoted/discarded spread is incidental since 6a's removal (2026-08-02) —
    // kept so the fixture still exercises a realistic window rather than a
    // uniform one.
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

  it("combines as TRUE worst-of-two — an un-measurable gate is never reported as met", () => {
    // 2026-08-02 (audit C1): this was `||`-pass — green if EITHER gate was
    // green — an exception that existed only because 6a pinned §17
    // non-green for the whole shadow run. Removing 6a inverted it: §17's
    // permanent pass masked a §13 gone `insufficient_data` (which happens on
    // any week with < GATE_MIN_RULED_BRIEFS operator verdicts), reporting exit
    // 0 for the only check that still measures human usefulness.
    expect(combineVerdicts("pass", "insufficient_data")).toBe(
      "insufficient_data",
    );
    expect(combineVerdicts("insufficient_data", "pass")).toBe(
      "insufficient_data",
    );
    // fail still dominates everything, from either side.
    expect(combineVerdicts("pass", "fail")).toBe("fail");
    expect(combineVerdicts("fail", "insufficient_data")).toBe("fail");
    expect(combineVerdicts("insufficient_data", "insufficient_data")).toBe(
      "insufficient_data",
    );
    // Exit 0 requires BOTH green — what scripts/briefing-gate.ts documents.
    expect(combineVerdicts("pass", "pass")).toBe("pass");
  });

  it("labels every combined verdict, and each label states the exit code its caller returns", () => {
    // The label map lived in scripts/briefing-gate.ts until 2026-08-02 (audit
    // R3 W3), where `Record<GateVerdict, string>` is NOT enforced — tsconfig
    // includes only src/**, so a missing key would have rendered `undefined`
    // to the operator with typecheck clean. This test is the second half of
    // that fix: it also pins label↔exit-code agreement, which no type can.
    const EXIT_CODE: Record<GateVerdict, number> = {
      pass: 0,
      fail: 1,
      insufficient_data: 2,
    };
    for (const verdict of Object.keys(EXIT_CODE) as GateVerdict[]) {
      const label = COMBINED_VERDICT_LABEL[verdict];
      expect(label, `no label for '${verdict}'`).toBeTruthy();
      expect(
        label,
        `'${verdict}' label must state exit ${EXIT_CODE[verdict]}`,
      ).toContain(`exit ${EXIT_CODE[verdict]}`);
    }
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
    // qa S2: this row has NO persisted reason and NO infra marker — the
    // documented legacy default classifies it `contradicted` in the breakdown.
    expect(g.unfixableBreakdown).toEqual({ contradicted: 1, unsupported: 0 });
  });

  it("scores unfixables over a 30d window — an 8-day-old defect still counts (7d would miss it)", () => {
    // 2026-08-14: check 4 widened from 7d to 30d — at ~20 verdicts/7d a <5%
    // threshold was zero-tolerance (one unfixable = 5% = fail). The volume
    // check deliberately stays 7d (tempo), so the old row must not affect it.
    const b = insertBrief("promoted");
    for (let i = 0; i < 10; i++) {
      const id = insertJudgment({
        briefingId: b,
        confidence: "green",
        verdict: "approved",
      });
      insertClaim(id, "resolved");
    }
    const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
    insertJudgment({
      briefingId: b,
      confidence: "green",
      verdict: "unfixable",
      unfixableReason: "unsupported",
      createdAt: old,
    });
    insertProbe(false);

    const g = evaluateV82Gate();
    expect(g.judgments7d).toBe(10); // volume window unchanged — old row outside
    expect(g.unfixablePct).toBe(9.1); // 1 of 11 measured verdicts in 30d
    expect(g.checks.unfixable.pass).toBe(false);
    expect(g.checks.unfixable.detail).toContain("in 30d");
  });

  it("breaks the counted unfixables down by defect class in the result and the detail", () => {
    const b = insertBrief("promoted");
    for (let i = 0; i < 17; i++) {
      const id = insertJudgment({
        briefingId: b,
        confidence: "green",
        verdict: "approved",
      });
      insertClaim(id, "resolved");
    }
    insertJudgment({
      briefingId: b,
      confidence: "green",
      verdict: "unfixable",
      unfixableReason: "contradicted",
    });
    for (let i = 0; i < 2; i++) {
      insertJudgment({
        briefingId: b,
        confidence: "green",
        verdict: "unfixable",
        unfixableReason: "unsupported",
      });
    }
    insertProbe(false);

    const g = evaluateV82Gate();
    expect(g.unfixableBreakdown).toEqual({ contradicted: 1, unsupported: 2 });
    expect(g.unfixablePct).toBe(15); // 3 of 20
    expect(g.checks.unfixable.detail).toContain(
      "contradicted: 1 · unsupported: 2",
    );
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
    // qa S2: infra rows are excluded from the breakdown too, not mislabelled.
    expect(g.unfixableBreakdown).toEqual({ contradicted: 0, unsupported: 0 });
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

  // 2026-08-02: §17 check 6a (green/red brief promote ratio) was REMOVED — see
  // the module doc. This locks in the behavioral consequence: a window with no
  // red-led brief at all used to force `insufficient_data` (a ratio needs both
  // colors), so §17 could never go green on a run of well-evidenced briefs.
  it("passes on an all-green window — §17 no longer needs a red sample to compare against", () => {
    for (let i = 0; i < 10; i++) {
      const b = insertBrief("promoted");
      const id = insertJudgment({
        briefingId: b,
        confidence: "green",
        posture: "highest_leverage",
        verdict: "approved",
      });
      insertClaim(id, "resolved");
    }
    insertProbe(false);

    const g = evaluateV82Gate();
    expect(g.verdict).toBe("pass"); // was insufficient_data while 6a existed
    expect(Object.keys(g.checks)).not.toContain("acceptance");
  });
});
