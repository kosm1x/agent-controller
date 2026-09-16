/**
 * Agent-memory 5-layer playbook — test battery (plan §3 P0, paper §"8 tests").
 *
 * Each `it` is one of the paper's tests run against the REAL Jarvis store
 * code on an in-memory SQLite (no mocks of the code under test). The paper
 * names eight; three are executable today, five are `it.todo` with the
 * reason each one waits on a later phase. Keep the todo list honest: turn
 * one green only when the phase that makes it meaningful ships.
 *
 *   amnesia       — a retained memory survives a new backend instance      ✔
 *   isolation     — bank A's memory never surfaces from bank B             ✔
 *   staleness     — an expired JME fact is neither recalled nor kept       ✔
 *   contradiction — P2 (user_facts has no status/superseded_by column yet)
 *   promotion     — P4 (skill promotion is proposal-only)
 *   load          — needs the live DB (`mc-ctl memory-checklist` reads it)
 *   cron          — P5 (`runForgetting()` not built; JME prune is inline)
 *   continuity    — P3 (compaction → memory handoff not built)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";

let mockDb: Database.Database;
vi.mock("../db/index.js", () => ({
  getDatabase: () => mockDb,
  writeWithRetry: (fn: () => unknown) => fn(),
}));

// No embeddings in the battery — forces the FTS5 / LIKE paths, which is
// exactly what runs live when the embedder is cold.
vi.mock("./embeddings.js", () => ({
  embed: vi.fn().mockResolvedValue(null),
  cosineSimilarity: vi.fn().mockReturnValue(0),
  serializeEmbedding: vi.fn(),
  deserializeEmbedding: vi.fn(),
}));

vi.mock("./recall-utility.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./recall-utility.js")>();
  return { ...actual, logRecall: vi.fn() };
});

vi.mock("../inference/adapter.js", () => ({ infer: vi.fn() }));
vi.mock("../inference/claude-sdk.js", () => ({ HAIKU_MODEL_ID: "test" }));

import { SqliteMemoryBackend } from "./sqlite-backend.js";
import { queryMemory, pruneExpiredFacts } from "./jme.js";

function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE conversations (
      id         INTEGER PRIMARY KEY,
      bank       TEXT NOT NULL DEFAULT 'mc-jarvis',
      tags       TEXT DEFAULT '[]',
      content    TEXT NOT NULL,
      trust_tier INTEGER NOT NULL DEFAULT 3,
      source     TEXT DEFAULT 'agent',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE VIRTUAL TABLE conversations_fts USING fts5(
      content, content='conversations', content_rowid='id'
    );
    CREATE TRIGGER conversations_ai AFTER INSERT ON conversations BEGIN
      INSERT INTO conversations_fts(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TABLE conversation_embeddings (
      conversation_id INTEGER PRIMARY KEY, embedding BLOB NOT NULL
    );
    CREATE TABLE jme_facts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      source_task TEXT NOT NULL,
      ts          INTEGER NOT NULL,
      fact_text   TEXT NOT NULL,
      category    TEXT NOT NULL,
      embedding   BLOB,
      expires_at  INTEGER,
      confidence  REAL NOT NULL DEFAULT 1.0
    );
    CREATE VIRTUAL TABLE jme_facts_fts USING fts5(
      fact_text, content='jme_facts', content_rowid='id'
    );
    CREATE TRIGGER jme_facts_ai AFTER INSERT ON jme_facts BEGIN
      INSERT INTO jme_facts_fts(rowid, fact_text) VALUES (new.id, new.fact_text);
    END;
    CREATE TRIGGER jme_facts_ad AFTER DELETE ON jme_facts BEGIN
      INSERT INTO jme_facts_fts(jme_facts_fts, rowid, fact_text)
        VALUES('delete', old.id, old.fact_text);
    END;
  `);
}

/**
 * BM25 needs a corpus. On a 1-row bank FTS5's rank is ~-2e-6, the backend
 * normalizer floors `max` at 0.001, and the lone hit lands at 0.002 — under
 * the 0.12 relevance floor. Live banks hold thousands of rows so this never
 * fires there; the filler keeps the battery on the realistic path.
 */
function seedFiller(bank: string): void {
  const ins = mockDb.prepare(
    "INSERT INTO conversations (bank, content) VALUES (?, ?)",
  );
  for (const c of [
    "morning sync summary posted to telegram",
    "ritual calendar review finished without changes",
    "weekly kb cleanup snapshot written",
  ]) ins.run(bank, c);
}

beforeEach(() => {
  mockDb = new Database(":memory:");
  applySchema(mockDb);
  seedFiller("mc-operational");
  seedFiller("mc-jarvis");
});

describe("playbook battery", () => {
  it("amnesia: a retained memory is recalled by a fresh backend instance", async () => {
    const writer = new SqliteMemoryBackend(false);
    await writer.retain("Caddy reload for trustr needs validate first", {
      bank: "mc-operational",
      tags: ["ops"],
    });

    // "Process restart" = a new instance over the same store. Durability
    // lives in SQLite, not in the object.
    const reader = new SqliteMemoryBackend(false);
    const hits = await reader.recall("caddy reload trustr", {
      bank: "mc-operational",
    });
    expect(hits.map((h) => h.content)).toContain(
      "Caddy reload for trustr needs validate first",
    );
  });

  it("isolation: bank A content never surfaces from a bank B recall", async () => {
    const backend = new SqliteMemoryBackend(false);
    await backend.retain("secret pulso credential rotation procedure", {
      bank: "mc-jarvis",
    });
    await backend.retain("unrelated operational note", {
      bank: "mc-operational",
    });

    const fromB = await backend.recall("pulso credential rotation", {
      bank: "mc-operational",
    });
    // The LIKE fallback and the "no matches → recent" tail both stay in-bank.
    for (const hit of fromB) {
      expect(hit.content).not.toContain("pulso credential");
    }
    const fromA = await backend.recall("pulso credential rotation", {
      bank: "mc-jarvis",
    });
    expect(fromA.map((h) => h.content)).toContain(
      "secret pulso credential rotation procedure",
    );
  });

  it("staleness: an expired JME fact is neither recalled nor retained by prune", async () => {
    const now = Date.now();
    const insert = mockDb.prepare(
      `INSERT INTO jme_facts (source_task, ts, fact_text, category, expires_at)
       VALUES (?, ?, ?, 'event', ?)`,
    );
    insert.run("t1", now - 10_000, "deploy window moved to friday", now - 1_000);
    insert.run("t2", now - 5_000, "deploy window stays on monday", now + 86_400_000);

    const hits = await queryMemory("deploy window", { k: 5, minScore: 0 });
    const texts = hits.map((h) => h.factText);
    expect(texts).toContain("deploy window stays on monday");
    expect(texts).not.toContain("deploy window moved to friday");

    expect(pruneExpiredFacts()).toBe(1);
    const left = mockDb.prepare("SELECT fact_text FROM jme_facts").all() as {
      fact_text: string;
    }[];
    expect(left.map((r) => r.fact_text)).toEqual(["deploy window stays on monday"]);
  });

  it.todo(
    "contradiction: storing a fact that conflicts with an existing one flags both (P2 — user_facts has no status/superseded_by)",
  );
  it.todo(
    "promotion: a skill used N times with success is proposed AND its proposal reaches the operator surface (P4 — promotion loop not closed)",
  );
  it.todo(
    "load: recall latency stays flat at 10x the live row count (needs the live DB; see mc-ctl memory-checklist)",
  );
  it.todo(
    "cron: the nightly forgetting pass expires / supersedes / flags in one run (P5 — runForgetting() not built)",
  );
  it.todo(
    "continuity: facts surfaced in a compacted window are recalled in the next one (P3 — compaction → memory handoff not built)",
  );
});
