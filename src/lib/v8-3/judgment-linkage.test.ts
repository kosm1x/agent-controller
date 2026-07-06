import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import { checkJudgmentLinkage } from "./judgment-linkage.js";

const NOW = "2026-07-06T12:00:00.000Z";
const PRIOR = "2026-07-06 06:00:00"; // SQLite datetime, before NOW
const FUTURE = "2026-07-06 18:00:00"; // SQLite datetime, after NOW

function insertJudgment(opts: {
  confidence: string | null;
  verdict?: string;
  deliveredAt?: string | null;
}): number {
  const db = getDatabase();
  // judgments.briefing_id is NOT NULL + FK → every judgment has a briefing.
  db.prepare(
    `INSERT OR IGNORE INTO proposed_briefings
       (briefing_id, surface, generated_at, briefing_json, status, expires_at, delivered_at)
     VALUES ('b-1', 'morning', datetime('now'), '{}', 'promoted', datetime('now','+1 day'), ?)`,
  ).run(opts.deliveredAt ?? null);
  const trail = opts.verdict
    ? JSON.stringify({ verdict: opts.verdict, iterations: 1, critique: "x" })
    : null;
  const info = db
    .prepare(
      `INSERT INTO judgments
         (briefing_id, subject, posture, prose, confidence, created_at, critic_trail_json)
       VALUES ('b-1', 's', 'at_risk', 'p', ?, datetime('now'), ?)`,
    )
    .run(opts.confidence, trail);
  return Number(info.lastInsertRowid);
}

beforeEach(() => initDatabase(":memory:"));
afterEach(() => closeDatabase());

describe("checkJudgmentLinkage — §12 consent gate", () => {
  it("ok: green + CRITIC-approved + prior delivered brief", () => {
    const id = insertJudgment({
      confidence: "green",
      verdict: "approved",
      deliveredAt: PRIOR,
    });
    expect(checkJudgmentLinkage(id, NOW)).toEqual({ ok: true, reason: "ok" });
  });

  it("ok: yellow also qualifies", () => {
    const id = insertJudgment({
      confidence: "yellow",
      verdict: "approved",
      deliveredAt: PRIOR,
    });
    expect(checkJudgmentLinkage(id, NOW).ok).toBe(true);
  });

  it("null/undefined judgmentId → no_linked_judgment", () => {
    expect(checkJudgmentLinkage(null, NOW).reason).toBe("no_linked_judgment");
    expect(checkJudgmentLinkage(undefined, NOW).reason).toBe(
      "no_linked_judgment",
    );
  });

  it("unknown id → judgment_not_found", () => {
    expect(checkJudgmentLinkage(9999, NOW).reason).toBe("judgment_not_found");
  });

  it("red confidence can never autonomous-execute", () => {
    const id = insertJudgment({
      confidence: "red",
      verdict: "approved",
      deliveredAt: PRIOR,
    });
    expect(checkJudgmentLinkage(id, NOW).reason).toBe(
      "judgment_confidence_not_green_yellow",
    );
  });

  it("CRITIC verdict not 'approved' (unfixable) → blocked", () => {
    const id = insertJudgment({
      confidence: "green",
      verdict: "unfixable",
      deliveredAt: PRIOR,
    });
    expect(checkJudgmentLinkage(id, NOW).reason).toBe(
      "judgment_not_critic_approved",
    );
  });

  it("null critic trail (never vetted) → blocked", () => {
    const id = insertJudgment({ confidence: "green", deliveredAt: PRIOR });
    expect(checkJudgmentLinkage(id, NOW).reason).toBe(
      "judgment_not_critic_approved",
    );
  });

  it("briefing never delivered → not_prior_brief", () => {
    const id = insertJudgment({
      confidence: "green",
      verdict: "approved",
      deliveredAt: null,
    });
    expect(checkJudgmentLinkage(id, NOW).reason).toBe(
      "judgment_not_prior_brief",
    );
  });

  it("FUTURE delivery (same/next cycle) → not_prior_brief — datetime() normalizes, no space-vs-T lexical bug", () => {
    // A raw lexical `'2026-07-06 18:00:00' < '2026-07-06T12:00:00.000Z'` is TRUE
    // (space 0x20 < 'T' 0x54) and would WRONGLY pass; `datetime(?)` on the ISO now
    // param normalizes it to delivered_at's space-format shape → correctly false.
    const id = insertJudgment({
      confidence: "green",
      verdict: "approved",
      deliveredAt: FUTURE,
    });
    expect(checkJudgmentLinkage(id, NOW).reason).toBe(
      "judgment_not_prior_brief",
    );
  });
});
