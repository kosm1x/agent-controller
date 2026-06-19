import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDatabase, closeDatabase, getDatabase } from "../db/index.js";
import { evaluateV82Gate, combineVerdicts } from "./v82-activation-gate.js";

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
  createdAt?: string;
}): number {
  const trail =
    opts.verdict === undefined
      ? null
      : JSON.stringify({ verdict: opts.verdict, iterations: 1, critique: "x" });
  const info = getDatabase()
    .prepare(
      `INSERT INTO judgments
         (briefing_id, subject, posture, prose, confidence, created_at, critic_trail_json)
       VALUES (?, 's', 'at_risk', 'p', ?, ?, ?)`,
    )
    .run(
      opts.briefingId,
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
    // promoted + 2 expired (rate 0.5) → ratio 2.0×. 10 judgments total, all
    // approved (0% unfixable), all claims resolved (100%), 0 sycophancy.
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
      const b = insertBrief(i < 2 ? "promoted" : "expired");
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
      const b = insertBrief(i < 2 ? "promoted" : "expired");
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
});
