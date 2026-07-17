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
import { infer } from "../inference/adapter.js";
import { HAIKU_MODEL_ID } from "../inference/claude-sdk.js";

// ── Phase 3 constants ────────────────────────────────────────────────────────

/**
 * Cosine similarity threshold above which two facts are considered to be
 * about the same topic. When grouping recall candidates, only the most-recent
 * fact per cluster survives. Keeps contradictory v1/v3 facts out of the same
 * context window. (Phase 3, Pieza 1)
 */
export const TEMPORAL_DEDUP_THRESHOLD = 0.85;

/**
 * When jme_facts with embeddings exceeds this count, the nightly consolidator
 * emits a warn log. LIMIT 500 in queryMemory() starts being a bottleneck at
 * ~400 rows. (Phase 3, Pieza 2)
 */
export const VECTOR_CEILING_WARN = 400;

// ── Types ────────────────────────────────────────────────────────────────────

export type JmeTurnRole = "user" | "jarvis";

export type JmeFactCategory =
  "decision" | "preference" | "event" | "emotion" | "project";

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
  /** jme_facts row id — lets consumers (dedup supersede) target the exact row. */
  id: number;
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
  const expiresAt =
    fact.expiresAt !== undefined
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
    (pending: Array<Awaited<ReturnType<typeof prepareFactRow>>>): void => {
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
/**
 * Temporal deduplication of recall candidates.
 *
 * Groups results by semantic similarity (cosine > TEMPORAL_DEDUP_THRESHOLD).
 * Within each cluster, keeps only the most-recent fact (highest `ts`).
 * Prevents contradictory v1/v3 facts from appearing in the same context window.
 *
 * Algorithm is O(n²) over the recall set — acceptable because k ≤ 20 and
 * this runs entirely in-process with pre-loaded Float32Arrays.
 *
 * @param results   Already-ranked recall results (best first)
 * @param queryVec  Query embedding used during the original vector search;
 *                  used to re-compute inter-fact similarities. If null, no
 *                  deduplication is performed (FTS5-only path).
 * @returns Filtered results with at most one representative per cluster,
 *          preserving the original ranking order among survivors.
 */
export function deduplicateFacts(
  results: JmeRecallResult[],
  factEmbeddings: Map<number, Float32Array>,
): JmeRecallResult[] {
  if (results.length <= 1) return results;

  const kept: JmeRecallResult[] = [];
  // cluster[i] = true if result[i] was already absorbed into a cluster
  const absorbed = new Set<number>();

  for (let i = 0; i < results.length; i++) {
    if (absorbed.has(i)) continue;

    const anchor = results[i];
    const anchorVec = factEmbeddings.get(anchor.id);

    // If we have no embedding for the anchor, keep it unconditionally —
    // we can't meaningfully cluster it.
    if (!anchorVec) {
      kept.push(anchor);
      continue;
    }

    // Scan later results for cluster members
    for (let j = i + 1; j < results.length; j++) {
      if (absorbed.has(j)) continue;
      const candidate = results[j];
      const candidateVec = factEmbeddings.get(candidate.id);
      if (!candidateVec) continue;

      const sim = cosineSimilarity(anchorVec, candidateVec);
      if (sim >= TEMPORAL_DEDUP_THRESHOLD) {
        // Keep the more-recent fact, drop the older one.
        // Anchor was ranked higher (better score) but if candidate is newer,
        // promote candidate and mark anchor for replacement.
        if (candidate.ts > anchor.ts) {
          // Candidate is newer — it should replace the anchor in the output.
          // We'll handle this by NOT adding anchor to kept, adding candidate,
          // and absorbing anchor.
          absorbed.add(i);
          absorbed.add(j);
          kept.push(candidate);
          break; // anchor is gone — move to next i
        } else {
          // Anchor is newer (or same age) — absorb candidate, keep anchor
          absorbed.add(j);
        }
      }
    }

    // Only add anchor if it wasn't absorbed by a newer candidate in the loop
    if (!absorbed.has(i)) {
      kept.push(anchor);
    }
  }

  return kept;
}

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
  // Phase 3 Pieza 1: stash deserialized embeddings for temporal dedup below
  const factEmbeddings = new Map<number, Float32Array>();

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
        factEmbeddings.set(row.id, factVec);
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

  // Single return path so telemetry (logRecall) fires for EVERY recall —
  // including empty-result recalls — preserving source:'jme' and latency.
  const logAndReturn = (results: JmeRecallResult[]): JmeRecallResult[] => {
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
  };

  // ── 3. Gather all candidate IDs ────────────────────────────────────────────
  const allIds = new Set([...vectorScores.keys(), ...keywordScores.keys()]);
  if (allIds.size === 0) return logAndReturn([]);

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
  const fused: JmeRecallResult[] = candidateRows
    .map((row) => {
      const vScore = vectorScores.get(row.id) ?? 0;
      const kScore = keywordScores.get(row.id) ?? 0;
      const fusedScore = queryVec ? vScore * 0.7 + kScore * 0.3 : kScore;

      return {
        id: row.id,
        factText: row.fact_text,
        category: row.category as JmeFactCategory,
        sourceTask: row.source_task,
        score: fusedScore,
        ts: row.ts,
      };
    })
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  // ── 5.5 Temporal dedup (Phase 3 Pieza 1) ──────────────────────────────────
  // Group semantically similar facts and keep only the most-recent per cluster.
  // Prevents contradictory v1/v3 versions of the same fact from appearing in
  // the same context window. Only runs when we have embeddings to compare.
  const results =
    factEmbeddings.size > 0 ? deduplicateFacts(fused, factEmbeddings) : fused;

  if (results.length < fused.length) {
    console.log(
      `[jme] temporal dedup: ${fused.length} → ${results.length} facts (removed ${fused.length - results.length} stale duplicate(s))`,
    );
  }

  // Telemetry: record this recall in the shared audit table with source:'jme'
  // so JME retrievals are observable alongside the hindsight/sqlite paths.
  return logAndReturn(results);
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

// ── Phase 2 — Consolidator + Dedup ───────────────────────────────────────────

/**
 * Similarity threshold above which an incoming fact is considered a
 * near-duplicate of an existing one and should SUPERSEDE it (update
 * expires_at of the old fact + insert the new one).
 */
export const CONSOLIDATOR_DEDUP_THRESHOLD = 0.85;

/**
 * Similarity threshold above which an incoming fact is considered IDENTICAL
 * to an existing one and is silently skipped (no insert, no supersede).
 */
export const CONSOLIDATOR_SKIP_THRESHOLD = 0.95;

/** Floor for the hybrid candidate-generation query. Deliberately LOW: the
 * fused score is only used to FIND candidates; the skip/supersede decision is
 * made on true cosine similarity below. */
const DEDUP_CANDIDATE_MIN_SCORE = 0.3;

/**
 * Upsert a fact with dedup. Decision metric: TRUE cosine similarity between
 * the incoming fact's embedding and each candidate's STORED embedding —
 * never the fused hybrid recall score (audit C2, 2026-07-14: the fused
 * score's keyword component is set-relative-normalized, so its top hit is
 * always 1.0 and any shared token could read as a near-duplicate).
 *
 *   - cosine >= SKIP_THRESHOLD  (0.95) → skip (no-op)
 *   - cosine >= DEDUP_THRESHOLD (0.85) → supersede (expire old + insert new)
 *   - otherwise                        → plain insert
 *
 * Candidates come from `queryMemory` (hybrid, full-corpus — no recency cap);
 * it is used ONLY as a candidate generator. If the incoming fact cannot be
 * embedded (Gemini outage/timeout), dedup is impossible and the fact is
 * PLAIN-INSERTED — a temporary duplicate beats a silently dropped fact.
 */
export async function upsertFact(
  fact: JmeFact,
): Promise<"skipped" | "superseded" | "inserted"> {
  const db = getDatabase();
  const now = Date.now();

  // Validate: reject empty text, truncate oversized, clamp confidence (W3 —
  // queryMemory ranks by sim*confidence and the stale-prune keys on <0.4, so
  // an out-of-range Haiku value skews both).
  const trimmedText = fact.factText.trim().slice(0, 2000);
  if (!trimmedText) return "skipped";
  const clamped: JmeFact = {
    ...fact,
    factText: trimmedText,
    confidence: Math.max(0, Math.min(1, fact.confidence ?? 1)),
  };

  let incomingVec: Float32Array | null = null;
  try {
    incomingVec = await embed(trimmedText);
  } catch {
    incomingVec = null;
  }
  if (!incomingVec) {
    // Embedding unavailable → no trustworthy similarity signal exists (the
    // FTS-only fused score must NEVER decide a skip). Insert plainly.
    await writeFact(clamped);
    return "inserted";
  }

  const candidates = await queryMemory(trimmedText, {
    k: 3,
    minScore: DEDUP_CANDIDATE_MIN_SCORE,
  });

  let bestSim = 0;
  let bestId: number | null = null;
  for (const candidate of candidates) {
    const row = db
      .prepare(
        `SELECT embedding FROM jme_facts
         WHERE id = ? AND embedding IS NOT NULL
           AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .get(candidate.id, now) as { embedding: Buffer } | undefined;
    if (!row) continue;
    try {
      const sim = cosineSimilarity(
        incomingVec,
        deserializeEmbedding(row.embedding),
      );
      if (sim > bestSim) {
        bestSim = sim;
        bestId = candidate.id;
      }
    } catch {
      // malformed stored embedding — not a dedup candidate
    }
  }

  if (bestSim >= CONSOLIDATOR_SKIP_THRESHOLD) {
    return "skipped";
  }

  if (bestSim >= CONSOLIDATOR_DEDUP_THRESHOLD && bestId !== null) {
    // Near-duplicate — supersede. Insert the NEW fact first, THEN expire the
    // old one: a crash in between leaves a temporary duplicate (self-heals on
    // the next dedup pass) instead of losing the fact outright.
    await writeFact(clamped);
    writeWithRetry(() => {
      db.prepare(`UPDATE jme_facts SET expires_at = ? WHERE id = ?`).run(
        now,
        bestId,
      );
    });
    return "superseded";
  }

  await writeFact(clamped);
  return "inserted";
}

/**
 * Fact extraction prompt for Haiku.
 * Returns a JSON array of fact objects.
 */
const CONSOLIDATOR_EXTRACT_PROMPT = `You are a fact extractor for a personal assistant memory system.
Given a conversation, extract a compact list of durable facts about the user.

Rules:
- Each fact must be a self-contained, standalone statement (no pronouns like "he/she").
- Only extract facts that would still be useful weeks from now.
- Skip greetings, filler, one-off operational details, and temporary states.
- Extract ONLY from what Fede (the user) states. NEVER extract from Jarvis's replies: Jarvis often restates facts it already remembers, and re-extracting those would create duplicates. Jarvis turns are context for understanding Fede, not a fact source.
- Categories: "decision" | "preference" | "event" | "emotion" | "project"
- Confidence: 0.0–1.0 (how confident you are this is a lasting fact)

Respond with ONLY a JSON array, no explanation:
[{"factText": "...", "category": "...", "confidence": 0.9}, ...]

If no durable facts are present, respond with: []`;

/** Turns younger than this are left for the NEXT nightly run — never eat a
 * conversation that may still be in flight. */
export const CONSOLIDATOR_MIN_TURN_AGE_MS = 30 * 60 * 1000;
/** Per-run turn cap: bounds the Haiku context; the leftover is picked up the
 * following night (and pruneStaleTurns bounds the worst case at 7d). */
export const CONSOLIDATOR_MAX_TURNS = 400;

export interface ConsolidateResult {
  turnsProcessed: number;
  factsExtracted: number;
  factsInserted: number;
  factsSkipped: number;
  factsSuperseded: number;
}

/**
 * NIGHTLY batch consolidation of the episodic buffer into the semantic fact
 * store (operator decision 2026-07-14, audit C3: the previous per-task wiring
 * fired one Haiku call per operator MESSAGE over a 2-turn window and deleted
 * the turns immediately — session-level context was structurally impossible).
 *
 * One run: load up to CONSOLIDATOR_MAX_TURNS turns older than 30 min across
 * ALL tasks (chronological), ONE Haiku extraction over the full window,
 * upsert each fact (cosine dedup), then delete exactly the processed turns.
 * Scheduled by the `jme-consolidate` cron (02:45 MX) in rituals/scheduler.ts.
 *
 * Safe to call fire-and-forget — never throws; failures log + emit
 * `schedule.run_failed` via recordRitualFailure (observability invariant).
 */
export async function consolidateAll(): Promise<ConsolidateResult> {
  const result: ConsolidateResult = {
    turnsProcessed: 0,
    factsExtracted: 0,
    factsInserted: 0,
    factsSkipped: 0,
    factsSuperseded: 0,
  };

  try {
    const db = getDatabase();

    // 1. Load the settled window (oldest first, capped)
    const turns = db
      .prepare(
        `SELECT id, role, content FROM jme_turns
         WHERE ts < ?
         ORDER BY ts ASC
         LIMIT ?`,
      )
      .all(
        Date.now() - CONSOLIDATOR_MIN_TURN_AGE_MS,
        CONSOLIDATOR_MAX_TURNS,
      ) as Array<{
      id: number;
      role: JmeTurnRole;
      content: string;
    }>;
    // Phase 3 Pieza 2: vector ceiling surveillance.
    // When jme_facts with embeddings approaches the LIMIT 500 in queryMemory(),
    // recall quality degrades (oldest facts get cut off). Warn early at 400 so
    // there's runway before it becomes a problem. Phase 4 will add auto-pruning.
    const embeddingCount = (
      db
        .prepare(
          "SELECT COUNT(*) as n FROM jme_facts WHERE embedding IS NOT NULL",
        )
        .get() as { n: number }
    ).n;
    if (embeddingCount >= VECTOR_CEILING_WARN) {
      console.warn(
        `[jme] consolidateAll: vector ceiling warning — ${embeddingCount} facts with embeddings (warn threshold=${VECTOR_CEILING_WARN}, query LIMIT=500). Consider pruning low-confidence facts.`,
      );
    }

    if (turns.length === 0) return result;
    result.turnsProcessed = turns.length;
    if (turns.length === CONSOLIDATOR_MAX_TURNS) {
      // No silent caps: the leftover is real work deferred to tomorrow.
      console.warn(
        `[jme] consolidateAll: hit the ${CONSOLIDATOR_MAX_TURNS}-turn cap — leftover turns consolidate next run`,
      );
    }

    // 2. Format the window for Haiku. Jarvis turns stay as context; the
    // prompt instructs extraction from Fede's statements ONLY (anti-echo:
    // Jarvis restating remembered facts must not re-extract them).
    const conversation = turns
      .map((t) => `${t.role === "user" ? "Fede" : "Jarvis"}: ${t.content}`)
      .join("\n");

    // 3. ONE extraction call over the whole window (effort:low — synthesis).
    // The directive MUST ride as a default-cacheable role:"system" message so
    // flattenMessagesForSdk promotes it to the SDK systemPrompt — burying it
    // at the top of the user message left the call on the "You are a helpful
    // assistant." default and Haiku CONTINUED the transcript's dialogue
    // instead of extracting (issue #29: 3/3 nightly runs → 0 facts). The
    // trailing user-side instruction keeps the directive as the last thing
    // the model reads after a 400-turn transcript. Do NOT mark the system
    // message cacheable:false — that routes it back into the user prefix.
    const response = await infer({
      messages: [
        { role: "system", content: CONSOLIDATOR_EXTRACT_PROMPT },
        {
          role: "user",
          content: `${conversation}\n\n---\nExtract the durable facts from the conversation above. Respond with ONLY the JSON array.`,
        },
      ],
      model: HAIKU_MODEL_ID,
      max_tokens: 1024,
      effort: "low",
    });

    const rawText = response.content?.trim() ?? "";
    // An EMPTY completion is a transient failure, not a verdict — the prompt
    // demands a literal [] for "nothing durable". Retain the turns for the
    // next run, same as a parse failure (R2 W1, 2026-07-14).
    if (!rawText) {
      console.error(
        "[jme] consolidateAll: empty Haiku response — retrying next run",
      );
      return result;
    }

    // 4. Parse JSON — tolerate markdown code fences. A parse failure leaves
    // the turns in place (retried next night) — do NOT delete unconsumed data.
    let facts: Array<{
      factText: string;
      category: string;
      confidence?: number;
    }> = [];
    try {
      const cleaned = rawText
        .replace(/^```json\s*/i, "")
        .replace(/```\s*$/, "")
        .trim();
      facts = JSON.parse(cleaned) as typeof facts;
      if (!Array.isArray(facts)) facts = [];
    } catch {
      console.error(
        `[jme] consolidateAll: failed to parse Haiku response: ${rawText.slice(0, 200)}`,
      );
      return result;
    }

    result.factsExtracted = facts.length;

    // 5. Upsert each fact (cosine dedup inside upsertFact)
    for (const f of facts) {
      const category =
        (
          ["decision", "preference", "event", "emotion", "project"] as const
        ).find((c) => c === f.category) ?? "decision";

      try {
        const outcome = await upsertFact({
          sourceTask: "consolidator-nightly",
          factText: f.factText,
          category,
          confidence: typeof f.confidence === "number" ? f.confidence : 1.0,
        });
        if (outcome === "inserted") result.factsInserted++;
        else if (outcome === "skipped") result.factsSkipped++;
        else if (outcome === "superseded") result.factsSuperseded++;
      } catch (err) {
        console.error(
          `[jme] consolidateAll: upsertFact failed: ${errMsg(err)}`,
        );
      }
    }

    // 6. Delete EXACTLY the processed turns (an empty [] extraction is a
    // valid consumption — the window held nothing durable).
    const ids = turns.map((t) => t.id).join(",");
    writeWithRetry(() => {
      db.prepare(`DELETE FROM jme_turns WHERE id IN (${ids})`).run();
    });
  } catch (err) {
    console.error(`[jme] consolidateAll: unhandled error: ${errMsg(err)}`);
    // Observability invariant: emit schedule.run_failed so a dead consolidator
    // is never silent. Dynamic import keeps the scheduler's module graph out
    // of jme (prevents Prometheus double-registration in test suites).
    import("../rituals/scheduler.js")
      .then(({ recordRitualFailure }) =>
        recordRitualFailure("jme-consolidate", err, "execute"),
      )
      .catch(() => {
        /* best-effort */
      });
  }

  return result;
}

/**
 * Global 7-day sweep — prune orphaned turns that were never consolidated.
 * Covers tasks that ended without a clean task.completed event (crashes,
 * cancellations, wall-time kills). Safe to call at any time; it only removes
 * turns older than TURN_RETENTION_DAYS so active sessions are never touched.
 *
 * Returns the number of rows deleted.
 */
export const TURN_RETENTION_DAYS = 7;

export function pruneStaleTurns(): number {
  const db = getDatabase();
  let deleted = 0;
  writeWithRetry(() => {
    // ts is Date.now() MILLISECONDS — audit C1 (2026-07-14): the original
    // `unixepoch()` (seconds) comparison was ~1000x below every stored ts,
    // so the sweep never deleted anything. Threshold computed in JS ms.
    const result = db
      .prepare(`DELETE FROM jme_turns WHERE ts < ?`)
      .run(Date.now() - TURN_RETENTION_DAYS * 86_400_000) as {
      changes: number;
    };
    deleted = result.changes;
  });
  if (deleted > 0) {
    console.log(
      `[jme] pruneStaleTurns: removed ${deleted} stale turn(s) older than ${TURN_RETENTION_DAYS}d`,
    );
  }
  return deleted;
}
