/**
 * `judgments-store` statements on the real schema (`initDatabase(":memory:")`),
 * asserting the exact rows each statement returns or changes. Every keyed read
 * or write targets the MIDDLE of three rows, so a neighbour on either side of
 * the key must stay out of the result or untouched, and a lookup of a key below
 * the lowest one returns nothing. The callers' tests (produce, concession,
 * delivery, inspector) run these statements but do not all look at what they
 * return; these cases pin the statement itself.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import {
  appendEvidenceRef,
  countJudgmentsForBriefing,
  getAttributedClaimRows,
  getJudgmentById,
  getJudgmentClaimSummary,
  getJudgmentsForBriefing,
  setConcessionKind,
  updateJudgmentEvidenceRefs,
  updateJudgmentProse,
  updateJudgmentVerdict,
} from "./judgments-store.js";
import type { EvidenceRef } from "./types.js";

const FUTURE = "2030-01-01T00:00:00.000Z";
const T0 = "2026-06-02T00:00:00.000Z";

beforeEach(() => initDatabase(":memory:"));
afterEach(() => closeDatabase());

/** A `proposed_briefings` parent row (FK target of `judgments.briefing_id`). */
function seedBriefing(id: string): void {
  getDatabase()
    .prepare(
      `INSERT INTO proposed_briefings (briefing_id, surface, generated_at, briefing_json, expires_at)
       VALUES (?,?,?,?,?)`,
    )
    .run(id, "morning", T0, "{}", FUTURE);
}

function seedJudgment(
  briefingId: string,
  subject: string,
  refs: EvidenceRef[] | null = null,
): number {
  const info = getDatabase()
    .prepare(
      `INSERT INTO judgments (briefing_id, subject, posture, prose, created_at, evidence_refs_json)
       VALUES (?,?,?,?,?,?)`,
    )
    .run(
      briefingId,
      subject,
      "at_risk",
      `prose of ${subject}`,
      T0,
      refs === null ? null : JSON.stringify(refs),
    );
  return Number(info.lastInsertRowid);
}

function ref(tag: string): EvidenceRef {
  return { kind: "task", id: `t-${tag}`, excerpt: `excerpt ${tag}`, retrieved_at: T0 };
}

/** Three judgments of one briefing (low, mid, high ids), each with its own refs. */
function threeJudgments(): { low: number; mid: number; high: number } {
  seedBriefing("b-b");
  return {
    low: seedJudgment("b-b", "low", [ref("low")]),
    mid: seedJudgment("b-b", "mid", [ref("mid")]),
    high: seedJudgment("b-b", "high", [ref("high")]),
  };
}

function judgmentRow(id: number): Record<string, unknown> {
  return getDatabase().prepare(`SELECT * FROM judgments WHERE id = ?`).get(id) as Record<
    string,
    unknown
  >;
}

function seedClaim(
  judgmentId: number,
  claimId: number,
  tag: string,
  status: string,
  kind = "task",
): void {
  getDatabase()
    .prepare(
      `INSERT INTO attributed_claims
         (judgment_id, claim_id, claim_text, evidence_kind, evidence_id,
          evidence_excerpt, retrieved_at, resolver_status)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(
      judgmentId,
      claimId,
      `claim ${tag}`,
      kind,
      `ev-${tag}`,
      `excerpt ${tag}`,
      `2026-06-02T00:00:0${claimId}.000Z`,
      status,
    );
}

describe("countJudgmentsForBriefing", () => {
  // The §13 concession path engages only when THIS briefing carries judgments;
  // another briefing's judgments, on either side of its id, must not open it.
  it("counts only the named briefing's judgments", () => {
    for (const b of ["b-c", "b-a", "b-b", "b-empty"]) seedBriefing(b);
    seedJudgment("b-c", "c1");
    seedJudgment("b-b", "b1");
    seedJudgment("b-c", "c2");
    seedJudgment("b-a", "a1");
    seedJudgment("b-c", "c1"); // same subject as another row: every row counts
    seedJudgment("b-b", "b2");
    expect(countJudgmentsForBriefing("b-a")).toBe(1);
    expect(countJudgmentsForBriefing("b-b")).toBe(2);
    expect(countJudgmentsForBriefing("b-c")).toBe(3);
    expect(countJudgmentsForBriefing("b-empty")).toBe(0);
    expect(countJudgmentsForBriefing("b-0")).toBe(0); // below every seeded id
  });
});

describe("getJudgmentsForBriefing", () => {
  // Delivery renders the strategic section in this order, so the rows come back
  // id-ascending — not by subject — and only the named briefing's rows.
  it("returns only the named briefing's judgments, in id order", () => {
    for (const b of ["b-a", "b-b", "b-c"]) seedBriefing(b);
    seedJudgment("b-a", "lower briefing");
    const first = seedJudgment("b-b", "zulu");
    seedJudgment("b-c", "higher briefing");
    const second = seedJudgment("b-b", "alpha");
    const third = seedJudgment("b-b", "mike");
    // created_at runs against id order, so neither it nor subject can stand in for id.
    const setCreated = getDatabase().prepare(`UPDATE judgments SET created_at = ? WHERE id = ?`);
    setCreated.run("2026-06-02T03:00:00.000Z", first);
    setCreated.run("2026-06-02T02:00:00.000Z", second);
    setCreated.run("2026-06-02T01:00:00.000Z", third);
    expect(getJudgmentsForBriefing("b-b").map((r) => [r.id, r.subject])).toEqual([
      [first, "zulu"],
      [second, "alpha"],
      [third, "mike"],
    ]);
    expect(getJudgmentsForBriefing("b-0")).toEqual([]);
  });
});

describe("getJudgmentById", () => {
  // The concession handler restates exactly the judgment the operator disputed.
  it("returns the named judgment, and null for an absent id on either side", () => {
    const { low, mid, high } = threeJudgments();
    expect(getJudgmentById(mid)).toMatchObject({
      id: mid,
      briefingId: "b-b",
      subject: "mid",
      prose: "prose of mid",
      evidenceRefsJson: JSON.stringify([ref("mid")]),
    });
    expect(getJudgmentById(low)?.subject).toBe("low");
    expect(getJudgmentById(high)?.subject).toBe("high");
    expect(getJudgmentById(low - 1)).toBeNull();
    expect(getJudgmentById(high + 1)).toBeNull();
  });
});

describe("getJudgmentClaimSummary", () => {
  // Each bucket counts its own resolver status (distinct counts, so a bucket
  // reading another status shows a wrong number), and only this judgment's
  // claims — not a neighbour's on either side.
  it("puts each claim in its own status bucket, and only this judgment's claims", () => {
    const { low, mid, high } = threeJudgments();
    const statuses: Array<[number, string]> = [
      [mid, "unresolved"], [low, "resolved"], [mid, "contradicted"],
      [mid, "stale"], [mid, "unresolved"], [high, "stale"],
      [mid, "contradicted"], [mid, "resolved"], [mid, "unresolved"],
      [mid, "stale"], [mid, "contradicted"], [mid, "unresolved"],
      [high, "unresolved"],
    ];
    statuses.forEach(([jid, status], i) => seedClaim(jid, i % 10, `c${i}`, status));
    expect(getJudgmentClaimSummary(mid)).toEqual({
      total: 10,
      resolved: 1,
      stale: 2,
      contradicted: 3,
      unresolved: 4,
    });
    expect(getJudgmentClaimSummary(low - 1)).toEqual({
      total: 0,
      resolved: 0,
      stale: 0,
      contradicted: 0,
      unresolved: 0,
    });
  });
});

describe("getAttributedClaimRows", () => {
  // The detail view lists one judgment's claims ordered by claim, then by row;
  // the seeds are inserted out of claim order, and neighbours' claims on both
  // sides stay out.
  it("returns only the judgment's claims, ordered by claim_id then row", () => {
    const { low, mid, high } = threeJudgments();
    seedClaim(low, 0, "low", "resolved");
    seedClaim(mid, 2, "m-a", "stale", "kb_entry");
    seedClaim(mid, 0, "m-b", "resolved", "metric");
    seedClaim(high, 1, "high", "resolved");
    seedClaim(mid, 2, "m-c", "contradicted", "conversation");
    seedClaim(mid, 1, "m-d", "unresolved");
    expect(getAttributedClaimRows(mid)).toEqual([
      {
        claimId: 0,
        claimText: "claim m-b",
        evidenceKind: "metric",
        evidenceId: "ev-m-b",
        evidenceExcerpt: "excerpt m-b",
        resolverStatus: "resolved",
        retrievedAt: "2026-06-02T00:00:00.000Z",
      },
      {
        claimId: 1,
        claimText: "claim m-d",
        evidenceKind: "task",
        evidenceId: "ev-m-d",
        evidenceExcerpt: "excerpt m-d",
        resolverStatus: "unresolved",
        retrievedAt: "2026-06-02T00:00:01.000Z",
      },
      {
        claimId: 2,
        claimText: "claim m-a",
        evidenceKind: "kb_entry",
        evidenceId: "ev-m-a",
        evidenceExcerpt: "excerpt m-a",
        resolverStatus: "stale",
        retrievedAt: "2026-06-02T00:00:02.000Z",
      },
      {
        claimId: 2,
        claimText: "claim m-c",
        evidenceKind: "conversation",
        evidenceId: "ev-m-c",
        evidenceExcerpt: "excerpt m-c",
        resolverStatus: "contradicted",
        retrievedAt: "2026-06-02T00:00:02.000Z",
      },
    ]);
    expect(getAttributedClaimRows(low - 1)).toEqual([]);
  });
});

describe("updateJudgmentProse", () => {
  // The re-author writes back ONE judgment's prose; neighbours keep theirs.
  it("overwrites only the named judgment's prose", () => {
    const { low, mid, high } = threeJudgments();
    updateJudgmentProse(mid, "revised prose");
    expect(judgmentRow(mid).prose).toBe("revised prose");
    expect(judgmentRow(low).prose).toBe("prose of low");
    expect(judgmentRow(high).prose).toBe("prose of high");
  });
});

describe("updateJudgmentEvidenceRefs", () => {
  // Compare-and-set on ONE judgment: it compares against that judgment's own
  // stored refs, writes only that row, and does nothing for an absent id.
  it("writes the ledger to the named judgment only when its own refs match", () => {
    const { low, mid, high } = threeJudgments();
    const ledger = [ref("mid"), ref("added")];
    expect(updateJudgmentEvidenceRefs(mid, [ref("low")], ledger)).toBe(false);
    expect(judgmentRow(mid).evidence_refs_json).toBe(JSON.stringify([ref("mid")]));
    expect(updateJudgmentEvidenceRefs(mid, [ref("mid")], ledger)).toBe(true);
    expect(judgmentRow(mid).evidence_refs_json).toBe(JSON.stringify(ledger));
    expect(judgmentRow(low).evidence_refs_json).toBe(JSON.stringify([ref("low")]));
    expect(judgmentRow(high).evidence_refs_json).toBe(JSON.stringify([ref("high")]));
    // An absent id is no write, even when the expected refs match a neighbour's.
    expect(updateJudgmentEvidenceRefs(low - 1, [ref("low")], ledger)).toBe(false);
    expect(updateJudgmentEvidenceRefs(high + 1, [ref("high")], ledger)).toBe(false);
  });
});

describe("updateJudgmentVerdict", () => {
  // The post-critic finalize sets ONE judgment's three verdict columns, each
  // from its own field; neighbours stay unscored.
  it("sets confidence, basis and trail on the named judgment only", () => {
    const { low, mid, high } = threeJudgments();
    updateJudgmentVerdict(mid, {
      confidence: "yellow",
      confidenceBasisJson: '{"basis":"two sources"}',
      criticTrailJson: '["round one"]',
    });
    expect(judgmentRow(mid)).toMatchObject({
      confidence: "yellow",
      confidence_basis_json: '{"basis":"two sources"}',
      critic_trail_json: '["round one"]',
    });
    for (const other of [low, high]) {
      expect(judgmentRow(other)).toMatchObject({
        confidence: null,
        confidence_basis_json: null,
        critic_trail_json: null,
      });
    }
  });
});

describe("setConcessionKind", () => {
  // Records ONE judgment's concession; the evidence text is kept only for
  // `updated_with_evidence`, and neighbours stay without a concession.
  it("sets the named judgment's kind, keeping the text only for updated_with_evidence", () => {
    const { low, mid, high } = threeJudgments();
    setConcessionKind(mid, "updated_with_evidence", "operator evidence");
    expect(judgmentRow(mid)).toMatchObject({
      concession_kind: "updated_with_evidence",
      triggering_evidence_text: "operator evidence",
    });
    for (const other of [low, high]) {
      expect(judgmentRow(other)).toMatchObject({
        concession_kind: null,
        triggering_evidence_text: null,
      });
    }
    setConcessionKind(mid, "held_position", "text a held position does not keep");
    expect(judgmentRow(mid)).toMatchObject({
      concession_kind: "held_position",
      triggering_evidence_text: null,
    });
    setConcessionKind(mid, "updated_with_evidence");
    expect(judgmentRow(mid)).toMatchObject({
      concession_kind: "updated_with_evidence",
      triggering_evidence_text: null,
    });
  });
});

describe("appendEvidenceRef", () => {
  // Appends to ONE judgment's ledger (once per kind + excerpt); neighbours'
  // ledgers are untouched, and an absent id is an error, not a write.
  it("appends to the named judgment only, idempotently", () => {
    const { low, mid, high } = threeJudgments();
    const added: EvidenceRef = {
      kind: "operator_message",
      id: "op-1",
      excerpt: "operator says so",
      retrieved_at: "2026-06-02T01:00:00.000Z",
    };
    expect(appendEvidenceRef(mid, added)).toEqual([ref("mid"), added]);
    expect(appendEvidenceRef(mid, { ...added, id: "op-2" })).toEqual([ref("mid"), added]);
    expect(judgmentRow(mid).evidence_refs_json).toBe(JSON.stringify([ref("mid"), added]));
    expect(judgmentRow(low).evidence_refs_json).toBe(JSON.stringify([ref("low")]));
    expect(judgmentRow(high).evidence_refs_json).toBe(JSON.stringify([ref("high")]));
    expect(() => appendEvidenceRef(low - 1, added)).toThrow(/not found/);
  });
});
