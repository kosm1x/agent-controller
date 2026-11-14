/**
 * Memory consolidation on the real schema.
 *
 * consolidation.test.ts stubs `prepare`, so none of the module's DELETE or
 * SELECT statements ever meet the real `conversations` table, its FTS delete
 * trigger or the `conversation_embeddings` ON DELETE CASCADE. These cases run
 * every statement on `initDatabase(":memory:")` and assert the rows left.
 *
 * The module's windows are SQLite `datetime('now', …)`, so seeds are written
 * relative to SQLite's own clock, far from every boundary (days, not seconds).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { runConsolidation } from "./consolidation.js";

// Rows that share these first 100 characters (and a bank) are one duplicate group.
const PREFIX = "shared memory prefix ".padEnd(100, "x");

function seed(
  bank: string,
  content: string,
  tier: number,
  ageDays: number,
): number {
  return Number(
    getDatabase()
      .prepare(
        `INSERT INTO conversations (bank, content, trust_tier, created_at)
         VALUES (?, ?, ?, datetime('now', '-' || ? || ' days'))`,
      )
      .run(bank, content, tier, ageDays).lastInsertRowid,
  );
}

function embed(id: number): void {
  getDatabase()
    .prepare(
      "INSERT INTO conversation_embeddings (conversation_id, embedding) VALUES (?, ?)",
    )
    .run(id, Buffer.alloc(8));
}

function ids(): number[] {
  return (
    getDatabase()
      .prepare("SELECT id FROM conversations ORDER BY id")
      .all() as Array<{ id: number }>
  ).map((r) => r.id);
}

function ftsHits(token: string): number {
  return (
    getDatabase()
      .prepare(
        "SELECT COUNT(*) AS cnt FROM conversations_fts WHERE conversations_fts MATCH ?",
      )
      .get(`"${token}"`) as { cnt: number }
  ).cnt;
}

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

describe("runConsolidation on the real schema", () => {
  it("keeps the newest copy of a duplicate group, prunes aged tier 3/4 rows, and drops their embeddings and FTS entries", async () => {
    // Duplicate group in an ordinary bank: same tier, the newer copy survives.
    const dupOld = seed("mc-jarvis", `${PREFIX} tokendupold`, 3, 5);
    const dupNew = seed("mc-jarvis", `${PREFIX} tokendupnew`, 3, 3);
    // Shares the first 50 characters only: a different group, never a duplicate.
    const near = seed("mc-jarvis", `${PREFIX.slice(0, 50)}different tail`, 3, 10);
    // The same 100-character prefix in another bank is its own group.
    const otherBank = seed("mc-other", `${PREFIX} tokenotherbank`, 3, 4);
    // The protected bank is never deduplicated.
    const sysA = seed("mc-system", `${PREFIX} tokensysa`, 3, 5);
    const sysB = seed("mc-system", `${PREFIX} tokensysb`, 3, 3);
    // Age prune: tier 4 after 60 days, tier 3 after 180; tiers 1-2 never.
    const t4Old = seed("mc-jarvis", "unverified tokentfourold", 4, 61);
    const t4New = seed("mc-jarvis", "unverified recent", 4, 30);
    const t3Old = seed("mc-jarvis", "provisional tokentthreeold", 3, 181);
    const t3New = seed("mc-jarvis", "provisional recent", 3, 90);
    const t1Old = seed("mc-jarvis", "verified ancient", 1, 400);
    const t2Old = seed("mc-jarvis", "inferred ancient", 2, 400);
    embed(dupOld);
    embed(dupNew);
    embed(t4Old);

    const report = await runConsolidation();

    expect(report.orient).toEqual({
      "mc-jarvis": 9,
      "mc-other": 1,
      "mc-system": 2,
    });
    expect(report.duplicatesRemoved).toBe(1);
    expect(report.staleCandidates).toBe(2);
    expect(report.pruned).toBe(2);
    expect(report.remaining).toBe(9);
    expect(ids()).toEqual(
      [
        dupNew,
        near,
        otherBank,
        sysA,
        sysB,
        t4New,
        t3New,
        t1Old,
        t2Old,
      ].sort((a, b) => a - b),
    );

    // The embedding follows its deleted parent row (ON DELETE CASCADE).
    const embedded = (
      getDatabase()
        .prepare(
          "SELECT conversation_id FROM conversation_embeddings ORDER BY conversation_id",
        )
        .all() as Array<{ conversation_id: number }>
    ).map((r) => r.conversation_id);
    expect(embedded).toEqual([dupNew]);

    // The FTS delete trigger removed the deleted rows from full-text search.
    expect(ftsHits("tokendupold")).toBe(0);
    expect(ftsHits("tokentfourold")).toBe(0);
    expect(ftsHits("tokentthreeold")).toBe(0);
    expect(ftsHits("tokendupnew")).toBe(1);
  });

  it("never prunes an aged row in the protected bank", async () => {
    const sysOld = seed("mc-system", "directive tokensysold", 4, 61);
    seed("mc-jarvis", "unverified tokenplainold", 4, 61);

    const report = await runConsolidation();

    expect(report.pruned).toBe(1);
    expect(report.remaining).toBe(1);
    expect(ids()).toEqual([sysOld]);
    expect(ftsHits("tokenplainold")).toBe(0);
  });

  it("is a no-op on a table with nothing to remove", async () => {
    const a = seed("mc-jarvis", "first unique memory", 3, 1);
    const b = seed("mc-jarvis", "second unique memory", 4, 1);

    const report = await runConsolidation();

    expect(report).toMatchObject({
      orient: { "mc-jarvis": 2 },
      staleCandidates: 0,
      duplicatesRemoved: 0,
      pruned: 0,
      remaining: 2,
    });
    expect(ids()).toEqual([a, b]);
  });

  // trust_tier 1 is the most trusted tier (schema.sql): a duplicate group keeps
  // its most trusted copy, and recency only breaks a tie between equal tiers.
  it("keeps the most trusted copy (lowest trust_tier) of a duplicate group even when it is the older one", async () => {
    const trusted = seed("mc-jarvis", `${PREFIX} tokentrusted`, 1, 5);
    seed("mc-jarvis", `${PREFIX} tokenuntrusted`, 4, 3);

    const report = await runConsolidation();

    expect(report.duplicatesRemoved).toBe(1);
    expect(ids()).toEqual([trusted]);
    expect(ftsHits("tokenuntrusted")).toBe(0);
  });

  it("orders every tier, not only the extremes: of tier 3 (newest), 2 and 1 (oldest) copies only the tier-1 copy is left", async () => {
    seed("mc-jarvis", `${PREFIX} tokentierthree`, 3, 2);
    seed("mc-jarvis", `${PREFIX} tokentiertwo`, 2, 4);
    const tierOne = seed("mc-jarvis", `${PREFIX} tokentierone`, 1, 6);

    const report = await runConsolidation();

    expect(report.duplicatesRemoved).toBe(2);
    expect(ids()).toEqual([tierOne]);
  });

  it("removes repeated copies in any tier: two most-trusted copies keep only the newest", async () => {
    seed("mc-jarvis", `${PREFIX} tokenverifiedold`, 1, 5);
    const newest = seed("mc-jarvis", `${PREFIX} tokenverifiednew`, 1, 3);

    const report = await runConsolidation();

    expect(report.duplicatesRemoved).toBe(1);
    expect(ids()).toEqual([newest]);
  });

  // The figure reports what the prune can act on, so the protected bank is
  // excluded from it exactly as it is from the prune.
  it("counts as stale candidates only rows outside the protected bank", async () => {
    const sysT4 = seed("mc-system", "directive tokensystfour", 4, 61);
    const sysT3 = seed("mc-system", "directive tokensysthree", 3, 181);
    seed("mc-jarvis", "unverified tokenplainstale", 4, 61);

    const report = await runConsolidation();

    expect(report.staleCandidates).toBe(1);
    expect(report.pruned).toBe(1);
    expect(ids()).toEqual([sysT4, sysT3]);
  });
});
