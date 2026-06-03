/**
 * V8.2 Phase 4 — citation resolver tests (spec §9).
 *
 * Three surfaces:
 *  - `resolveCitations` (pure): 10 prose samples covering single/multi-source,
 *    dedup, out-of-range + `[0]`, the four markerless-factual categories, pure
 *    editorial, claim_id increment, prose_offset, hit-rate.
 *  - `persistAttributedClaims` (real in-memory DB): seeds the
 *    proposed_briefings + judgments parent for the FK, asserts one row per
 *    evidence ref with the shared claim_id + resolver_status='resolved'.
 *  - heuristic sub-predicates: pin the §9 number/date/name/state-claim flags.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import {
  assertsNonTrivialFact,
  hasDate,
  hasNumber,
  hasProperName,
  hasStateClaim,
  persistAttributedClaims,
  markClaimsContradicted,
  countContradictions,
  resolveCitations,
  splitSentences,
  toAttributedClaimRows,
} from "./cite.js";
import type { EvidenceRef } from "./types.js";

const T0 = "2026-06-02T12:00:00.000Z";
const FUTURE = "2030-01-01T00:00:00.000Z";

const LEDGER: EvidenceRef[] = [
  { kind: "task", id: "t-1", excerpt: "ship the pilot", retrieved_at: T0 },
  { kind: "metric", id: "m-1", excerpt: "conversion 12%", retrieved_at: T0 },
  { kind: "northstar", id: "ns-1", excerpt: "grow MX", retrieved_at: T0 },
];

describe("resolveCitations — 10 prose samples (spec §9)", () => {
  it("1. single valid marker → one resolved claim from ledger[K-1]", () => {
    const r = resolveCitations("The pilot is blocked [1].", LEDGER);
    expect(r.resolved).toHaveLength(1);
    expect(r.unresolved).toHaveLength(0);
    const c = r.resolved[0];
    expect(c.claim_id).toBe(0);
    expect(c.prose_offset).toBe(0);
    expect(c.resolver_status).toBe("resolved");
    expect(c.evidence_refs).toEqual([LEDGER[0]]);
  });

  it("2. multi-source [1][2] → one claim with two refs under one claim_id", () => {
    const r = resolveCitations(
      "Conversion up but the pilot stalls [1][2].",
      LEDGER,
    );
    expect(r.resolved).toHaveLength(1);
    expect(r.resolved[0].evidence_refs).toEqual([LEDGER[0], LEDGER[1]]);
    expect(r.resolved[0].claim_id).toBe(0);
  });

  it("3. duplicate [1][1] dedupes to a single evidence ref", () => {
    const r = resolveCitations("The pilot stalls [1][1].", LEDGER);
    expect(r.resolved).toHaveLength(1);
    expect(r.resolved[0].evidence_refs).toEqual([LEDGER[0]]);
  });

  it("4. out-of-range [9] on a factual sentence → unresolved 'invalid_marker_only'", () => {
    const r = resolveCitations("Revenue dropped 20% [9].", LEDGER);
    expect(r.resolved).toHaveLength(0);
    expect(r.unresolved).toHaveLength(1);
    expect(r.unresolved[0].reason).toBe("invalid_marker_only");
    expect(r.unresolved[0].invalid_markers).toEqual([9]);
    expect(r.stats.invalid_markers).toBe(1);
  });

  it("5. [0] is invalid (1-indexed) → factual sentence becomes invalid_marker_only", () => {
    const r = resolveCitations("The metric fell [0].", LEDGER);
    expect(r.resolved).toHaveLength(0);
    expect(r.unresolved[0].reason).toBe("invalid_marker_only");
    expect(r.unresolved[0].invalid_markers).toEqual([0]);
  });

  it("6. valid + out-of-range [1][9] resolves via the valid one and counts the invalid", () => {
    const r = resolveCitations("The pilot stalls [1][9].", LEDGER);
    expect(r.resolved).toHaveLength(1);
    expect(r.resolved[0].evidence_refs).toEqual([LEDGER[0]]);
    expect(r.stats.invalid_markers).toBe(1);
  });

  it("7. markerless number → unresolved 'no_marker_factual'", () => {
    const r = resolveCitations("We have 5 stalled tasks.", LEDGER);
    expect(r.unresolved).toHaveLength(1);
    expect(r.unresolved[0].reason).toBe("no_marker_factual");
    expect(r.unresolved[0].invalid_markers).toEqual([]);
  });

  it("8. markerless date and proper-name are flagged", () => {
    expect(
      resolveCitations("The deadline is Friday.", LEDGER).unresolved,
    ).toHaveLength(1);
    expect(
      resolveCitations("We met with Telmex about it.", LEDGER).unresolved,
    ).toHaveLength(1);
  });

  it("9. markerless state-claim → unresolved", () => {
    const r = resolveCitations("The pilot is at risk.", LEDGER);
    expect(r.unresolved).toHaveLength(1);
    expect(r.unresolved[0].reason).toBe("no_marker_factual");
  });

  it("10. pure editorial sentence is ignored (not a claim)", () => {
    const r = resolveCitations("Here are the options to consider.", LEDGER);
    expect(r.resolved).toHaveLength(0);
    expect(r.unresolved).toHaveLength(0);
    expect(r.stats.resolver_hit_rate).toBe(1); // no claims at all
  });
});

describe("resolveCitations — claim_id, offsets, stats", () => {
  it("increments claim_id across resolved sentences and tracks prose_offset", () => {
    const prose = "The pilot is blocked [1]. Conversion is up [2].";
    const r = resolveCitations(prose, LEDGER);
    expect(r.resolved.map((c) => c.claim_id)).toEqual([0, 1]);
    expect(r.resolved[0].prose_offset).toBe(0);
    expect(r.resolved[1].prose_offset).toBe(prose.indexOf("Conversion"));
  });

  it("honors startClaimId and keeps incrementing across sentences (qa-R2)", () => {
    const r = resolveCitations("Blocked [1]. Up [2]. Drifting [3].", LEDGER, {
      startClaimId: 5,
    });
    expect(r.resolved.map((c) => c.claim_id)).toEqual([5, 6, 7]);
  });

  it("excludes pure-editorial sentences from the hit-rate denominator (qa-W2)", () => {
    // one resolved + one editorial (NOT factual) → hit_rate 1.0, not 0.5
    const r = resolveCitations(
      "The pilot is blocked [1]. Here are the options.",
      LEDGER,
    );
    expect(r.stats.resolved_claims).toBe(1);
    expect(r.stats.unresolved_claims).toBe(0);
    expect(r.stats.resolver_hit_rate).toBe(1);
  });

  it("computes resolver_hit_rate = resolved / (resolved + unresolved)", () => {
    // one resolved, one markerless-factual → 0.5
    const r = resolveCitations(
      "The pilot is blocked [1]. Revenue dropped 20%.",
      LEDGER,
    );
    expect(r.stats.resolved_claims).toBe(1);
    expect(r.stats.unresolved_claims).toBe(1);
    expect(r.stats.resolver_hit_rate).toBe(0.5);
  });

  it("an empty ledger makes every marker invalid", () => {
    const r = resolveCitations("The pilot is blocked [1].", []);
    expect(r.resolved).toHaveLength(0);
    expect(r.stats.invalid_markers).toBe(1);
  });
});

describe("splitSentences", () => {
  it("does not split on a decimal (no trailing space after the dot)", () => {
    const s = splitSentences("Conversion rose to 3.5 percent today.");
    expect(s).toHaveLength(1);
  });

  it("splits on .!? followed by whitespace and tracks offsets", () => {
    const prose = "First claim. Second claim! Third?";
    const s = splitSentences(prose);
    expect(s.map((x) => x.text)).toEqual([
      "First claim.",
      "Second claim!",
      "Third?",
    ]);
    expect(s[1].offset).toBe(prose.indexOf("Second"));
  });
});

describe("non-trivial-fact sub-predicates (§9 categories)", () => {
  it("hasNumber / hasDate / hasProperName / hasStateClaim", () => {
    expect(hasNumber("up 12%")).toBe(true);
    expect(hasNumber("no figures here")).toBe(false);
    expect(hasDate("due Friday")).toBe(true);
    expect(hasDate("due soon")).toBe(false);
    // first token is exempt (sentence-start capitalization); interior name fires
    expect(hasProperName("The client Acme is late")).toBe(true);
    expect(hasProperName("Here are the options")).toBe(false);
    expect(hasStateClaim("the task is overdue")).toBe(true);
    expect(hasStateClaim("the pilot dropped sharply")).toBe(true);
    expect(hasStateClaim("here are the options")).toBe(false);
  });

  it("broadened business-state verbs catch proper-name-subject claims (qa-W1)", () => {
    // These previously slipped through as "editorial" — the dangerous FN class.
    for (const s of [
      "Acme signed the contract.",
      "The renewal was cancelled.",
      "We lost the deal.",
      "The account is churning.",
      "Revenue is below target.",
      "Their budget shrank.",
    ]) {
      expect(assertsNonTrivialFact(s)).toBe(true);
    }
  });

  it("assertsNonTrivialFact strips markers before testing", () => {
    expect(assertsNonTrivialFact("The pilot stalled [1].")).toBe(true);
    expect(assertsNonTrivialFact("Let us weigh the choices.")).toBe(false);
  });
});

describe("toAttributedClaimRows", () => {
  it("emits one row per evidence ref, all sharing claim_id + status", () => {
    const { resolved } = resolveCitations(
      "Conversion up but the pilot stalls [1][2].",
      LEDGER,
    );
    const rows = toAttributedClaimRows(42, resolved);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.judgment_id === 42)).toBe(true);
    expect(rows.every((r) => r.claim_id === 0)).toBe(true);
    expect(rows.every((r) => r.resolver_status === "resolved")).toBe(true);
    expect(rows.map((r) => r.evidence_id).sort()).toEqual(["m-1", "t-1"]);
    expect(rows.find((r) => r.evidence_id === "t-1")?.evidence_kind).toBe(
      "task",
    );
  });
});

describe("persistAttributedClaims — real in-memory DB", () => {
  beforeEach(() => {
    initDatabase(":memory:");
  });
  afterEach(() => {
    closeDatabase();
  });

  /** Seed proposed_briefings + judgments parent; return the judgment PK. */
  function seedJudgment(): number {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO proposed_briefings (briefing_id, surface, generated_at, briefing_json, expires_at)
       VALUES (?,?,?,?,?)`,
    ).run("b1", "morning", T0, "{}", FUTURE);
    const info = db
      .prepare(
        `INSERT INTO judgments (briefing_id, subject, posture, prose, created_at)
         VALUES (?,?,?,?,?)`,
      )
      .run("b1", "CRM pilot", "at_risk", "prose", T0);
    return Number(info.lastInsertRowid);
  }

  it("writes one row per evidence ref and returns the count", () => {
    const jid = seedJudgment();
    const { resolved } = resolveCitations(
      "The pilot is blocked [1]. Conversion up but stalling [1][2].",
      LEDGER,
    );
    const written = persistAttributedClaims(jid, resolved, getDatabase());
    expect(written).toBe(3); // claim 0: [1] → 1 row; claim 1: [1][2] → 2 rows

    const rows = getDatabase()
      .prepare(
        "SELECT claim_id, evidence_id, evidence_kind, resolver_status FROM attributed_claims WHERE judgment_id = ? ORDER BY claim_id, evidence_id",
      )
      .all(jid) as {
      claim_id: number;
      evidence_id: string;
      evidence_kind: string;
      resolver_status: string;
    }[];
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.resolver_status === "resolved")).toBe(true);
    // claim 1 groups two evidence rows
    expect(
      rows.filter((r) => r.claim_id === 1).map((r) => r.evidence_id),
    ).toEqual(["m-1", "t-1"]);
  });

  it("is a no-op (returns 0) for an empty resolved set", () => {
    const jid = seedJudgment();
    expect(persistAttributedClaims(jid, [], getDatabase())).toBe(0);
    const count = getDatabase()
      .prepare("SELECT COUNT(*) AS c FROM attributed_claims")
      .get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("rejects a non-existent judgment_id via the FK (qa-R2)", () => {
    const { resolved } = resolveCitations("The pilot is blocked [1].", LEDGER);
    // foreign_keys = ON → the orphan parent is rejected, transaction rolls back
    expect(() =>
      persistAttributedClaims(99999, resolved, getDatabase()),
    ).toThrow(/FOREIGN KEY/i);
    const count = getDatabase()
      .prepare("SELECT COUNT(*) AS c FROM attributed_claims")
      .get() as { c: number };
    expect(count.c).toBe(0); // rolled back — no partial write
  });

  it("markClaimsContradicted flips ALL rows of a claim; countContradictions counts DISTINCT claims", () => {
    const jid = seedJudgment();
    // claim 0: [1] → 1 row; claim 1: [1][2] → 2 rows
    const { resolved } = resolveCitations(
      "The pilot is blocked [1]. Conversion up but stalling [1][2].",
      LEDGER,
    );
    persistAttributedClaims(jid, resolved, getDatabase());

    // contradict the multi-source claim 1 — both its evidence rows flip
    expect(markClaimsContradicted(jid, [1], getDatabase())).toBe(2);

    const rows = getDatabase()
      .prepare(
        "SELECT claim_id, resolver_status FROM attributed_claims WHERE judgment_id=? ORDER BY claim_id, evidence_id",
      )
      .all(jid) as { claim_id: number; resolver_status: string }[];
    expect(
      rows
        .filter((r) => r.claim_id === 1)
        .every((r) => r.resolver_status === "contradicted"),
    ).toBe(true);
    // claim 0 untouched
    expect(
      rows
        .filter((r) => r.claim_id === 0)
        .every((r) => r.resolver_status === "resolved"),
    ).toBe(true);
    // distinct-claim count = 1 (the claim), not 2 (the rows)
    expect(countContradictions(jid, getDatabase())).toBe(1);
  });

  it("markClaimsContradicted is a no-op for [] and dedupes ids", () => {
    const jid = seedJudgment();
    const { resolved } = resolveCitations("The pilot is blocked [1].", LEDGER);
    persistAttributedClaims(jid, resolved, getDatabase());
    expect(markClaimsContradicted(jid, [], getDatabase())).toBe(0);
    // claim 0 has one row; duplicate ids collapse to a single flip
    expect(markClaimsContradicted(jid, [0, 0, 0], getDatabase())).toBe(1);
    expect(countContradictions(jid, getDatabase())).toBe(1);
  });

  it("scopes the flip to the given judgment; countContradictions is 0 when none", () => {
    const jid = seedJudgment();
    const { resolved } = resolveCitations("The pilot is blocked [1].", LEDGER);
    persistAttributedClaims(jid, resolved, getDatabase());
    expect(countContradictions(jid, getDatabase())).toBe(0);
    // a different judgment id flips nothing here
    expect(markClaimsContradicted(jid + 999, [0], getDatabase())).toBe(0);
    expect(countContradictions(jid, getDatabase())).toBe(0);
  });
});
