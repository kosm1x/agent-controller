/**
 * JME — Jarvis Memory Engine (Phase 0)
 *
 * Two-layer conversation memory for "solo conversaciones con Fede":
 *   - Episodic store (jme_turns): raw turns, immutable, keyed by task_id
 *   - Semantic store (jme_facts): extracted facts with embeddings + TTL
 *
 * Design decisions:
 *   - Embeddings via existing Gemini embed() (1536 dims) — zero new infra
 *   - BM25 (FTS5) fallback when embeddings unavailable
 *   - Hybrid ranking: vector cosine + keyword score fused
 *   - TTL per category (decisions: 90d, preferences: permanent, events: 30d,
 *     emotions: 14d, projects: 90d)
 *   - Fact extraction runs async at session close (not in turn critical path)
 */

import { getDatabase, writeWithRetry } from "../db/index.js";

import {
  embed,
  cosineSimilarity,
  serializeEmbedding,
  deserializeEmbedding,
} from "./embeddings.js";
import { errMsg } from "../lib/err-msg.js";
import { logRecall } from "./recall-utility.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type JmeTurnRole = "user" | "jarvis";

export type JmeFactCategory =
  | "decision"
  | "preference"
  | "event"
  | "emotion"
  | "project";

export interface JmeTurn {
  taskId: string;
  role: JmeTurnRole;
  content: string;
  channel?: string;
}

export interface JmeFact {
  id?: number;
  sourceTask: string;
  factText: string;
  category: JmeFactCategory;
  confidence?: number;
  /** Unix epoch ms. null = permanent */
  expiresAt?: number | null;
}

export interface JmeRecallResult {
  factText: string;
  category: JmeFactCategory;
  sourceTask: string;
  score: number;
  ts: number;
}

// ── TTL per category (ms) ────────────────────────────────────────────────────

const TTL_MS: Record<JmeFactCategory, number | null> = {
  decision: 90 * 24 * 60 * 60 * 1000,
  preference: null, // permanent
  event: 30 * 24 * 60 * 60 * 1000,
  emotion: 14 * 24 * 60 * 60 * 1000,
  project: 90 * 24 * 60 * 60 * 1000,
};

// ── Episodic store ───────────────────────────────────────────────────────────

/**
 * Write a single turn to the episodic store.
 * Call during or at the end of a task to record the conversation.
 */
export function writeEpisodic(turn: JmeTurn): void {
  const db = getDatabase();
  writeWithRetry(() => {
    db.prepare(
      `INSERT INTO jme_turns (task_id, ts, role, content, channel)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      turn.taskId,
      Date.now(),
      turn.role,
      turn.content,
      turn.channel ?? "unknown",
    );
  });
}

/**
 * Retrieve recent turns for a given task (for consolidation input).
 */
export function getTurnsForTask(
  taskId: string,
  limit = 50,
): Array<{ role: JmeTurnRole; content: string; ts: number }> {
  const db = getDatabase();
  // W4/W7: grab the most recent `limit` turns (deterministic tie-break on id
  // when timestamps collide), then reverse to restore chronological (ASC)
  // order for consolidation input.
  const rows = db
    .prepare(
      `SELECT role, content, ts FROM jme_turns
       WHERE task_id = ?
       ORDER BY ts DESC, id DESC
       LIMIT ?`,
    )
    .all(taskId, limit) as Array<{
    role: JmeTurnRole;
    content: string;
    ts: number;
  }>;
  return rows.reverse();
}

// ── Semantic store ───────────────────────────────────────────────────────────

/**
 * Resolve the persisted row values for a fact (TTL → expires_at, best-effort
 * embedding). Kept separate so both writeFact and writeFacts can await the
 * async embedding step *before* opening a synchronous DB transaction.
 */
async function prepareFactRow(
  fact: JmeFact,
  now: number,
): Promise<{
  sourceTask: string;
  ts: number;
  factText: string;
  category: string;
  embeddingBlob: Buffer | null;
  expiresAt: number | null;
  confidence: number;
}> {
  const ttl = TTL_MS[fact.category];
  const expiresAt = fact.expiresAt !== undefined
    ? fact.expiresAt
    : ttl !== null
      ? now + ttl
      : null;

  // Embed fact text (best-effort)
  let embeddingBlob: Buffer | null = null;
  try {
    const vec = await embed(fact.factText);
    if (vec) embeddingBlob = serializeEmbedding(vec);
  } catch {
    // silently degrade to FTS5-only
  }

  return {
    sourceTask: fact.sourceTask,
    ts: now,
    factText: fact.factText,
    category: fact.category,
    embeddingBlob,
    expiresAt,
    confidence: fact.confidence ?? 1.0,
  };
}

const INSERT_FACT_SQL = `INSERT INTO jme_facts (source_task, ts, fact_text, category, embedding, expires_at, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?)`;

/**
 * Write a fact to the semantic store.
 * Embeds asynchronously — if embedding fails, falls back to FTS5-only.
 */
export async function writeFact(fact: JmeFact): Promise<void> {
  const db = getDatabase();
  const now = Date.now();
  const row = await prepareFactRow(fact, now);

  writeWithRetry(() => {
    db.prepare(INSERT_FACT_SQL).run(
      row.sourceTask,
      row.ts,
      row.factText,
      row.category,
      row.embeddingBlob,
      row.expiresAt,
      row.confidence,
    );
  });
}

/**
 * Write multiple facts atomically.
 *
 * W3: async embedding is resolved for every fact *before* the transaction,
 * then all rows are inserted inside a single real db.transaction so either
 * all facts land or none do (no partial writes on failure).
 */
export async function writeFacts(facts: JmeFact[]): Promise<void> {
  if (facts.length === 0) return;
  const db = getDatabase();
  const now = Date.now();

  const rows = await Promise.all(
    facts.map((fact) => prepareFactRow(fact, now)),
  );

  const insertAll = db.transaction(
    (
      pending: Array<Awaited<ReturnType<typeof prepareFactRow>>>,
    ): void => {
      const stmt = db.prepare(INSERT_FACT_SQL);
      for (const row of pending) {
        stmt.run(
          row.sourceTask,
          row.ts,
          row.factText,
          row.category,
          row.embeddingBlob,
          row.expiresAt,
          row.confidence,
        );
      }
    },
  );

  writeWithRetry(() => insertAll(rows));
}

// ── Retrieval ────────────────────────────────────────────────────────────────

/**
 * W1: Turn a free-form query into safe FTS5 keyword tokens.
 * - Lowercases everything (FTS5 operators AND/OR/NOT/NEAR are case-sensitive
 *   uppercase, so lowercasing alone neutralizes them as operators).
 * - Strips punctuation/special chars that carry FTS5 meaning (", *, :, (, ),
 *   ^, -, etc.), keeping only alphanumerics and accented letters.
 * - Drops the reserved operator words defensively and tokens ≤2 chars.
 */
function extractKeywords(query: string): string[] {
  const FTS5_OPERATORS = new Set(["and", "or", "not", "near"]);
  return query
    .toLowerCase()
    .replace(/[^a-z0-9áéíóúñü\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 2 && !FTS5_OPERATORS.has(w));
}

/**
 * Query the semantic store — hybrid BM25 + vector search.
 *
 * 1. Embed the query
 * 2. Fetch all non-expired facts with embeddings → cosine similarity
 * 3. FTS5 keyword match → BM25 score
 * 4. Fuse scores (0.7 vector + 0.3 keyword), deduplicate, top-K
 *
 * Falls back to FTS5-only if embedding fails.
 */
export async function queryMemory(
  query: string,
  options: { k?: number; minScore?: number } = {},
): Promise<JmeRecallResult[]> {
  const { k = 8, minScore = 0.25 } = options;
  const db = getDatabase();
  const now = Date.now();
  const startedAt = now;

  type DbFactRow = {
    id: number;
    fact_text: string;
    category: string;
    source_task: string;
    ts: number;
    embedding: Buffer | null;
    confidence: number;
  };

  // ── 1. Vector search ───────────────────────────────────────────────────────
  const vectorScores = new Map<number, number>();

  let queryVec: Float32Array | null = null;
  try {
    queryVec = await embed(query);
  } catch {
    // ignore — will use FTS5 only
  }

  if (queryVec) {
    const rows = db
      .prepare(
        `SELECT id, fact_text, category, source_task, ts, embedding, confidence
         FROM jme_facts
         WHERE embedding IS NOT NULL
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY ts DESC
         LIMIT 500`,
      )
      .all(now) as DbFactRow[];

    for (const row of rows) {
      if (!row.embedding) continue;
      try {
        const factVec = deserializeEmbedding(row.embedding);
        const sim = cosineSimilarity(queryVec, factVec);
        vectorScores.set(row.id, sim * row.confidence);
      } catch {
        // skip malformed embedding
      }
    }
  }

  // ── 2. FTS5 keyword search ─────────────────────────────────────────────────
  const keywordScores = new Map<number, number>();
  try {
    // W1: lowercase + strip FTS5 operators so user tokens can never be
    // interpreted as query syntax (AND/OR/NOT/NEAR, column filters, etc.).
    const keywords = extractKeywords(query);
    const ftsQuery = keywords.join(" OR ");

    if (ftsQuery) {
      const keywordRows = db
        .prepare(
          `SELECT f.id, bm25(jme_facts_fts) AS bm25_score
           FROM jme_facts_fts
           JOIN jme_facts f ON f.id = jme_facts_fts.rowid
           WHERE jme_facts_fts MATCH ?
             AND (f.expires_at IS NULL OR f.expires_at > ?)
           LIMIT 100`,
        )
        .all(ftsQuery, now) as Array<{ id: number; bm25_score: number }>;

      // W2: BM25 in SQLite FTS5 is negative (lower = better). Normalize each
      // score against the actual best (most negative) score in this result
      // set — divide by Math.max of the |scores| so the top hit maps to 1.0.
      // No hardcoded 0.001 default floor (which acted as a ceiling and flat-
      // lined every score to ~1.0).
      const magnitudes = keywordRows.map((r) => Math.abs(r.bm25_score));
      const maxMagnitude = Math.max(...magnitudes, 0);
      for (const row of keywordRows) {
        const normalized =
          maxMagnitude > 0 ? Math.abs(row.bm25_score) / maxMagnitude : 0;
        keywordScores.set(row.id, normalized);
      }
    }
  } catch (err) {
    console.warn("[jme] FTS5 query failed:", errMsg(err));
  }

  // ── 3. Gather all candidate IDs ────────────────────────────────────────────
  const allIds = new Set([...vectorScores.keys(), ...keywordScores.keys()]);
  if (allIds.size === 0) return [];

  // ── 4. Fetch metadata for all candidates ──────────────────────────────────
  const idList = [...allIds].join(",");
  const candidateRows = db
    .prepare(
      `SELECT id, fact_text, category, source_task, ts
       FROM jme_facts
       WHERE id IN (${idList})`,
    )
    .all() as Array<{
    id: number;
    fact_text: string;
    category: string;
    source_task: string;
    ts: number;
  }>;

  // ── 5. Fuse scores ─────────────────────────────────────────────────────────
  const results: JmeRecallResult[] = candidateRows
    .map((row) => {
      const vScore = vectorScores.get(row.id) ?? 0;
      const kScore = keywordScores.get(row.id) ?? 0;
      const fused = queryVec
        ? vScore * 0.7 + kScore * 0.3
        : kScore;

      return {
        factText: row.fact_text,
        category: row.category as JmeFactCategory,
        sourceTask: row.source_task,
        score: fused,
        ts: row.ts,
      };
    })
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  // Telemetry: record this recall in the shared audit table with source:'jme'
  // so JME retrievals are observable alongside the hindsight/sqlite paths.
  try {
    logRecall({
      bank: "jme",
      query,
      source: "jme",
      results: results.map((r) => ({
        content: r.factText,
        relevance: r.score,
        createdAt: new Date(r.ts).toISOString(),
      })),
      latencyMs: Date.now() - startedAt,
    });
  } catch {
    // telemetry is best-effort — never fail a recall on an audit-write error
  }

  return results;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * Prune expired facts and low-confidence facts older than 30 days.
 * Safe to call on a schedule (weekly).
 */
export function pruneExpiredFacts(): number {
  const db = getDatabase();
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

  const result = db
    .prepare(
      `DELETE FROM jme_facts
       WHERE (expires_at IS NOT NULL AND expires_at < ?)
          OR (confidence < 0.4 AND ts < ?)`,
    )
    .run(now, thirtyDaysAgo);

  return result.changes;
}

/**
 * Stats for monitoring.
 */
export function jmeStats(): {
  turnsTotal: number;
  factsTotal: number;
  factsWithEmbedding: number;
  factsExpiringSoon: number;
} {
  const db = getDatabase();
  const now = Date.now();
  const sevenDays = now + 7 * 24 * 60 * 60 * 1000;

  const turnsTotal = (
    db.prepare("SELECT COUNT(*) as n FROM jme_turns").get() as { n: number }
  ).n;
  const factsTotal = (
    db.prepare("SELECT COUNT(*) as n FROM jme_facts").get() as { n: number }
  ).n;
  const factsWithEmbedding = (
    db
      .prepare(
        "SELECT COUNT(*) as n FROM jme_facts WHERE embedding IS NOT NULL",
      )
      .get() as { n: number }
  ).n;
  // W6: only count facts expiring within the *next* 7 days — the window is
  // BETWEEN now AND now+7d, so already-expired facts are excluded.
  const factsExpiringSoon = (
    db
      .prepare(
        "SELECT COUNT(*) as n FROM jme_facts WHERE expires_at IS NOT NULL AND expires_at BETWEEN ? AND ?",
      )
      .get(now, sevenDays) as { n: number }
  ).n;

  return { turnsTotal, factsTotal, factsWithEmbedding, factsExpiringSoon };
}
