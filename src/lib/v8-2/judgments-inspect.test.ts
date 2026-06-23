/**
 * V8.2 inspector readers (`mc-ctl judgments`) — tested against a real in-memory
 * DB seeded with proposed_briefings + judgments + attributed_claims.
 *
 *  - getRecentJudgments: newest-first ordering, limit cap (+ hard max 200),
 *    optional N-day window.
 *  - getJudgmentClaimSummary: resolver-status rollup; all-zero for no claims.
 *  - getAttributedClaimRows: claim-then-row ordering + field mapping; empty set.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import {
  getRecentJudgments,
  getJudgmentClaimSummary,
  getAttributedClaimRows,
} from "./judgments-store.js";

const FUTURE = "2030-01-01T00:00:00.000Z";

beforeEach(() => initDatabase(":memory:"));
afterEach(() => closeDatabase());

/** Seed one briefing parent (shared FK target). */
function seedBriefing(id = "b1"): void {
  getDatabase()
    .prepare(
      `INSERT INTO proposed_briefings (briefing_id, surface, generated_at, briefing_json, expires_at)
       VALUES (?,?,?,?,?)`,
    )
    .run(id, "morning", "2026-06-02T00:00:00.000Z", "{}", FUTURE);
}

/** Insert a judgment with an explicit created_at; return its PK. */
function seedJudgment(
  subject: string,
  createdAt: string,
  opts: { confidence?: string; briefingId?: string } = {},
): number {
  const info = getDatabase()
    .prepare(
      `INSERT INTO judgments (briefing_id, subject, posture, prose, confidence, created_at)
       VALUES (?,?,?,?,?,?)`,
    )
    .run(
      opts.briefingId ?? "b1",
      subject,
      "at_risk",
      "prose",
      opts.confidence ?? null,
      createdAt,
    );
  return Number(info.lastInsertRowid);
}

function seedClaim(
  judgmentId: number,
  claimId: number,
  status: string,
  evidence: { kind: string; id: string; excerpt: string },
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
      `claim ${claimId}`,
      evidence.kind,
      evidence.id,
      evidence.excerpt,
      "2026-06-02T00:00:00.000Z",
      status,
    );
}

describe("getRecentJudgments", () => {
  it("returns judgments newest-first across all briefings", () => {
    seedBriefing();
    seedJudgment("oldest", "2026-06-01T00:00:00.000Z");
    seedJudgment("newest", "2026-06-03T00:00:00.000Z");
    seedJudgment("middle", "2026-06-02T00:00:00.000Z");
    const rows = getRecentJudgments();
    expect(rows.map((r) => r.subject)).toEqual(["newest", "middle", "oldest"]);
  });

  it("honors the limit (and defaults to 20)", () => {
    seedBriefing();
    for (let i = 0; i < 25; i++) {
      seedJudgment(
        `j${i}`,
        `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
      );
    }
    expect(getRecentJudgments().length).toBe(20); // default
    expect(getRecentJudgments({ limit: 5 }).length).toBe(5);
  });

  it("hard-caps the limit at 200 and floors it at 1", () => {
    seedBriefing();
    seedJudgment("only", "2026-06-02T00:00:00.000Z");
    // a huge or zero/negative limit must not throw or scan unbounded
    expect(getRecentJudgments({ limit: 10_000 }).length).toBe(1);
    expect(getRecentJudgments({ limit: 0 }).length).toBe(1);
    expect(getRecentJudgments({ limit: -5 }).length).toBe(1);
  });

  it("filters to the last N days when windowDays > 0", () => {
    seedBriefing();
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    seedJudgment("recent", now);
    seedJudgment("ancient", old);
    const win = getRecentJudgments({ windowDays: 7 });
    expect(win.map((r) => r.subject)).toEqual(["recent"]);
    // windowDays 0/absent = no filter
    expect(getRecentJudgments().length).toBe(2);
  });
});

describe("getJudgmentClaimSummary", () => {
  it("rolls up resolver_status into the five buckets", () => {
    seedBriefing();
    const jid = seedJudgment("j", "2026-06-02T00:00:00.000Z");
    seedClaim(jid, 0, "resolved", { kind: "task", id: "t-1", excerpt: "a" });
    seedClaim(jid, 1, "resolved", { kind: "metric", id: "m-1", excerpt: "b" });
    seedClaim(jid, 2, "stale", { kind: "kb_entry", id: "k-1", excerpt: "c" });
    seedClaim(jid, 3, "contradicted", {
      kind: "task",
      id: "t-2",
      excerpt: "d",
    });
    seedClaim(jid, 4, "unresolved", { kind: "task", id: "t-3", excerpt: "e" });
    const s = getJudgmentClaimSummary(jid);
    expect(s).toEqual({
      total: 5,
      resolved: 2,
      stale: 1,
      contradicted: 1,
      unresolved: 1,
    });
  });

  it("returns all-zero for a judgment with no claims", () => {
    seedBriefing();
    const jid = seedJudgment("j", "2026-06-02T00:00:00.000Z");
    expect(getJudgmentClaimSummary(jid)).toEqual({
      total: 0,
      resolved: 0,
      stale: 0,
      contradicted: 0,
      unresolved: 0,
    });
  });
});

describe("getAttributedClaimRows", () => {
  it("orders by claim_id then row, and maps the columns", () => {
    seedBriefing();
    const jid = seedJudgment("j", "2026-06-02T00:00:00.000Z");
    // claim 1 has two evidence rows; claim 0 one — assert claim_id ordering
    seedClaim(jid, 1, "resolved", {
      kind: "metric",
      id: "m-1",
      excerpt: "second",
    });
    seedClaim(jid, 0, "resolved", {
      kind: "task",
      id: "t-1",
      excerpt: "first",
    });
    seedClaim(jid, 1, "stale", { kind: "task", id: "t-9", excerpt: "third" });
    const rows = getAttributedClaimRows(jid);
    expect(rows.map((r) => r.claimId)).toEqual([0, 1, 1]);
    expect(rows[0]).toMatchObject({
      claimId: 0,
      evidenceKind: "task",
      evidenceId: "t-1",
      evidenceExcerpt: "first",
      resolverStatus: "resolved",
    });
  });

  it("returns an empty list for a judgment with no claims", () => {
    seedBriefing();
    const jid = seedJudgment("j", "2026-06-02T00:00:00.000Z");
    expect(getAttributedClaimRows(jid)).toEqual([]);
  });
});
