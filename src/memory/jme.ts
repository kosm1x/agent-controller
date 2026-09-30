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
 *   - TTL per category (decisions: 90d, events: 30d, emotions: 14d,
 *     projects: 90d; a project/event carrying a count/version/week marker:
 *     30d; preferences: inferred ≤0.7 → 60d, stated/confirmed → permanent).
 *     Re-extracting a near-identical fact extends the stored row's expiry.
 *   - Fact extraction runs nightly (jme-consolidate, 02:45 MX), never in the
 *     turn critical path
 */

import { getDatabase, writeWithRetry } from "../db/index.js";

import {
  embed,
  cosineSimilarity,
  serializeEmbedding,
  deserializeEmbedding,
} from "./embeddings.js";
import { errMsg } from "../lib/err-msg.js";
import { logRecall, redactSecrets } from "./recall-utility.js";
import { infer } from "../inference/adapter.js";
import { HAIKU_MODEL_ID } from "../inference/claude-sdk.js";
import {
  detectPreferenceSignal,
  signalSnippet,
  SIGNAL_SNIPPET_MAX,
} from "./preference-signals.js";

// ── Phase 3 constants ────────────────────────────────────────────────────────

/**
 * Cosine similarity threshold above which two facts are considered to be
 * about the same topic. When grouping recall candidates, only the most-recent
 * fact per cluster survives. Keeps contradictory v1/v3 facts out of the same
 * context window. (Phase 3, Pieza 1)
 */
export const TEMPORAL_DEDUP_THRESHOLD = 0.85;

/**
 * Newest LIVE facts the vector scan in queryMemory() reads per recall (one
 * embedding is 6 KB, so 1,500 rows ≈ 9 MB and a few ms of cosine). Expired
 * rows never count against it. (Phase 4, 2026-09-18 — was a literal 500 with
 * 386 live rows and ~8.6 new facts/day.)
 */
export const VECTOR_SCAN_LIMIT = 1500;

/**
 * When LIVE jme_facts with embeddings exceed this count, the nightly
 * consolidator emits a warn log — 80 % of VECTOR_SCAN_LIMIT, so there is
 * runway before the oldest facts fall out of vector recall. (Phase 3, Pieza 2)
 */
export const VECTOR_CEILING_WARN = Math.floor(VECTOR_SCAN_LIMIT * 0.8);

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
  preference: null, // stated/confirmed: permanent (inferred: factTtlMs)
  event: 30 * 24 * 60 * 60 * 1000,
  emotion: 14 * 24 * 60 * 60 * 1000,
  project: 90 * 24 * 60 * 60 * 1000,
};

/** A project/event fact that carries a count, roster or week marker is a
 * snapshot ("9,607 tests", "W39", "Day 3", "semana 2", a lineup) — it goes
 * stale long before a 90 d project TTL (data review 2026-09-30). Versions and
 * "next milestone" wording are NOT markers: they matched durable facts
 * (qa R2 W5). */
export const TRANSIENT_FACT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const TRANSIENT_FACT_RE =
  /\bW\d{1,2}\b|\bDay \d+\b|\bsemana \d+\b|\b\d+ (?:tests|tools|tickers|teams|jugadores|rows|facts|files)\b|\b(?:rosters?|lineups?|waivers?)\b/i;

/** An INFERRED preference (confidence ≤ INFERRED_PREFERENCE_MAX_CONFIDENCE)
 * lives 60 d; re-extracting it (upsertFact skip ≥ 0.95) extends the expiry,
 * so only a preference that stops recurring fades. Stated (> 0.7) and
 * operator-confirmed (1.0) preferences stay permanent. */
export const INFERRED_PREFERENCE_TTL_MS = 60 * 24 * 60 * 60 * 1000;

/** TTL in ms for a fact, or null for permanent. */
export function factTtlMs(
  category: JmeFactCategory,
  factText: string,
  confidence: number,
): number | null {
  if (category === "preference") {
    return confidence <= INFERRED_PREFERENCE_MAX_CONFIDENCE
      ? INFERRED_PREFERENCE_TTL_MS
      : null;
  }
  if (
    (category === "project" || category === "event") &&
    TRANSIENT_FACT_RE.test(factText)
  ) {
    return TRANSIENT_FACT_TTL_MS;
  }
  return TTL_MS[category];
}

/** Track 2: a preference signal must FOLLOW a Jarvis reply this recent. */
export const SIGNAL_FOLLOWUP_WINDOW_MS = 30 * 60 * 1000;

// ── Episodic store ───────────────────────────────────────────────────────────

/**
 * Write a single turn to the episodic store.
 * Call during or at the end of a task to record the conversation.
 */
export function writeEpisodic(turn: JmeTurn): void {
  const db = getDatabase();
  const now = Date.now();
  writeWithRetry(() => {
    db.prepare(
      `INSERT INTO jme_turns (task_id, ts, role, content, channel)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(turn.taskId, now, turn.role, turn.content, turn.channel ?? "unknown");
  });

  // Track 2 (memory plan v2.0): a USER turn that corrects a reply's length,
  // format or depth is a preference signal. Turns are consumed nightly;
  // jme_signals is the durable record the gate reads.
  if (turn.role !== "user") return;
  const kind = detectPreferenceSignal(turn.content);
  if (!kind) return;
  // Best-effort: the router writes the user turn and the Jarvis turn back to
  // back in one promise chain — a signal-write failure must never cost the
  // second turn (qa-audit R1 W1).
  try {
    // A correction FOLLOWS a reply. "Dame una lista de…" as the opening line
    // of a fresh task is an instruction, not a correction — the vocabulary
    // alone cannot tell them apart (corpus replay 2026-08-28: most hits were
    // task openers), so a signal also requires a Jarvis turn within the
    // follow-up window. The operator is the only writer to jme_turns.
    const recentReply = db
      .prepare(
        `SELECT 1 FROM jme_turns WHERE role = 'jarvis' AND ts >= ? LIMIT 1`,
      )
      .get(now - SIGNAL_FOLLOWUP_WINDOW_MS);
    if (!recentReply) return;
    writeWithRetry(() => {
      db.prepare(
        `INSERT INTO jme_signals (task_id, ts, kind, snippet) VALUES (?, ?, ?, ?)`,
      ).run(turn.taskId, now, kind, signalSnippet(turn.content));
    });
  } catch (err) {
    console.warn(`[jme] preference signal write failed: ${errMsg(err)}`);
  }
}

/**
 * Track 2 (memory plan v2.0): order recalled facts for prompt injection —
 * preferences first, everything else in its recall order. The point is
 * prompt primacy: the how-to-answer rules lead the `[JME MEMORY]` block.
 * (The fast-runner's 1,500-token cut cannot fire at k=8 with today's fact
 * sizes — max 302 chars, the 8 longest sum to ~2.4k — so ordering is not a
 * truncation defense; qa-audit R1 W2.) Ranking (queryMemory) and k are
 * untouched; this only reorders the recalled set.
 */
export function orderForInjection<T extends { category: JmeFactCategory }>(
  facts: readonly T[],
): T[] {
  return [
    ...facts.filter((f) => f.category === "preference"),
    ...facts.filter((f) => f.category !== "preference"),
  ];
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
  const ttl = factTtlMs(fact.category, fact.factText, fact.confidence ?? 1.0);
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
 *   ^, -, etc.), keeping only Unicode letters and numbers.
 * - Drops the reserved operator words defensively and tokens ≤2 chars.
 */
function extractKeywords(query: string): string[] {
  const FTS5_OPERATORS = new Set(["and", "or", "not", "near"]);
  return (
    query
      .toLowerCase()
      // Unicode classes, not an enumerated accent set — the enumeration mangled
      // any diacritic outside it (ç, ã, ê…) the same way the critic's ASCII
      // tokenizer mangled "ángeles" (2026-08-14 sweep; sqlite-backend.ts already
      // uses \p{L}\p{N}).
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 2 && !FTS5_OPERATORS.has(w))
  );
}

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
 * @param results        Already-ranked recall results (best first)
 * @param factEmbeddings Fact embeddings stashed by the vector search, keyed by
 *                       fact id; a result without one is kept as-is (the
 *                       FTS5-only path passes an empty map, so nothing clusters).
 * @param limit          Stop once this many clusters are kept. An anchor only
 *                       absorbs LATER results, so the first `limit` kept are
 *                       the same as deduping everything then slicing — at
 *                       k × n cosines instead of n² over the full candidate set.
 * @returns Filtered results with at most one representative per cluster,
 *          preserving the original ranking order among survivors.
 */
export function deduplicateFacts(
  results: JmeRecallResult[],
  factEmbeddings: Map<number, Float32Array>,
  limit = Infinity,
): JmeRecallResult[] {
  if (results.length <= 1) return results;

  const kept: JmeRecallResult[] = [];
  // Indices already claimed by an earlier anchor's cluster.
  const absorbed = new Set<number>();

  for (let i = 0; i < results.length && kept.length < limit; i++) {
    if (absorbed.has(i)) continue;

    const anchor = results[i];
    const anchorVec = factEmbeddings.get(anchor.id);

    // If we have no embedding for the anchor, keep it unconditionally —
    // we can't meaningfully cluster it.
    if (!anchorVec) {
      kept.push(anchor);
      continue;
    }

    // Absorb the FULL cluster around this anchor first, then keep only its
    // most-recent member (at the anchor's rank position). Breaking out on
    // the first newer candidate — the original shape — left the rest of the
    // cluster un-absorbed, so a v1/v2/v3 trio surfaced BOTH v2 and v3
    // (repro: identical embeddings, ts 100/200/300 → [v2, v3]).
    let newest = anchor;
    for (let j = i + 1; j < results.length; j++) {
      if (absorbed.has(j)) continue;
      const candidate = results[j];
      const candidateVec = factEmbeddings.get(candidate.id);
      if (!candidateVec) continue;

      const sim = cosineSimilarity(anchorVec, candidateVec);
      if (sim >= TEMPORAL_DEDUP_THRESHOLD) {
        absorbed.add(j);
        if (candidate.ts > newest.ts) newest = candidate;
      }
    }

    kept.push(newest);
  }

  return kept;
}

/** Leading date header the router prepends to operator messages. */
const RECALL_DATE_HEADER_RE = /^\[Hoy:[^\]]*\]\s*/;

/** Acknowledgement / go-ahead words that never make a message recall-worthy. */
const RECALL_FILLER_WORDS = new Set([
  "listo", "continúa", "continua", "verifica", "reitera", "ok", "dale",
  "hazlo", "procede", "gracias", "sí", "si", "no", "va", "vale",
]);

/**
 * The text to recall on for an operator message: the `[Hoy: …]` header is
 * stripped (it made "Listo" recall 8 facts — audit W1). Tokens are
 * letters/digits ≥ 3 chars, filler words excluded; the message recalls when
 * it has ≥ 2 tokens OR one non-stopword token ≥ 4 chars (a single entity:
 * "¿y Trustr?" — qa R2 W7). Otherwise null — the caller skips recall
 * entirely (no embed, no block, no audit row).
 */
export function jmeRecallQuery(text: string): string | null {
  const stripped = text.replace(RECALL_DATE_HEADER_RE, "");
  const tokens = (stripped.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(
    (t) => !RECALL_FILLER_WORDS.has(t),
  );
  const hasEntity = tokens.some(
    (t) => t.length >= 4 && !RECALL_STOPWORDS.has(t),
  );
  return tokens.length >= 2 || hasEntity ? stripped : null;
}

/** Rows below this confidence never reach recall (either leg). */
export const RECALL_MIN_CONFIDENCE = 0.4;
/** On the hybrid path a row's keyword score counts only when its vector
 * score reaches this — the set-relative BM25 top is always 1.0, so a
 * stopword-only query surfaced facts on keywords alone (audit W2). */
export const KEYWORD_GATE_MIN_VECTOR_SCORE = 0.45;
/** Results scoring more than this below the top result are dropped. */
export const RECALL_RELATIVE_CUTOFF = 0.2;
/** Temporal dedup runs over at most this many × k in-band candidates. */
export const RECALL_DEDUP_POOL = 3;

/** Function words that never make an FTS-only recall on their own. */
const RECALL_STOPWORDS = new Set([
  "que", "los", "las", "del", "por", "con", "para", "una", "uno", "unos",
  "unas", "como", "pero", "más", "mas", "este", "esta", "esto", "eso", "esa",
  "ese", "son", "hay", "fue", "ser", "sus", "les", "muy", "todo", "toda",
  "qué", "cómo", "cuál", "dónde", "cuando", "cuándo", "sobre", "entre",
  "the", "and", "for", "are", "was", "you", "your", "this", "that", "with",
  "from", "have", "has", "not", "but", "what", "how", "who", "can", "its",
  "about", "there", "their", "they", "them", "then", "than", "into",
]);

/**
 * Query the semantic store — hybrid BM25 + vector search.
 *
 * 1. Embed the query (leading `[Hoy: …]` header stripped)
 * 2. Live facts with embeddings and confidence ≥ RECALL_MIN_CONFIDENCE →
 *    cosine × confidence
 * 3. FTS5 keyword match → BM25 × confidence; on the hybrid path it only
 *    counts for rows whose vector score ≥ KEYWORD_GATE_MIN_VECTOR_SCORE
 * 4. Fuse (0.7 vector + 0.3 keyword), relative cutoff, temporal dedup, top-K
 *
 * Falls back to FTS5-only if embedding fails (needs ≥ 1 non-stopword token).
 */
export async function queryMemory(
  query: string,
  options: {
    k?: number;
    minScore?: number;
    /** Caller-supplied embedding of `query` — skips the embed() call. */
    queryVec?: Float32Array | null;
  } = {},
): Promise<JmeRecallResult[]> {
  const { k = 8, minScore = 0.25 } = options;
  query = query.replace(RECALL_DATE_HEADER_RE, "");
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

  // A caller that already embedded the text (upsertFact) passes it in — the
  // nightly consolidator used to pay Gemini twice per fact (P3 follow-up).
  let queryVec: Float32Array | null = options.queryVec ?? null;
  if (!queryVec) {
    try {
      queryVec = await embed(query);
    } catch {
      // ignore — will use FTS5 only
    }
  }

  if (queryVec) {
    const rows = db
      .prepare(
        `SELECT id, fact_text, category, source_task, ts, embedding, confidence
         FROM jme_facts
         WHERE embedding IS NOT NULL
           AND (expires_at IS NULL OR expires_at > ?)
           AND confidence >= ?
         ORDER BY ts DESC
         LIMIT ?`,
      )
      .all(now, RECALL_MIN_CONFIDENCE, VECTOR_SCAN_LIMIT) as DbFactRow[];

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
    // FTS-only path: a query of function words alone is not a recall.
    const hasContentToken = keywords.some((w) => !RECALL_STOPWORDS.has(w));

    if (ftsQuery && (queryVec || hasContentToken)) {
      const keywordRows = db
        .prepare(
          `SELECT f.id, f.confidence, bm25(jme_facts_fts) AS bm25_score
           FROM jme_facts_fts
           JOIN jme_facts f ON f.id = jme_facts_fts.rowid
           WHERE jme_facts_fts MATCH ?
             AND (f.expires_at IS NULL OR f.expires_at > ?)
             AND f.confidence >= ?
           ORDER BY bm25(jme_facts_fts)
           LIMIT 100`,
        )
        .all(ftsQuery, now, RECALL_MIN_CONFIDENCE) as Array<{
        id: number;
        confidence: number;
        bm25_score: number;
      }>;

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
        keywordScores.set(row.id, normalized * row.confidence);
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
        // Per-result id:score, so a later calibration of minScore / the
        // cutoff has data (result_snippets carries text only).
        topKIds: results.map((r) => `${r.id}:${r.score.toFixed(3)}`),
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
      const fusedScore = queryVec
        ? vScore * 0.7 +
          (vScore >= KEYWORD_GATE_MIN_VECTOR_SCORE ? kScore : 0) * 0.3
        : kScore;

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
    .sort((a, b) => b.score - a.score);

  // Relative cutoff: a result far below the best one is noise, not context.
  // Applied BEFORE dedup, and dedup sees only the top RECALL_DEDUP_POOL × k
  // survivors — deduping the whole fused set tripled recall latency (qa R2 W2).
  const top = fused[0]?.score ?? 0;
  const pool = fused
    .filter((r) => r.score >= top - RECALL_RELATIVE_CUTOFF)
    .slice(0, RECALL_DEDUP_POOL * k);

  // ── 5.5 Temporal dedup (Phase 3 Pieza 1) ──────────────────────────────────
  // Group semantically similar facts and keep only the most-recent per cluster.
  // Prevents contradictory v1/v3 versions of the same fact from appearing in
  // the same context window. Only runs when we have embeddings to compare.
  // Runs BEFORE the top-K cut, so k slots hold k distinct clusters.
  const results =
    factEmbeddings.size > 0
      ? deduplicateFacts(pool, factEmbeddings, k)
      : pool.slice(0, k);

  // Telemetry: record this recall in the shared audit table with source:'jme'
  // so JME retrievals are observable alongside the hindsight/sqlite paths.
  return logAndReturn(results);
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * Prune expired facts and low-confidence facts older than 30 days. Runs
 * nightly from the jme-consolidate cron (Phase 4, wired 2026-09-18 once the
 * population was real: 112 expired rows). A row the operator REJECTED
 * (`mc-ctl jme-preferences --reject` = category `preference` + confidence 0 +
 * expired) is kept: it is the marker the Rejected list and the re-inference
 * stop rule read. The marker is preference-scoped on purpose — `upsertFact`
 * clamps the extractor's confidence to [0, 1], so a non-preference row at 0
 * is an extractor artefact and is pruned like any other (qa R1 W2).
 */
export function pruneExpiredFacts(): number {
  const db = getDatabase();
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

  const result = db
    .prepare(
      `DELETE FROM jme_facts
       WHERE NOT (confidence = 0 AND category = 'preference')
         AND ((expires_at IS NOT NULL AND expires_at < ?)
           OR (confidence < 0.4 AND ts < ?))`,
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
  // LIVE rows only — the vector scan filters expired rows, so they never
  // count against VECTOR_SCAN_LIMIT (112 expired rows inflated this to 498
  // against 386 live on 2026-09-18).
  const factsWithEmbedding = (
    db
      .prepare(
        `SELECT COUNT(*) as n FROM jme_facts
         WHERE embedding IS NOT NULL
           AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .get(now) as { n: number }
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

/** jme_signals.task_id that marks a POSSIBLE CORRECTION of an operator-
 * confirmed preference (B3): a re-extracted preference 0.85–0.95 similar to a
 * confirmed one. The row reuses kind 'explicit' (the migration-v5 CHECK has
 * no other slot); `mc-ctl jme-preferences` lists these apart and keeps them
 * out of the correction-signal rate. */
export const POSSIBLE_CORRECTION_TASK_ID = "jme-possible-correction";

// ── Redaction (JME-specific pass over redactSecrets) ────────────────────────

/** Placeholder a JME redaction leaves behind (plus redactSecrets' labels). */
const JME_PLACEHOLDER_RE =
  /\[(?:email|tax-id|uuid|token|digits|secret|card|REDACTED-[A-Z-]+)\]/g;

/** A fact whose text is more than this share placeholders is dropped. */
export const REDACTED_FACT_MAX_PLACEHOLDER_SHARE = 0.4;

/** A digit run ≥ 8 is redacted only after one of these words (within
 * JME_DIGITS_KEYWORD_WINDOW chars) — bare counts, phones and dates are the
 * operator's own facts (qa R2 W3). */
const JME_DIGITS_KEYWORD_RE =
  /(?<!\p{L})(?:id|cuenta|account|token|key|swid|cookie|clave|password|contraseña|pin|clabe|tarjeta|card)s?(?!\p{L})/iu;
const JME_DIGITS_KEYWORD_WINDOW = 40;

/**
 * redactSecrets + the shapes a personal-memory store must not keep: labelled
 * passwords, e-mail addresses (except the operator's own, listed in env
 * `JME_REDACT_ALLOW_EMAILS`, comma-separated, read per call), Mexican
 * CURP/RFC, UUIDs (brace-wrapped too — the ESPN SWID in live #390), card
 * numbers, long opaque tokens and keyword-labelled digit runs. The token rule
 * needs a digit AND a letter in the run (or ≥ 32 letters alone): on the 455
 * live facts (2026-09-30) that separated the one real id (a Drive file id)
 * from 10 legit paths, tool and repo names (`/root/claude/promo-video-agent`,
 * `agent_create/update/…`). JME-only: redactSecrets' other callers keep their
 * semantics.
 */
export function redactForJme(text: string): string {
  const allowedEmails = new Set(
    (process.env.JME_REDACT_ALLOW_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
  return redactSecrets(text)
    .replace(
      /(\b(?:password|contraseña|clave|pwd|pass(?:word)?)(?:\s*[:=]|\s+(?:es|is)\b)\s*)\S+/gi,
      "$1[secret]",
    )
    .replace(
      /\{?\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b\}?/gi,
      "[uuid]",
    )
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (email) =>
      allowedEmails.has(email.toLowerCase()) ? email : "[email]",
    )
    .replace(/\b[A-Z][AEIOUX][A-Z]{2}\d{6}[HM][A-Z]{5}[A-Z0-9]\d\b/g, "[tax-id]")
    .replace(/(?<![\p{L}\p{N}])[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}\b/gu, "[tax-id]")
    .replace(/\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/g, "[card]")
    .replace(/[A-Za-z0-9+/_=%-]{24,}/g, (run) =>
      (/\d/.test(run) && /[A-Za-z]/.test(run)) ||
      (run.length >= 32 && /^[A-Za-z]+$/.test(run))
        ? "[token]"
        : run,
    )
    .replace(/\d{8,}/g, (run, offset: number, whole: string) =>
      JME_DIGITS_KEYWORD_RE.test(
        whole.slice(Math.max(0, offset - JME_DIGITS_KEYWORD_WINDOW), offset),
      )
        ? "[digits]"
        : run,
    );
}

/** True when redaction left the text mostly placeholders (nothing to keep). */
function isMostlyPlaceholders(text: string): boolean {
  const placeholderChars = (text.match(JME_PLACEHOLDER_RE) ?? []).reduce(
    (n, p) => n + p.length,
    0,
  );
  return placeholderChars > text.length * REDACTED_FACT_MAX_PLACEHOLDER_SHARE;
}

/**
 * Upsert a fact with dedup. Decision metric: TRUE cosine similarity between
 * the incoming fact's embedding and the STORED embedding of EVERY live
 * embedded fact in the same category — an exact scan, no LIMIT, no temporal
 * dedup, no confidence weighting (audit C3, 2026-09-30: the old queryMemory
 * k=3 candidate lookup ran temporal dedup first, which kept the NEWEST of a
 * cluster and hid the true twin — 6/32 emulated decisions wrong; ~4 ms at
 * 457 rows). Never writes a recall_audit row.
 *
 *   - best ≥ SKIP_THRESHOLD  (0.95) → skip; the matched row's expiry is
 *     extended by its TTL (re-confirmation keeps a recurring fact alive)
 *   - best ≥ DEDUP_THRESHOLD (0.85) → supersede: insert the new fact, then
 *     expire EVERY live row ≥ 0.85 in the category (the whole cluster)
 *   - otherwise                     → plain insert
 *
 * An operator-CONFIRMED preference in the ≥ 0.85 cluster is never superseded:
 * the incoming fact is skipped and, below 0.95, a POSSIBLE_CORRECTION signal
 * row is written for the operator to review.
 *
 * The text is redacted (redactForJme) first; if it is then mostly
 * placeholders the fact is "dropped". If the incoming fact cannot be embedded
 * (Gemini outage/timeout), dedup is impossible and the fact is
 * PLAIN-INSERTED — a temporary duplicate beats a silently dropped fact.
 */
export async function upsertFact(
  fact: JmeFact,
): Promise<"skipped" | "superseded" | "inserted" | "dropped"> {
  const db = getDatabase();
  const now = Date.now();

  // Validate: reject empty text, truncate oversized, clamp confidence (W3 —
  // queryMemory ranks by sim*confidence and the stale-prune keys on <0.4, so
  // an out-of-range Haiku value skews both).
  const trimmedText = redactForJme(fact.factText.trim().slice(0, 2000));
  if (!trimmedText) return "skipped";
  if (isMostlyPlaceholders(trimmedText)) return "dropped";
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

  const rows = db
    .prepare(
      `SELECT id, fact_text, source_task, embedding, confidence, expires_at FROM jme_facts
       WHERE category = ? AND embedding IS NOT NULL
         AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .all(fact.category, now) as Array<{
    id: number;
    fact_text: string;
    source_task: string;
    embedding: Buffer;
    confidence: number;
    expires_at: number | null;
  }>;

  let best: { id: number; sim: number; row: (typeof rows)[number] } | null =
    null;
  const cluster: Array<{
    id: number;
    sim: number;
    confirmed: boolean;
    confidence: number;
    permanent: boolean;
  }> = [];
  for (const row of rows) {
    let sim: number;
    try {
      sim = cosineSimilarity(incomingVec, deserializeEmbedding(row.embedding));
    } catch {
      continue; // malformed stored embedding — not a dedup candidate
    }
    if (!best || sim > best.sim) best = { id: row.id, sim, row };
    if (sim >= CONSOLIDATOR_DEDUP_THRESHOLD) {
      cluster.push({
        id: row.id,
        sim,
        confirmed: fact.category === "preference" && row.confidence >= 1.0,
        confidence: row.confidence,
        permanent: row.expires_at === null,
      });
    }
  }

  if (best && best.sim >= CONSOLIDATOR_SKIP_THRESHOLD) {
    // Re-confirmation: the fact recurred, so the stored row lives on (same
    // id). It takes the incoming wording — "W39 … 387" → "W40 … 366" must not
    // keep the stale text (qa R2 W6) — ONLY when the incoming confidence is
    // at least the stored one: a weaker (inferred / echoed) re-extraction
    // must not rewrite a stated or operator-confirmed row's text (qa R3 C1).
    // Confidence never drops and rises to at most
    // MODEL_PREFERENCE_MAX_CONFIDENCE; expiry only ever extends and a
    // permanent row (NULL) stays permanent.
    const stored = best.row;
    const refreshWording =
      (clamped.confidence ?? 1) >= stored.confidence &&
      trimmedText !== stored.fact_text;
    const factText = refreshWording ? trimmedText : stored.fact_text;
    const confidence = Math.max(
      stored.confidence,
      Math.min(MODEL_PREFERENCE_MAX_CONFIDENCE, clamped.confidence ?? 1),
    );
    const ttl = factTtlMs(fact.category, factText, confidence);
    const expiresAt =
      stored.expires_at === null || ttl === null
        ? null
        : Math.max(stored.expires_at, now + ttl);
    if (
      refreshWording ||
      confidence !== stored.confidence ||
      expiresAt !== stored.expires_at
    ) {
      const bestId = best.id;
      writeWithRetry(() => {
        db.prepare(
          `UPDATE jme_facts
           SET fact_text = ?, embedding = ?, source_task = ?, confidence = ?, expires_at = ?
           WHERE id = ?`,
        ).run(
          factText,
          refreshWording ? serializeEmbedding(incomingVec) : stored.embedding,
          refreshWording ? fact.sourceTask : stored.source_task,
          confidence,
          expiresAt,
          bestId,
        );
      });
    }
    return "skipped";
  }

  // Track 2: an operator-CONFIRMED preference (confidence 1.0 via
  // `mc-ctl jme-preferences --confirm`) is never superseded by a re-inferred
  // twin — the confirmation would silently revert to "inferred" on the next
  // nightly run (qa-audit R2 W-g). Its wording is the operator's call, so the
  // near-twin is surfaced as a possible correction instead of dropped (W4).
  // Same for an INFERRED incoming preference against a STATED member: an
  // inference must not replace what Fede said (qa R3 C1).
  const incomingInferred =
    fact.category === "preference" &&
    (clamped.confidence ?? 1) <= INFERRED_PREFERENCE_MAX_CONFIDENCE;
  const confirmed =
    cluster.find((c) => c.confirmed) ??
    (incomingInferred
      ? cluster
          .filter((c) => c.confidence > INFERRED_PREFERENCE_MAX_CONFIDENCE)
          .sort((a, b) => b.sim - a.sim)[0]
      : undefined);
  if (confirmed) {
    try {
      writeWithRetry(() => {
        db.prepare(
          `INSERT INTO jme_signals (task_id, ts, kind, snippet) VALUES (?, ?, 'explicit', ?)`,
        ).run(
          POSSIBLE_CORRECTION_TASK_ID,
          now,
          `#${confirmed.id} cos=${confirmed.sim.toFixed(3)} new: ${trimmedText}`.slice(
            0,
            SIGNAL_SNIPPET_MAX,
          ),
        );
      });
    } catch (err) {
      console.warn(`[jme] possible-correction signal write failed: ${errMsg(err)}`);
    }
    return "skipped";
  }

  if (cluster.length > 0) {
    // Near-duplicate — supersede. Insert the NEW fact first, THEN expire the
    // old cluster: a crash in between leaves a temporary duplicate (absorbed
    // by the next run's skip) instead of losing the fact outright. The new
    // row inherits the cluster's strongest class — an inferred 0.89
    // re-extraction must not demote a stated 0.99 permanent preference to a
    // 60 d guess (qa R2 C1): confidence = the max (≤ 0.99), permanent if any
    // member was.
    await writeFact({
      ...clamped,
      confidence: Math.min(
        MODEL_PREFERENCE_MAX_CONFIDENCE,
        Math.max(clamped.confidence ?? 1, ...cluster.map((c) => c.confidence)),
      ),
      expiresAt: cluster.some((c) => c.permanent) ? null : undefined,
    });
    const ids = cluster.map((c) => c.id);
    writeWithRetry(() => {
      db.prepare(
        `UPDATE jme_facts SET expires_at = ? WHERE id IN (${ids.map(() => "?").join(",")})`,
      ).run(now, ...ids);
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
/** Identity-inversion guard (2026-08-31). The nightly extractor once turned
 * Jarvis's OWN Track 1 report of `preferences.jarvis_name` ("Con Fede, Jarvis se
 * llama Piotr") into jme_facts#307 "Fede prefers to be called Piotr by Jarvis" —
 * the prompt's anti-echo rule was ignored. A prompt rule is not a guard: a fact
 * that names FEDE as the one called Piotr is refused before upsertFact. Replayed
 * over all 327 live facts: hits #307 only; "Fede calls Jarvis Piotr", "Fede wants
 * Jarvis to sign as Piotr" and "Piotr Wozniak" pass. */
export const IDENTITY_INVERSION_RE =
  /\bFede(?:rico)?(?:'s)?\b[^.;]{0,40}?\b(?:(?:prefers|wants|likes|asks|asked|prefiere|quiere|pide)\s+to\s+be\s+(?:called|addressed\s+as|named)|is\s+(?:called|known\s+as|named|addressed\s+as)|se\s+llama|se\s+hace\s+llamar|goes\s+by|(?:also\s+)?known\s+as|conocido\s+como|(?:name|nickname|alias|apodo|nombre)\s+(?:is|es))\b[^.;]{0,20}?\bPiotr\b/i;

export function isIdentityInversion(factText: string): boolean {
  return IDENTITY_INVERSION_RE.test(factText);
}

/** Extractor directive; `today` (YYYY-MM-DD) anchors relative dates. */
function buildExtractPrompt(today: string): string {
  return `You are a fact extractor for a personal assistant memory system.
Given a conversation, extract a compact list of durable facts about the user.
Today's date is ${today}.

Rules:
- Each fact must be a self-contained, standalone statement (no pronouns like "he/she").
- Write every fact in English, as ONE sentence of at most 300 characters.
- Subject: Fede himself, his projects, or his relationships. NEVER world statistics, facts about public figures, or changes to Jarvis / agent-controller code (those live in git and the KB).
- Only extract facts that would still be useful weeks from now.
- Skip greetings, filler, one-off operational details, and temporary states.
- Extract ONLY from what Fede (the user) states. NEVER extract from Jarvis's replies: Jarvis often restates facts it already remembers, and re-extracting those would create duplicates. Jarvis turns are context for understanding Fede, not a fact source. Every fact must be grounded in a "Fede:" line; if only a "Jarvis:" line says it, it is not a fact.
- Convert relative dates ("hoy", "mañana", "esta semana", "today", "tomorrow", "this week") to absolute dates using today's date above.
- A single-task instruction ("haz una lista de…", "resume esto") is NOT a preference. A preference needs a scope clause saying when it applies ("for strategic documents, Fede prefers …"). Interests and profile facts go to "project" or "event", not "preference".
- Names: the user is Fede (Federico). Fede addresses the assistant as "Piotr" — in Fede's messages "Piotr" ALWAYS refers to Jarvis, never to Fede, unless Fede is clearly naming a different, third person. Never record what Fede calls Jarvis as Fede's own name, his nickname, or a preference about HIM.
- Categories: "decision" | "preference" | "event" | "emotion" | "project"
- Confidence: 0.0–1.0 (how confident you are this is a lasting fact). "confidence" is REQUIRED on every element.
- Every "preference" fact carries "inferred": true or false. Inferred = you derived it from Fede correcting the FORMAT, LENGTH or DEPTH of a Jarvis reply ("muy largo", "dame la tabla", "profundiza", a follow-up that reframes the answer); phrase it as how he wants replies ("Fede prefers ...") with confidence at most 0.7. Stated = Fede said it himself; keep the normal confidence. A preference without the field is treated as inferred.

Respond with ONLY a JSON array, no explanation:
[{"factText": "...", "category": "...", "confidence": 0.9}, {"factText": "...", "category": "preference", "confidence": 0.9, "inferred": false}, {"factText": "...", "category": "preference", "confidence": 0.6, "inferred": true}, ...]

If no durable facts are present, respond with: []`;
}

/** Jarvis turns are cut to this in the transcript: they are context only (the
 * prompt forbids extracting from them) yet were 93 % of the transcript bytes. */
export const CONSOLIDATOR_JARVIS_TURN_MAX_CHARS = 500;

/**
 * One transcript line per turn: redacted (redactForJme), newlines escaped so
 * a turn can never forge a standalone "Fede:" line (audit C2 — a Jarvis web
 * summary containing "\nFede: …" did), Jarvis turns truncated. Redaction runs
 * before the cut so a secret is never left half-visible.
 */
function transcriptLine(role: JmeTurnRole, content: string): string {
  let text = redactForJme(content).replace(/\r\n|\r|\n/g, " ⏎ ");
  if (role === "jarvis" && text.length > CONSOLIDATOR_JARVIS_TURN_MAX_CHARS) {
    text = `${text.slice(0, CONSOLIDATOR_JARVIS_TURN_MAX_CHARS)}…`;
  }
  return `${role === "user" ? "Fede" : "Jarvis"}: ${text}`;
}

/** Emit schedule.run_failed for the nightly consolidator. Dynamic import
 * keeps the scheduler's module graph out of jme (prevents Prometheus
 * double-registration in test suites). The event's phase enum has no
 * "extract" slot, so the stage rides in the message. */
const JME_FACT_CATEGORIES: readonly JmeFactCategory[] = [
  "decision",
  "preference",
  "event",
  "emotion",
  "project",
];

/** Confidence given to an extracted fact whose `confidence` key is MISSING
 * (the inferred class — never "stated" by omission, qa R3 W3). */
export const EXTRACTED_FACT_DEFAULT_CONFIDENCE = 0.7;

/** Shape check for one element of the extractor's JSON array: null when
 * malformed (no factText, unknown category, non-numeric confidence). */
function parseExtractedFact(f: unknown): {
  factText: string;
  category: JmeFactCategory;
  confidence: number;
  inferred?: unknown;
} | null {
  if (typeof f !== "object" || f === null) return null;
  const o = f as Record<string, unknown>;
  const confidence =
    o.confidence === undefined
      ? EXTRACTED_FACT_DEFAULT_CONFIDENCE
      : o.confidence;
  if (
    typeof o.factText !== "string" ||
    o.factText.trim() === "" ||
    !JME_FACT_CATEGORIES.includes(o.category as JmeFactCategory) ||
    typeof confidence !== "number" ||
    !Number.isFinite(confidence)
  ) {
    return null;
  }
  return {
    factText: o.factText,
    category: o.category as JmeFactCategory,
    confidence,
    inferred: o.inferred,
  };
}

function reportConsolidateFailure(stage: string, err: unknown): void {
  import("../rituals/scheduler.js")
    .then(({ recordRitualFailure }) =>
      recordRitualFailure(
        "jme-consolidate",
        new Error(`${stage}: ${errMsg(err)}`),
        "execute",
      ),
    )
    .catch(() => {
      /* best-effort */
    });
}

/** Turns younger than this are left for the NEXT nightly run — never eat a
 * conversation that may still be in flight. */
export const CONSOLIDATOR_MIN_TURN_AGE_MS = 30 * 60 * 1000;
/** Per-run turn cap: bounds the Haiku context; the leftover is picked up the
 * following night (and pruneStaleTurns bounds the worst case at 7d). */
export const CONSOLIDATOR_MAX_TURNS = 400;

/** Track 2: ceiling for a preference the extractor INFERRED from a correction
 * (vs one Fede stated). Enforced in consolidateAll, not only in the prompt. */
export const INFERRED_PREFERENCE_MAX_CONFIDENCE = 0.7;
/** Track 2: ceiling for ANY model-authored preference. 1.0 is reserved for the
 * operator's confirmation (`mc-ctl jme-preferences --confirm`). */
export const MODEL_PREFERENCE_MAX_CONFIDENCE = 0.99;

export interface ConsolidateResult {
  turnsProcessed: number;
  factsExtracted: number;
  factsInserted: number;
  factsSkipped: number;
  factsSuperseded: number;
  /** Facts refused because redaction left them mostly placeholders. */
  factsDropped: number;
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
    factsDropped: 0,
  };

  try {
    const db = getDatabase();

    // 1. Load the settled window (oldest first, capped)
    const turns = db
      .prepare(
        `SELECT id, role, content FROM jme_turns
         WHERE ts < ?
         ORDER BY ts ASC, id ASC
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
    // When LIVE jme_facts with embeddings approach VECTOR_SCAN_LIMIT in
    // queryMemory(), recall quality degrades (oldest facts get cut off). Warn
    // at 80 % so there is runway; expired rows are pruned nightly (Phase 4).
    const embeddingCount = jmeStats().factsWithEmbedding;
    if (embeddingCount >= VECTOR_CEILING_WARN) {
      console.warn(
        `[jme] consolidateAll: vector ceiling warning — ${embeddingCount} live facts with embeddings (warn threshold=${VECTOR_CEILING_WARN}, scan limit=${VECTOR_SCAN_LIMIT}). Raise VECTOR_SCAN_LIMIT or tighten category TTLs.`,
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
      .map((t) => transcriptLine(t.role, t.content))
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
        {
          role: "system",
          content: buildExtractPrompt(new Date().toISOString().slice(0, 10)),
        },
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
      reportConsolidateFailure("extract", "empty Haiku response");
      return result;
    }

    // 4. Parse JSON — tolerate markdown code fences. A parse failure leaves
    // the turns in place (retried next night) — do NOT delete unconsumed data.
    let facts: unknown[] = [];
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
      reportConsolidateFailure("extract", "unparseable Haiku response");
      return result;
    }

    result.factsExtracted = facts.length;

    // 5. Upsert each fact (cosine dedup inside upsertFact)
    let upsertError: unknown = null;
    for (const raw of facts) {
      // A malformed element (qa R2 W1: missing factText threw inside
      // redactForJme and kept the whole window) is dropped and logged — the
      // rest of the reply is still good.
      const f = parseExtractedFact(raw);
      if (!f) {
        console.warn(
          `[jme] consolidateAll: malformed extracted fact dropped: ${redactForJme(String(JSON.stringify(raw))).slice(0, 200)}`,
        );
        result.factsDropped++;
        continue;
      }
      const category = f.category;

      if (isIdentityInversion(f.factText)) {
        console.warn(
          `[jme] consolidateAll: identity-inversion guard dropped "${redactForJme(f.factText).slice(0, 120)}"`,
        );
        result.factsSkipped++;
        continue;
      }

      try {
        // Track 2: an INFERRED preference is capped at 0.7 here, not just in
        // the prompt — a Haiku reply that omits confidence would otherwise
        // default to 1.0 and read as "stated" (qa-audit R1 W3). Fail-safe
        // direction: a preference WITHOUT an explicit `inferred: false` is
        // treated as inferred — a forgotten flag must never promote a guess
        // to "stated" (qa-audit R2 W-f).
        const rawConfidence = f.confidence;
        const inferred = category === "preference" && f.inferred !== false;
        // confidence 1.0 on a preference is the OPERATOR's mark (`mc-ctl
        // jme-preferences --confirm`), which upsertFact never supersedes — a
        // model-authored stated preference tops out at 0.99 so the model
        // cannot mint operator consent (qa-audit R3 W2).
        const confidence = inferred
          ? Math.min(INFERRED_PREFERENCE_MAX_CONFIDENCE, rawConfidence)
          : category === "preference"
            ? Math.min(MODEL_PREFERENCE_MAX_CONFIDENCE, rawConfidence)
            : rawConfidence;
        const outcome = await upsertFact({
          sourceTask: "consolidator-nightly",
          factText: f.factText,
          category,
          confidence,
        });
        if (outcome === "inserted") result.factsInserted++;
        else if (outcome === "skipped") result.factsSkipped++;
        else if (outcome === "superseded") result.factsSuperseded++;
        else if (outcome === "dropped") result.factsDropped++;
      } catch (err) {
        console.error(
          `[jme] consolidateAll: upsertFact failed: ${errMsg(err)}`,
        );
        upsertError ??= err;
      }
    }

    // A failed upsert means a fact from this window may be lost: keep the
    // turns so the next night re-extracts them (the ≥ 0.95 skip absorbs the
    // facts that did land).
    if (upsertError !== null) {
      reportConsolidateFailure("upsert", upsertError);
      return result;
    }

    // 6. Delete EXACTLY the processed turns (an empty [] extraction is a
    // valid consumption — the window held nothing durable).
    const ids = turns.map((t) => t.id);
    const placeholders = ids.map(() => "?").join(",");
    writeWithRetry(() => {
      db.prepare(`DELETE FROM jme_turns WHERE id IN (${placeholders})`).run(...ids);
    });
  } catch (err) {
    console.error(`[jme] consolidateAll: unhandled error: ${errMsg(err)}`);
    // Observability invariant: emit schedule.run_failed so a dead consolidator
    // is never silent.
    reportConsolidateFailure("execute", err);
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
