/**
 * V8.2 Phase 8 — §12 confidence + §10 hedge-register tests.
 *
 * computeConfidence is deterministic; the contradiction term reads a real
 * in-memory DB (seed judgment + attributed_claims, mark some contradicted).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import {
  computeConfidence,
  countStale,
  detectRegister,
  downgradeColorFloor,
  expectedRegister,
  registerMatchesColor,
  freshnessWindowDays,
} from "./confidence.js";
import type { EvidenceRef } from "./types.js";

const NOW = "2026-06-03T12:00:00.000Z";

function ref(
  kind: EvidenceRef["kind"],
  id: string,
  retrieved_at = NOW,
): EvidenceRef {
  return { kind, id, excerpt: `${kind}:${id}`, retrieved_at };
}

beforeEach(() => initDatabase(":memory:"));
afterEach(() => {
  delete process.env.MC_RETRIEVAL_FRESHNESS_DAYS;
  closeDatabase();
});

// ── countStale ────────────────────────────────────────────────────────────────

describe("countStale", () => {
  it("operator_message is NEVER stale, however old", () => {
    expect(
      countStale([ref("operator_message", "o1", "2000-01-01T00:00:00.000Z")], {
        nowIso: NOW,
      }),
    ).toBe(0);
  });

  it("counts refs older than the window; fresh ones don't count", () => {
    const fresh = ref("task", "t1", "2026-06-01T00:00:00.000Z"); // 2d old
    const stale = ref("metric", "m1", "2026-05-01T00:00:00.000Z"); // ~33d old
    expect(countStale([fresh, stale], { nowIso: NOW, freshnessDays: 7 })).toBe(
      1,
    );
  });

  it("an unparseable retrieved_at counts as stale (can't prove freshness)", () => {
    expect(countStale([ref("task", "t1", "not-a-date")], { nowIso: NOW })).toBe(
      1,
    );
  });

  it("honors MC_RETRIEVAL_FRESHNESS_DAYS (default 7)", () => {
    expect(freshnessWindowDays()).toBe(7);
    process.env.MC_RETRIEVAL_FRESHNESS_DAYS = "30";
    expect(freshnessWindowDays()).toBe(30);
    const r = ref("task", "t1", "2026-05-20T00:00:00.000Z"); // ~14d old
    expect(countStale([r], { nowIso: NOW })).toBe(0); // within 30d
  });
});

// ── computeConfidence color boundaries ────────────────────────────────────────

describe("computeConfidence — color", () => {
  it("green = ≥3 distinct sources, 0 contradictions, 0 stale", () => {
    const r = computeConfidence(
      {
        evidenceRefs: [
          ref("task", "a"),
          ref("metric", "b"),
          ref("general_event", "c"),
        ],
      },
      { nowIso: NOW },
    );
    expect(r.color).toBe("green");
    expect(r.basis).toEqual({
      distinct_sources: 3,
      contradiction_count: 0,
      stale_count: 0,
    });
  });

  it("DISTINCT sources, not markers — [1][1] (same ref twice) is one source", () => {
    const r = computeConfidence(
      { evidenceRefs: [ref("task", "a"), ref("task", "a")] },
      { nowIso: NOW },
    );
    expect(r.basis.distinct_sources).toBe(1);
    expect(r.color).toBe("yellow"); // ≥1 ∧ contra≤1, but not ≥3
  });

  it("yellow = some support (≥1 distinct, ≤1 contradiction) but not green", () => {
    const r = computeConfidence(
      { evidenceRefs: [ref("task", "a"), ref("metric", "b")] },
      { nowIso: NOW },
    );
    expect(r.color).toBe("yellow");
  });

  it("3 sources but 1 stale → not green → yellow", () => {
    const r = computeConfidence(
      {
        evidenceRefs: [
          ref("task", "a"),
          ref("metric", "b"),
          ref("general_event", "c", "2026-01-01T00:00:00.000Z"), // stale
        ],
      },
      { nowIso: NOW, freshnessDays: 7 },
    );
    expect(r.basis.stale_count).toBe(1);
    expect(r.color).toBe("yellow");
  });

  it("red = no distinct sources (empty ledger)", () => {
    expect(computeConfidence({ evidenceRefs: [] }, { nowIso: NOW }).color).toBe(
      "red",
    );
  });

  it("reads the contradiction count from attributed_claims (P6 wiring)", () => {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO proposed_briefings (briefing_id, surface, generated_at, briefing_json, expires_at)
       VALUES ('b1','morning',?, '{}', '2999-01-01T00:00:00.000Z')`,
    ).run(NOW);
    const jid = Number(
      db
        .prepare(
          `INSERT INTO judgments (briefing_id, subject, posture, prose, created_at)
           VALUES ('b1','s','at_risk','p',?)`,
        )
        .run(NOW).lastInsertRowid,
    );
    // 2 distinct claims, both contradicted.
    for (const cid of [0, 1]) {
      db.prepare(
        `INSERT INTO attributed_claims
           (judgment_id, claim_id, claim_text, prose_offset, evidence_kind,
            evidence_id, evidence_excerpt, retrieved_at, resolver_status)
         VALUES (?, ?, 'c', 0, 'task', ?, 'e', ?, 'contradicted')`,
      ).run(jid, cid, `t${cid}`, NOW);
    }
    const r = computeConfidence(
      {
        judgmentId: jid,
        evidenceRefs: [
          ref("task", "a"),
          ref("metric", "b"),
          ref("general_event", "c"),
        ],
      },
      { nowIso: NOW, db },
    );
    expect(r.basis.contradiction_count).toBe(2);
    expect(r.color).toBe("red"); // 2 contradictions → not green, not yellow (≤1)
  });

  it("3 sources + exactly 1 contradiction → yellow (not green, contra≤1)", () => {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO proposed_briefings (briefing_id, surface, generated_at, briefing_json, expires_at)
       VALUES ('b2','morning',?, '{}', '2999-01-01T00:00:00.000Z')`,
    ).run(NOW);
    const jid = Number(
      db
        .prepare(
          `INSERT INTO judgments (briefing_id, subject, posture, prose, created_at)
           VALUES ('b2','s','at_risk','p',?)`,
        )
        .run(NOW).lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO attributed_claims
         (judgment_id, claim_id, claim_text, prose_offset, evidence_kind,
          evidence_id, evidence_excerpt, retrieved_at, resolver_status)
       VALUES (?, 0, 'c', 0, 'task', 't0', 'e', ?, 'contradicted')`,
    ).run(jid, NOW);
    const r = computeConfidence(
      {
        judgmentId: jid,
        evidenceRefs: [
          ref("task", "a"),
          ref("metric", "b"),
          ref("general_event", "c"),
        ],
      },
      { nowIso: NOW, db },
    );
    expect(r.basis.contradiction_count).toBe(1);
    expect(r.color).toBe("yellow");
  });
});

// ── hedge-register ────────────────────────────────────────────────────────────

describe("detectRegister", () => {
  it("direct = a flat declarative", () => {
    expect(detectRegister("The pilot is blocked.")).toBe("direct");
  });
  it("hedged = softeners (likely / appears / sugiere)", () => {
    expect(detectRegister("The pilot likely stalls.")).toBe("hedged");
    expect(detectRegister("Parece que el proyecto avanza.")).toBe("hedged");
  });
  it("uncertain = uncertainty markers or a trailing question", () => {
    expect(detectRegister("It may be at risk; evidence is thin.")).toBe(
      "uncertain",
    );
    expect(detectRegister("Is the pilot really on track?")).toBe("uncertain");
    expect(detectRegister("No queda claro si avanza.")).toBe("uncertain");
    // qa-W1: accented "quizá" (no trailing s) must NOT slip through as direct.
    expect(detectRegister("Quizá cierre el trato.")).toBe("uncertain");
    expect(detectRegister("quizás cierre")).toBe("uncertain");
  });
  it("uncertainty wins over hedging when both present", () => {
    expect(detectRegister("It likely stalls but it's unclear.")).toBe(
      "uncertain",
    );
  });
});

describe("expectedRegister / registerMatchesColor", () => {
  it("maps green→direct, yellow→hedged, red→uncertain", () => {
    expect(expectedRegister("green")).toBe("direct");
    expect(expectedRegister("yellow")).toBe("hedged");
    expect(expectedRegister("red")).toBe("uncertain");
  });
  it("matches when prose register equals the color's required register", () => {
    expect(registerMatchesColor("The pilot is blocked.", "green")).toBe(true);
    expect(registerMatchesColor("The pilot likely stalls.", "yellow")).toBe(
      true,
    );
    expect(registerMatchesColor("It may be at risk.", "red")).toBe(true);
  });
  it("mismatches over-confident prose for a low color (the dangerous case)", () => {
    expect(registerMatchesColor("The pilot is blocked.", "red")).toBe(false);
    expect(registerMatchesColor("The pilot is blocked.", "yellow")).toBe(false);
  });
});

describe("downgradeColorFloor — never upgrades", () => {
  it("downgrades green prose-uncertain → red", () => {
    expect(downgradeColorFloor("green", "It may be at risk.")).toBe("red");
  });
  it("downgrades green prose-hedged → yellow", () => {
    expect(downgradeColorFloor("green", "The pilot likely stalls.")).toBe(
      "yellow",
    );
  });
  it("does NOT upgrade: red color + direct prose stays red", () => {
    expect(downgradeColorFloor("red", "The pilot is blocked.")).toBe("red");
  });
  it("does NOT upgrade: yellow color + direct prose stays yellow", () => {
    expect(downgradeColorFloor("yellow", "The pilot is blocked.")).toBe(
      "yellow",
    );
  });
  it("aligned green + direct stays green", () => {
    expect(downgradeColorFloor("green", "The pilot is blocked.")).toBe("green");
  });
});
