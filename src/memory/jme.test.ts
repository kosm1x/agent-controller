/**
 * JME Phase 0 tests — schema + API surface
 *
 * Invariants:
 *   1. writeEpisodic() persists turns, getTurnsForTask() retrieves them in order
 *   2. writeFact() persists facts; queryMemory() returns them via FTS5 fallback
 *   3. Expired facts are excluded from queryMemory()
 *   4. pruneExpiredFacts() removes expired + low-confidence stale rows
 *   5. jmeStats() returns correct counts
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";

// Phase 2 mocks (hoisted before dynamic import)
const inferMock = vi.fn();
vi.mock("../inference/adapter.js", () => ({
  infer: (...args: unknown[]) => inferMock(...args),
}));
vi.mock("../inference/claude-sdk.js", () => ({
  HAIKU_MODEL_ID: "claude-haiku-test",
}));

// ── Mock DB & dependencies ───────────────────────────────────────────────────

// We create an in-memory DB and run the JME schema manually
// instead of calling initDatabase() (which has side-effects)

let mockDb: Database.Database;

vi.mock("../db/index.js", () => ({
  getDatabase: () => mockDb,
  writeWithRetry: (fn: () => void) => fn(),
}));

// Mock embed — returns null (forces FTS5-only path) unless test overrides
vi.mock("./embeddings.js", () => ({
  embed: vi.fn().mockResolvedValue(null),
  cosineSimilarity: vi.fn().mockReturnValue(0),
  serializeEmbedding: vi.fn((v: Float32Array) =>
    Buffer.from(v.buffer, v.byteOffset, v.byteLength),
  ),
  deserializeEmbedding: vi.fn(
    (b: Buffer) => new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4),
  ),
}));

vi.mock("../lib/err-msg.js", () => ({
  errMsg: (e: unknown) => String(e),
}));

// Mock recall telemetry so we can assert logRecall fires on every recall path
const logRecallMock = vi.fn();
vi.mock("./recall-utility.js", () => ({
  logRecall: (...args: unknown[]) => logRecallMock(...args),
}));

function applyJmeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jme_turns (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    TEXT NOT NULL,
      ts         INTEGER NOT NULL,
      role       TEXT NOT NULL CHECK(role IN ('user', 'jarvis')),
      content    TEXT NOT NULL,
      channel    TEXT DEFAULT 'unknown'
    );
    CREATE INDEX IF NOT EXISTS idx_jme_turns_task ON jme_turns(task_id);
    CREATE INDEX IF NOT EXISTS idx_jme_turns_ts   ON jme_turns(ts DESC);

    CREATE TABLE IF NOT EXISTS jme_facts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      source_task TEXT NOT NULL,
      ts          INTEGER NOT NULL,
      fact_text   TEXT NOT NULL,
      category    TEXT NOT NULL
                    CHECK(category IN ('decision','preference','event','emotion','project')),
      embedding   BLOB,
      expires_at  INTEGER,
      confidence  REAL NOT NULL DEFAULT 1.0
    );
    CREATE INDEX IF NOT EXISTS idx_jme_facts_task     ON jme_facts(source_task);
    CREATE INDEX IF NOT EXISTS idx_jme_facts_ts       ON jme_facts(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_jme_facts_category ON jme_facts(category);
    CREATE INDEX IF NOT EXISTS idx_jme_facts_expires  ON jme_facts(expires_at);

    CREATE VIRTUAL TABLE IF NOT EXISTS jme_facts_fts USING fts5(
      fact_text,
      content='jme_facts',
      content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS jme_facts_ai AFTER INSERT ON jme_facts BEGIN
      INSERT INTO jme_facts_fts(rowid, fact_text) VALUES (new.id, new.fact_text);
    END;
    CREATE TRIGGER IF NOT EXISTS jme_facts_ad AFTER DELETE ON jme_facts BEGIN
      INSERT INTO jme_facts_fts(jme_facts_fts, rowid, fact_text)
        VALUES('delete', old.id, old.fact_text);
    END;
    CREATE TRIGGER IF NOT EXISTS jme_facts_au AFTER UPDATE ON jme_facts BEGIN
      INSERT INTO jme_facts_fts(jme_facts_fts, rowid, fact_text)
        VALUES('delete', old.id, old.fact_text);
      INSERT INTO jme_facts_fts(rowid, fact_text) VALUES (new.id, new.fact_text);
    END;
  `);
}

beforeEach(() => {
  mockDb = new Database(":memory:");
  applyJmeSchema(mockDb);
  logRecallMock.mockClear();
});

// Dynamic import so mocks are in place first
async function getJme() {
  return await import("./jme.js");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("JME — episodic store", () => {
  it("writeEpisodic persists a turn", async () => {
    const { writeEpisodic, getTurnsForTask } = await getJme();
    writeEpisodic({ taskId: "t1", role: "user", content: "Hola Jarvis" });
    writeEpisodic({ taskId: "t1", role: "jarvis", content: "Hola Fede" });

    const turns = getTurnsForTask("t1");
    expect(turns).toHaveLength(2);
    expect(turns[0].role).toBe("user");
    expect(turns[0].content).toBe("Hola Jarvis");
    expect(turns[1].role).toBe("jarvis");
  });

  it("getTurnsForTask returns only turns for the given task", async () => {
    const { writeEpisodic, getTurnsForTask } = await getJme();
    writeEpisodic({ taskId: "t1", role: "user", content: "task 1 msg" });
    writeEpisodic({ taskId: "t2", role: "user", content: "task 2 msg" });

    expect(getTurnsForTask("t1")).toHaveLength(1);
    expect(getTurnsForTask("t2")).toHaveLength(1);
  });

  it("channel defaults to 'unknown' when not provided", async () => {
    const { writeEpisodic } = await getJme();
    writeEpisodic({ taskId: "t1", role: "user", content: "test" });

    const row = mockDb
      .prepare("SELECT channel FROM jme_turns WHERE task_id = 't1'")
      .get() as { channel: string };
    expect(row.channel).toBe("unknown");
  });

  it("channel is stored when provided", async () => {
    const { writeEpisodic } = await getJme();
    writeEpisodic({
      taskId: "t1",
      role: "user",
      content: "via whatsapp",
      channel: "whatsapp",
    });
    const row = mockDb
      .prepare("SELECT channel FROM jme_turns WHERE task_id = 't1'")
      .get() as { channel: string };
    expect(row.channel).toBe("whatsapp");
  });
});

describe("JME — semantic store (FTS5 path)", () => {
  it("writeFact persists a fact and queryMemory finds it via FTS5", async () => {
    const { writeFact, queryMemory } = await getJme();
    await writeFact({
      sourceTask: "t1",
      factText: "Fede decided not to use Mem0",
      category: "decision",
    });

    const results = await queryMemory("Mem0 decision");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].factText).toContain("Mem0");
  });

  it("writeFacts stores multiple facts", async () => {
    const { writeFacts, jmeStats } = await getJme();
    await writeFacts([
      {
        sourceTask: "t1",
        factText: "Fede prefers concise responses",
        category: "preference",
      },
      {
        sourceTask: "t1",
        factText: "Fede is building TMN project",
        category: "project",
      },
    ]);
    const stats = jmeStats();
    expect(stats.factsTotal).toBe(2);
  });

  it("expired facts are excluded from queryMemory", async () => {
    const { writeFact, queryMemory } = await getJme();
    const pastExpiry = Date.now() - 1000; // already expired
    await writeFact({
      sourceTask: "t1",
      factText: "Fede was in Valle de Bravo",
      category: "event",
      expiresAt: pastExpiry,
    });

    const results = await queryMemory("Valle de Bravo");
    expect(results).toHaveLength(0);
  });

  it("queryMemory calls logRecall once with source:'jme' even when result set is empty", async () => {
    const { queryMemory } = await getJme();

    // No facts written → FTS5 matches nothing → empty result set
    const results = await queryMemory("nonexistent query term xyz");
    expect(results).toHaveLength(0);

    // Telemetry must still fire exactly once on the empty-result path
    expect(logRecallMock).toHaveBeenCalledTimes(1);
    expect(logRecallMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: "jme", results: [] }),
    );
  });

  it("permanent facts (preference) never expire", async () => {
    const { writeFact, queryMemory } = await getJme();
    await writeFact({
      sourceTask: "t1",
      factText: "Fede prefers Spanish MX responses",
      category: "preference",
    });

    const row = mockDb
      .prepare("SELECT expires_at FROM jme_facts WHERE source_task = 't1'")
      .get() as { expires_at: number | null };
    expect(row.expires_at).toBeNull();

    const results = await queryMemory("Spanish responses");
    expect(results.length).toBeGreaterThan(0);
  });
});

describe("JME — lifecycle", () => {
  it("pruneExpiredFacts removes expired rows", async () => {
    const { writeFact, pruneExpiredFacts, jmeStats } = await getJme();
    const pastExpiry = Date.now() - 1000;
    await writeFact({
      sourceTask: "t1",
      factText: "stale event fact",
      category: "event",
      expiresAt: pastExpiry,
    });

    const pruned = pruneExpiredFacts();
    expect(pruned).toBe(1);
    expect(jmeStats().factsTotal).toBe(0);
  });

  it("pruneExpiredFacts removes low-confidence stale rows", async () => {
    const { writeFact, pruneExpiredFacts, jmeStats } = await getJme();

    // Manually insert a stale low-confidence fact (ts 60 days ago)
    const sixtyDaysAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;
    mockDb
      .prepare(
        `INSERT INTO jme_facts (source_task, ts, fact_text, category, confidence)
       VALUES ('t1', ?, 'uncertain old fact', 'event', 0.3)`,
      )
      .run(sixtyDaysAgo);
    // Also insert FTS5 index manually
    mockDb
      .prepare(
        `INSERT INTO jme_facts_fts(rowid, fact_text) VALUES (last_insert_rowid(), 'uncertain old fact')`,
      )
      .run();

    const pruned = pruneExpiredFacts();
    expect(pruned).toBeGreaterThanOrEqual(1);
    expect(jmeStats().factsTotal).toBe(0);
  });

  it("pruneExpiredFacts keeps valid facts untouched", async () => {
    const { writeFact, pruneExpiredFacts, jmeStats } = await getJme();
    await writeFact({
      sourceTask: "t1",
      factText: "Fede prefers bullet points",
      category: "preference",
    });

    const pruned = pruneExpiredFacts();
    expect(pruned).toBe(0);
    expect(jmeStats().factsTotal).toBe(1);
  });
});

describe("JME — stats", () => {
  it("jmeStats returns correct counts", async () => {
    const { writeEpisodic, writeFact, jmeStats } = await getJme();

    writeEpisodic({ taskId: "t1", role: "user", content: "hello" });
    writeEpisodic({ taskId: "t1", role: "jarvis", content: "hi" });
    await writeFact({
      sourceTask: "t1",
      factText: "test fact",
      category: "event",
    });

    const stats = jmeStats();
    expect(stats.turnsTotal).toBe(2);
    expect(stats.factsTotal).toBe(1);
    expect(stats.factsWithEmbedding).toBe(0); // embed() returns null in tests
  });
});

// ── Phase 2: Consolidator + Dedup ─────────────────────────────────────────────

describe("JME — upsertFact (dedup)", () => {
  it("inserts a new fact when no near-duplicate exists (embed unavailable)", async () => {
    const { upsertFact, jmeStats } = await getJme();

    // embed() mock returns null → no vector comparison → plain insert
    const outcome = await upsertFact({
      sourceTask: "t1",
      factText: "Fede prefers concise responses",
      category: "preference",
    });

    expect(outcome).toBe("inserted");
    expect(jmeStats().factsTotal).toBe(1);
  });

  it("skips fact when TRUE cosine similarity >= SKIP_THRESHOLD (near-identical)", async () => {
    const { upsertFact, jmeStats, CONSOLIDATOR_SKIP_THRESHOLD } =
      await getJme();
    const {
      embed: embedMock,
      cosineSimilarity: cosSim,
      deserializeEmbedding: deser,
      serializeEmbedding: ser,
    } = await import("./embeddings.js");

    const vec = new Float32Array([1, 0, 0]);
    const blob = Buffer.from(vec.buffer);

    // Seed fact WITH a stored embedding
    vi.mocked(embedMock).mockResolvedValue(vec);
    vi.mocked(ser).mockReturnValue(blob);
    await upsertFact({
      sourceTask: "t1",
      factText: "Fede likes coffee",
      category: "preference",
    });

    // Second upsert: cosine reads near-identical everywhere (queryMemory's
    // candidate scan AND the true-cosine re-check both go through cosSim)
    vi.mocked(deser).mockReturnValue(vec);
    vi.mocked(cosSim).mockReturnValue(CONSOLIDATOR_SKIP_THRESHOLD + 0.01);

    const outcome = await upsertFact({
      sourceTask: "t2",
      factText: "Fede likes coffee",
      category: "preference",
    });

    expect(outcome).toBe("skipped");
    expect(jmeStats().factsTotal).toBe(1); // still only 1 fact

    // restore defaults
    vi.mocked(embedMock).mockResolvedValue(null);
    vi.mocked(cosSim).mockReturnValue(0);
    vi.mocked(ser).mockImplementation((v: Float32Array) =>
      Buffer.from(v.buffer, v.byteOffset, v.byteLength),
    );
  });

  it("supersedes the MATCHED row when cosine is between DEDUP and SKIP", async () => {
    const {
      upsertFact,
      jmeStats,
      CONSOLIDATOR_DEDUP_THRESHOLD,
      CONSOLIDATOR_SKIP_THRESHOLD,
    } = await getJme();
    const {
      embed: embedMock,
      cosineSimilarity: cosSim,
      deserializeEmbedding: deser,
      serializeEmbedding: ser,
    } = await import("./embeddings.js");

    const vec = new Float32Array([1, 0, 0]);
    const blob = Buffer.from(vec.buffer);

    vi.mocked(embedMock).mockResolvedValue(vec);
    vi.mocked(ser).mockReturnValue(blob);
    await upsertFact({
      sourceTask: "t1",
      factText: "Fede uses Valle de Bravo to rest",
      category: "event",
    });
    const seeded = mockDb.prepare(`SELECT id FROM jme_facts LIMIT 1`).get() as {
      id: number;
    };

    const midSim =
      (CONSOLIDATOR_DEDUP_THRESHOLD + CONSOLIDATOR_SKIP_THRESHOLD) / 2;
    vi.mocked(deser).mockReturnValue(vec);
    vi.mocked(cosSim).mockReturnValue(midSim);

    const outcome = await upsertFact({
      sourceTask: "t2",
      factText: "Fede uses Valle de Bravo for rest and recovery",
      category: "event",
    });

    expect(outcome).toBe("superseded");
    // Old fact expired + new fact inserted = 2 rows total
    expect(jmeStats().factsTotal).toBe(2);
    // W2: the supersede must expire the MATCHED row (by id), not an arbitrary one
    const oldRow = mockDb
      .prepare(`SELECT expires_at FROM jme_facts WHERE id = ?`)
      .get(seeded.id) as { expires_at: number | null };
    expect(oldRow.expires_at).not.toBeNull();

    // restore
    vi.mocked(embedMock).mockResolvedValue(null);
    vi.mocked(cosSim).mockReturnValue(0);
    vi.mocked(ser).mockImplementation((v: Float32Array) =>
      Buffer.from(v.buffer, v.byteOffset, v.byteLength),
    );
  });

  it("NEVER skips on the FTS-only path — keyword overlap is not similarity (audit C2)", async () => {
    const { upsertFact, jmeStats, writeFact } = await getJme();
    // embed stays null (default): the fused score would be keyword-only, with
    // the top FTS hit normalized to 1.0 — the exact condition that silently
    // dropped unrelated facts pre-fix.
    await writeFact({
      sourceTask: "t1",
      factText: "Fede prefers dark roast coffee in the morning",
      category: "preference",
    });

    const outcome = await upsertFact({
      sourceTask: "t2",
      factText: "The coffee machine in the office broke yesterday",
      category: "event",
    });

    expect(outcome).toBe("inserted");
    expect(jmeStats().factsTotal).toBe(2);
  });

  it("clamps out-of-range confidence into [0,1] (audit W3)", async () => {
    const { upsertFact } = await getJme();
    await upsertFact({
      sourceTask: "t1",
      factText: "Fede runs a VPS with mission-control",
      category: "project",
      confidence: 7,
    });
    const row = mockDb
      .prepare(`SELECT confidence FROM jme_facts LIMIT 1`)
      .get() as { confidence: number };
    expect(row.confidence).toBe(1);
  });
});

describe("JME — consolidateAll (nightly batch)", () => {
  beforeEach(() => {
    inferMock.mockReset();
  });

  /** Insert a turn old enough for the consolidator's 30-min settle window. */
  function insertSettledTurn(taskId: string, role: string, content: string) {
    mockDb
      .prepare(
        `INSERT INTO jme_turns (task_id, role, content, channel, ts) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(taskId, role, content, "telegram", Date.now() - 31 * 60 * 1000);
  }

  it("consolidates settled turns ACROSS tasks in one call and deletes exactly them", async () => {
    const { consolidateAll, jmeStats } = await getJme();

    insertSettledTurn("task-a", "user", "I prefer short answers");
    insertSettledTurn("task-a", "jarvis", "Noted!");
    insertSettledTurn("task-b", "user", "Vamos a despertar Pipesong");

    inferMock.mockResolvedValueOnce({
      content: JSON.stringify([
        {
          factText: "Fede prefers short answers",
          category: "preference",
          confidence: 0.9,
        },
      ]),
    });

    const result = await consolidateAll();

    expect(result.turnsProcessed).toBe(3); // one batch, both tasks
    expect(inferMock).toHaveBeenCalledTimes(1); // ONE Haiku call for the window
    expect(result.factsExtracted).toBe(1);
    expect(result.factsInserted).toBe(1);
    expect(jmeStats().turnsTotal).toBe(0);
    expect(jmeStats().factsTotal).toBe(1);
  });

  it("pins the extraction message shape: directive in role:system, transcript in role:user (issue #29)", async () => {
    const { consolidateAll } = await getJme();

    insertSettledTurn("task-shape", "user", "Me gusta el café de Veracruz");
    inferMock.mockResolvedValueOnce({ content: "[]" });

    await consolidateAll();

    const req = inferMock.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string; cacheable?: boolean }>;
    };
    expect(req.messages).toHaveLength(2);
    // System message carries the extractor directive and must stay
    // default-cacheable — cacheable:false routes it back into the user
    // prefix (flattenMessagesForSdk) and re-opens the #29 prose failure.
    expect(req.messages[0].role).toBe("system");
    expect(req.messages[0].content).toContain("fact extractor");
    expect(req.messages[0].cacheable).toBeUndefined();
    // User message is transcript + trailing instruction, NOT the directive.
    expect(req.messages[1].role).toBe("user");
    expect(req.messages[1].content).toContain("Me gusta el café de Veracruz");
    expect(req.messages[1].content).not.toContain("fact extractor");
    expect(req.messages[1].content).toMatch(/ONLY the JSON array\.$/);
  });

  it("leaves turns younger than the settle window for the next run", async () => {
    const { consolidateAll, writeEpisodic, jmeStats } = await getJme();

    insertSettledTurn("task-old", "user", "settled message");
    writeEpisodic({ taskId: "task-live", role: "user", content: "just now" });
    inferMock.mockResolvedValueOnce({ content: "[]" });

    const result = await consolidateAll();

    expect(result.turnsProcessed).toBe(1);
    expect(jmeStats().turnsTotal).toBe(1); // the fresh turn survives
  });

  it("returns zeros without calling Haiku when nothing is settled", async () => {
    const { consolidateAll, writeEpisodic } = await getJme();

    writeEpisodic({ taskId: "task-live", role: "user", content: "hi" });

    const result = await consolidateAll();

    expect(result.turnsProcessed).toBe(0);
    expect(inferMock).not.toHaveBeenCalled();
  });

  it("a valid empty [] consumes the window (nothing durable is a valid verdict)", async () => {
    const { consolidateAll, jmeStats } = await getJme();

    insertSettledTurn("task-empty", "user", "hola");
    inferMock.mockResolvedValueOnce({ content: "[]" });

    const result = await consolidateAll();

    expect(result.factsExtracted).toBe(0);
    expect(jmeStats().turnsTotal).toBe(0); // consumed
  });

  it("an EMPTY Haiku response retains the turns (transient failure, not a verdict)", async () => {
    const { consolidateAll, jmeStats } = await getJme();

    insertSettledTurn("task-blank", "user", "hola");
    inferMock.mockResolvedValueOnce({ content: "" });

    const result = await consolidateAll();

    expect(result.factsExtracted).toBe(0);
    expect(jmeStats().turnsTotal).toBe(1); // NOT deleted — retried next run
  });

  it("malformed JSON leaves the turns IN PLACE for tomorrow's retry", async () => {
    const { consolidateAll, jmeStats } = await getJme();

    insertSettledTurn("task-bad", "user", "hello");
    inferMock.mockResolvedValueOnce({ content: "not valid json {{{" });

    const result = await consolidateAll();

    expect(result.factsExtracted).toBe(0);
    expect(jmeStats().turnsTotal).toBe(1); // NOT deleted — unconsumed data
  });
});

// ---------------------------------------------------------------------------
// pruneStaleTurns — global 7d sweep
// ---------------------------------------------------------------------------
describe("JME — pruneStaleTurns", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("removes turns older than TURN_RETENTION_DAYS and leaves recent ones", async () => {
    const { writeEpisodic, pruneStaleTurns, TURN_RETENTION_DAYS } =
      await getJme();

    // Write two turns — one recent, one >7d old
    writeEpisodic({ taskId: "task-recent", role: "user", content: "fresh" });

    // Manually backdate a turn by injecting directly into mockDb (column is `ts`)
    // Same unit production writes: writeEpisodic stores Date.now() MILLISECONDS
    // (audit C1: the old seconds-based fixture masked the units mismatch).
    const oldTimestamp = Date.now() - (TURN_RETENTION_DAYS + 1) * 86_400_000;
    mockDb
      .prepare(
        `INSERT INTO jme_turns (task_id, role, content, channel, ts) VALUES (?, ?, ?, ?, ?)`,
      )
      .run("task-old", "user", "stale content", "telegram", oldTimestamp);

    const deleted = pruneStaleTurns();

    // The stale turn should be deleted, the recent one preserved
    expect(deleted).toBe(1);
    const remaining = mockDb.prepare(`SELECT task_id FROM jme_turns`).all() as {
      task_id: string;
    }[];
    const ids = remaining.map((r) => r.task_id);
    expect(ids).toContain("task-recent");
    expect(ids).not.toContain("task-old");
  });

  it("returns 0 when no stale turns exist", async () => {
    const { writeEpisodic, pruneStaleTurns } = await getJme();

    writeEpisodic({ taskId: "task-new", role: "user", content: "brand new" });

    const deleted = pruneStaleTurns();
    expect(deleted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// deduplicateFacts — Phase 3 temporal filter
// ---------------------------------------------------------------------------
describe("JME — deduplicateFacts (Phase 3 temporal filter)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  /**
   * Build a minimal JmeRecallResult for use in deduplicateFacts tests.
   * Embeddings are plain Float32Arrays — cosineSimilarity is mocked globally.
   */
  function makeResult(
    id: number,
    ts: number,
    score = 0.8,
  ): import("./jme.js").JmeRecallResult {
    return {
      id,
      factText: `fact-${id}`,
      category: "project" as const,
      sourceTask: "test",
      score,
      ts,
    };
  }

  function makeEmbedding(id: number, value: number): [number, Float32Array] {
    const vec = new Float32Array(4);
    vec.fill(value);
    return [id, vec];
  }

  it("passes through single-element list unchanged", async () => {
    const { deduplicateFacts, TEMPORAL_DEDUP_THRESHOLD } = await getJme();
    const r = makeResult(1, 1000);
    const embeddings = new Map([makeEmbedding(1, 0.5)]);

    // cosineSimilarity mock returns 0 — no clustering possible
    const { cosineSimilarity: cosineSim } = await import("./embeddings.js");
    vi.mocked(cosineSim).mockReturnValue(0);

    const out = deduplicateFacts([r], embeddings);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(1);
    void TEMPORAL_DEDUP_THRESHOLD; // import check
  });

  it("passes through two dissimilar facts unchanged", async () => {
    const { deduplicateFacts } = await getJme();
    const r1 = makeResult(1, 1000, 0.9);
    const r2 = makeResult(2, 2000, 0.7);
    const embeddings = new Map([makeEmbedding(1, 0.1), makeEmbedding(2, 0.9)]);

    const { cosineSimilarity: cosineSim } = await import("./embeddings.js");
    // Low similarity — below threshold
    vi.mocked(cosineSim).mockReturnValue(0.3);

    const out = deduplicateFacts([r1, r2], embeddings);
    expect(out).toHaveLength(2);
  });

  it("removes older fact when two facts are semantically similar", async () => {
    const { deduplicateFacts, TEMPORAL_DEDUP_THRESHOLD } = await getJme();

    const older = makeResult(1, 1000, 0.9); // higher score but older
    const newer = makeResult(2, 9000, 0.7); // lower score but newer
    const embeddings = new Map([makeEmbedding(1, 0.5), makeEmbedding(2, 0.5)]);

    const { cosineSimilarity: cosineSim } = await import("./embeddings.js");
    // High similarity — above threshold
    vi.mocked(cosineSim).mockReturnValue(TEMPORAL_DEDUP_THRESHOLD + 0.01);

    const out = deduplicateFacts([older, newer], embeddings);
    // Should keep the newer fact, drop the older one
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(2);
  });

  it("collapses a 3+ member cluster to ONLY the newest fact (v1/v2/v3 regression)", async () => {
    const { deduplicateFacts, TEMPORAL_DEDUP_THRESHOLD } = await getJme();

    // Same topic, three versions: ranked v1 > v2 > v3 by score, aged
    // v1 < v2 < v3. Spec: only v3 reaches the context. The pre-fix shape
    // returned [v2, v3] — the anchor broke on the FIRST newer candidate and
    // never absorbed the rest of the cluster. 2-member tests cannot catch
    // this; keep this one 3-wide.
    const v1 = makeResult(1, 100, 0.9);
    const v2 = makeResult(2, 200, 0.8);
    const v3 = makeResult(3, 300, 0.7);
    const embeddings = new Map([
      makeEmbedding(1, 0.5),
      makeEmbedding(2, 0.5),
      makeEmbedding(3, 0.5),
    ]);

    const { cosineSimilarity: cosineSim } = await import("./embeddings.js");
    vi.mocked(cosineSim).mockReturnValue(TEMPORAL_DEDUP_THRESHOLD + 0.01);

    const out = deduplicateFacts([v1, v2, v3], embeddings);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(3);
  });

  it("keeps older fact when anchor is more recent than candidate", async () => {
    const { deduplicateFacts, TEMPORAL_DEDUP_THRESHOLD } = await getJme();

    const anchor = makeResult(1, 9000, 0.9); // higher score AND newer
    const candidate = makeResult(2, 1000, 0.7); // lower score AND older
    const embeddings = new Map([makeEmbedding(1, 0.5), makeEmbedding(2, 0.5)]);

    const { cosineSimilarity: cosineSim } = await import("./embeddings.js");
    vi.mocked(cosineSim).mockReturnValue(TEMPORAL_DEDUP_THRESHOLD + 0.01);

    const out = deduplicateFacts([anchor, candidate], embeddings);
    // Anchor is newer — keep anchor, drop candidate
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(1);
  });

  it("skips facts without embeddings (keeps them unconditionally)", async () => {
    const { deduplicateFacts, TEMPORAL_DEDUP_THRESHOLD } = await getJme();

    const withEmb = makeResult(1, 9000, 0.9);
    const noEmb = makeResult(2, 1000, 0.8);
    // Only id=1 has an embedding; id=2 has none
    const embeddings = new Map([makeEmbedding(1, 0.5)]);

    const { cosineSimilarity: cosineSim } = await import("./embeddings.js");
    vi.mocked(cosineSim).mockReturnValue(TEMPORAL_DEDUP_THRESHOLD + 0.01);

    const out = deduplicateFacts([withEmb, noEmb], embeddings);
    // Both kept: id=2 has no embedding so cannot be clustered
    expect(out).toHaveLength(2);
  });

  it("returns empty list unchanged", async () => {
    const { deduplicateFacts } = await getJme();
    const out = deduplicateFacts([], new Map());
    expect(out).toHaveLength(0);
  });
});
