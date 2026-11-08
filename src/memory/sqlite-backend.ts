/**
 * SQLite memory backend — conversations table + learnings table.
 *
 * Maps the MemoryService interface to SQLite tables:
 * - conversations: bank/tags-aware storage for conversation memory
 * - learnings: legacy operational learnings (Prometheus reflections)
 *
 * No semantic search — recall returns recent matches filtered by bank/tags.
 */

import { getDatabase, writeWithRetry } from "../db/index.js";
import {
  embed,
  cosineSimilarity,
  serializeEmbedding,
  deserializeEmbedding,
} from "./embeddings.js";
import { rerankByCoherence } from "./graph-rerank.js";
import { recordRetainOutcome } from "../observability/prometheus.js";
import { extractContentTokens, logRecall } from "./recall-utility.js";
import { applyOutcomeBias } from "./outcome-bias.js";
import type { OutcomeBiasResult } from "./outcome-bias.js";
import { resolveRecallMode } from "./recall-mode.js";
import type {
  MemoryService,
  MemoryItem,
  TrustTier,
  RetainOptions,
  RecallOptions,
  ReflectOptions,
} from "./types.js";
import { errMsg } from "../lib/err-msg.js";
import { scrubSecrets } from "../lib/secret-refs.js";
import { emitTraceEvent } from "../observability/task-trace.js";
import {
  RARE_DOC_SHARE,
  extractKeywords,
  ftsTokens,
  hasTokenRun,
  keywordDocFrequency,
  rareDocThreshold,
  rareTermCandidates,
} from "./fts-terms.js";
export { keywordDocFrequency } from "./fts-terms.js";
import {
  TOMBSTONE_BANK,
  loadTombstones,
  silencedBy,
  tombstoneMode,
  type Tombstone,
  type TombstoneMode,
} from "./tombstones.js";

export { RARE_DOC_SHARE, rareDocThreshold, rareTermCandidates };

// ---------------------------------------------------------------------------
// Recall floor (MEMORY_RECALL_FLOOR) — an honest empty recall
// ---------------------------------------------------------------------------
//
// Each layer is normalised by its own best score, so the top FTS row of any
// query clears MIN_RELEVANCE_SCORE, however common its words: a topic never
// mentioned still returns the rows that share "proyecto" or "semana" with it
// (Continuity Scorecard C7). The floor keeps an FTS or LIKE row only when it
// contains a query keyword that is RARE in the bank, and drops the
// newest-rows fallback. The embedding layer is unchanged.

export type RecallFloorMode = "off" | "shadow" | "on";

/** `MEMORY_RECALL_FLOOR`: `off` (default) | `shadow` | `on`. Any other value folds to `off`. */
export function recallFloorMode(env: NodeJS.ProcessEnv = process.env): RecallFloorMode {
  const v = env.MEMORY_RECALL_FLOOR;
  return v === "on" ? "on" : v === "shadow" ? "shadow" : "off";
}

/**
 * The query's rare terms in `bank`: candidate terms that occur in at least one
 * and at most rareDocThreshold(bank rows) rows, as token runs. A term absent
 * from the bank cannot keep a row, so it is not counted.
 */
function rareQueryTerms(query: string, bank: string): string[][] {
  const db = getDatabase();
  const bankRows = (db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE bank = ?").get(bank) as { n: number }).n;
  const threshold = rareDocThreshold(bankRows);
  const rare: string[][] = [];
  for (const [term, df] of keywordDocFrequency(query, bank, threshold + 1)) {
    if (df >= 1 && df <= threshold) rare.push(term.split(" "));
  }
  return rare;
}

/** True when `content`'s FTS tokens hold one of the rare token runs, contiguous. */
function hasRareTerm(content: string, rare: readonly string[][]): boolean {
  if (rare.length === 0) return false;
  return hasTokenRun(ftsTokens(content), rare);
}

/** task_trace_events key: a recall carries no task id (RecallOptions has none). */
const RECALL_FLOOR_TRACE_KEY = "memory-recall";

/**
 * Counts only, never text. `wouldDrop` = candidate rows the floor removes (in
 * `shadow` they are still returned); `returned` = what this recall returns.
 */
function traceRecallFloor(
  mode: RecallFloorMode,
  options: RecallOptions,
  returned: number,
  wouldDrop: number,
  rareTerms: number,
): void {
  emitTraceEvent({
    taskId: RECALL_FLOOR_TRACE_KEY,
    name: "memory.recall_floor",
    attrs: { mode, bank: options.bank, returned, wouldDrop, rareTerms },
  });
}

/** The rare-term lookup failed: the floor is skipped for this recall (counts only). */
function traceRecallFloorError(mode: RecallFloorMode, options: RecallOptions): void {
  emitTraceEvent({
    taskId: RECALL_FLOOR_TRACE_KEY,
    name: "memory.recall_floor",
    attrs: { mode, bank: options.bank, error: true },
  });
}

/** One per recall under MEMORY_TOMBSTONES record|on (counts only): `wouldDrop` under record, `dropped` under on. */
function traceTombstones(mode: TombstoneMode, options: RecallOptions, returned: number, drop: number): void {
  emitTraceEvent({
    taskId: RECALL_FLOOR_TRACE_KEY,
    name: "memory.tombstone",
    attrs: { mode, bank: options.bank, returned, [mode === "on" ? "dropped" : "wouldDrop"]: drop },
  });
}

/** The tombstones could not be loaded: nothing is filtered for this recall (counts only). */
function traceTombstonesError(mode: TombstoneMode, options: RecallOptions): void {
  emitTraceEvent({
    taskId: RECALL_FLOOR_TRACE_KEY,
    name: "memory.tombstone",
    attrs: { mode, bank: options.bank, error: true },
  });
}

// ---------------------------------------------------------------------------
// Trust tier decay — exponential confidence decay by tier
// ---------------------------------------------------------------------------

/** Half-life in days per trust tier. */
const HALF_LIFE: Record<TrustTier, number> = {
  1: 365, // verified — decays slowly over a year
  2: 180, // inferred — 6 months
  3: 90, // provisional — 3 months
  4: 30, // unverified — 1 month
};

/** Base weight per tier (higher tier = higher base). */
const BASE_WEIGHT: Record<TrustTier, number> = {
  1: 1.0,
  2: 0.8,
  3: 0.6,
  4: 0.4,
};

/**
 * Compute decay-weighted score for a memory item.
 * Returns a value between 0 and BASE_WEIGHT[tier].
 */
export function computeDecayWeight(
  trustTier: TrustTier,
  ageDays: number,
): number {
  const halfLife = HALF_LIFE[trustTier];
  const base = BASE_WEIGHT[trustTier];
  return base * Math.pow(0.5, ageDays / halfLife);
}

/**
 * Deserialized-embedding cache for the hybrid recall hot path. Every recall
 * loads up to 500 BLOBs (~3 MB) and turned each into a fresh Float32Array —
 * per inbound message. Embedding rows are append-only and keyed by
 * conversation id, so a vector never changes once written; cache the
 * Float32Array per id and only new ids pay deserialization. Bounded at 1000
 * entries (~6 MB ceiling), insertion-order eviction.
 */
const VECTOR_CACHE_MAX = 1000;
const vectorCache = new Map<number, Float32Array>();

/**
 * Invalidate the vector cache. MUST be called after any conversation-delete
 * batch (consolidation/pruning): `conversations.id` is INTEGER PRIMARY KEY
 * without AUTOINCREMENT, so SQLite can reuse a deleted max-rowid — a cached
 * vector under a reused id would silently return wrong cosine scores.
 * Wholesale clear is fine; the cache re-warms in one recall.
 */
export function clearVectorCache(): void {
  vectorCache.clear();
}

function getCachedVector(id: number, blob: Buffer): Float32Array {
  const hit = vectorCache.get(id);
  if (hit) return hit;
  const vec = deserializeEmbedding(blob);
  vectorCache.set(id, vec);
  while (vectorCache.size > VECTOR_CACHE_MAX) {
    const oldest = vectorCache.keys().next().value;
    if (oldest === undefined) break;
    vectorCache.delete(oldest);
  }
  return vec;
}

/**
 * Ruling 3c (audit R3 B1): recalled rows reach the prompt (enrichment, the
 * memory tools, the Hindsight fallback); a row stored before the write-side
 * scrub, or before the value was saved, is scrubbed here on every read.
 */
function scrubRecalled(items: MemoryItem[]): MemoryItem[] {
  return items.map((item) => {
    const content = scrubSecrets(item.content);
    return content === item.content ? item : { ...item, content };
  });
}

/**
 * 2026-11-08 queue 4bt P2 Step 0: a recalled row's id rides through
 * `applyOutcomeBias` (which drops, re-sorts and spreads every item) under
 * this symbol key, so `recall_audit.top_k_ids` names the rows actually
 * logged, index-aligned with `kept`.
 */
const ROW_ID: unique symbol = Symbol("recallRowId");
type IdTaggedItem<I> = MemoryItem & { [ROW_ID]: I };

/**
 * `applyOutcomeBias` plus `keptIds[i]` = the id of `kept[i]` (`ids[i]` is the
 * id of `items[i]`). The key is stripped from `kept`: no consumer or
 * formatter ever sees it. Used by sqlite-primary and Hindsight recalls.
 */
export function applyOutcomeBiasWithIds<I>(
  items: MemoryItem[],
  ids: readonly I[],
  options: RecallOptions,
): OutcomeBiasResult & { keptIds: I[] } {
  const tagged: IdTaggedItem<I>[] = items.map((item, i) => ({
    ...item,
    [ROW_ID]: ids[i]!,
  }));
  const bias = applyOutcomeBias(tagged, options);
  const keptTagged = bias.kept as IdTaggedItem<I>[];
  return {
    ...bias,
    kept: keptTagged.map(({ [ROW_ID]: _id, ...item }) => item),
    keptIds: keptTagged.map((k) => k[ROW_ID]),
  };
}

export class SqliteMemoryBackend implements MemoryService {
  readonly backend = "sqlite" as const;

  /**
   * @param instrument When true (the default), `recall()` applies the
   *   recall-side outcome bias and writes a `recall_audit` row tagged
   *   `source='sqlite-primary'`. This is correct ONLY when this backend is
   *   the top-level memory service — i.e. `HINDSIGHT_ENABLED=false`, the
   *   current default under the queue #15 demote.
   *
   *   Pass `false` for nested use where the caller instruments itself or
   *   wants raw retrieval:
   *     - `HindsightMemoryBackend.sqliteFallback` — Hindsight applies
   *       `applyOutcomeBias` + `logRecall` on top; double-doing it here
   *       would double-log and double-filter.
   *     - `recall-compare` — an A/B measurement tool; must not pollute
   *       `recall_audit`, and compares raw retrieval quality.
   *
   *   Before this flag (pre-V8.1 Phase A) `logRecall` fired ONLY from
   *   `HindsightMemoryBackend`, so under the demote `recall_audit` went
   *   dormant — no rows since 2026-05-09. See `S6-recall-audit-dormant`.
   */
  constructor(private readonly instrument = true) {}

  async retain(content: string, options: RetainOptions): Promise<void> {
    try {
      const db = getDatabase();
      // Ruling 3c: a stored credential pasted in chat is not kept in clear.
      const clean = scrubSecrets(content);
      const tags = JSON.stringify(options.tags ?? []);
      const trustTier = options.trustTier ?? 3;
      const source = options.source ?? "agent";
      const result = writeWithRetry(() =>
        db
          .prepare(
            "INSERT INTO conversations (bank, tags, content, trust_tier, source) VALUES (?, ?, ?, ?, ?)",
          )
          .run(options.bank, tags, clean, trustTier, source),
      );
      // Queue #7 part 3 (2026-05-07): bump Prom counter AFTER the INSERT so
      // failed writes (writeWithRetry exhausting SQLITE_BUSY) don't inflate
      // mc_retain_outcome_total. SV1+W1 audit fixes: static import + post-
      // insert placement.
      recordRetainOutcome(options.bank, options.tags);

      // Async embed + store (fire-and-forget, non-blocking)
      const rowId = result.lastInsertRowid as number;
      embed(clean)
        .then((vec) => {
          if (vec) {
            try {
              db.prepare(
                "INSERT OR REPLACE INTO conversation_embeddings (conversation_id, embedding) VALUES (?, ?)",
              ).run(rowId, serializeEmbedding(vec));
            } catch {
              /* non-fatal */
            }
          }
        })
        .catch((err) => {
          console.warn(
            "[memory] Embedding store failed:",
            errMsg(err),
          );
        });
    } catch {
      // DB may not be initialized in tests — best-effort
    }
  }

  /**
   * Public recall entry point.
   *
   * When `instrument` is set (this backend is the primary memory service),
   * wraps the hybrid retrieval with the recall-side outcome bias and a
   * `recall_audit` row. Otherwise returns raw retrieval — the nested caller
   * (`HindsightMemoryBackend`, `recall-compare`) instruments itself.
   */
  async recall(query: string, options: RecallOptions): Promise<MemoryItem[]> {
    if (!this.instrument) {
      return scrubRecalled((await this.recallHybrid(query, options)).items);
    }

    // Primary-service path (HINDSIGHT_ENABLED=false). Apply the recall-side
    // outcome bias — dark under the demote until now because it lived only
    // in HindsightMemoryBackend — and write the recall_audit row that the
    // V8.1 correspondence audit + `mc-ctl recall-utility` consume.
    const start = Date.now();
    const { items, ids } = await this.recallHybrid(query, options);
    const { kept, keptIds, excluded, breakdown } = applyOutcomeBiasWithIds(
      scrubRecalled(items),
      ids,
      options,
    );
    logRecall({
      bank: options.bank,
      query,
      source: "sqlite-primary",
      results: kept,
      topKIds: keptIds.map(String),
      latencyMs: Date.now() - start,
      excludedCount: excluded,
      outcomeBreakdown: breakdown,
      mode: resolveRecallMode(options),
    });
    if (excluded > 0) {
      console.log(
        `[memory] recall(sqlite-primary) bank=${options.bank} filtered ${excluded} outcome-tagged result(s)`,
      );
    }
    return kept;
  }

  /**
   * Returns the items plus `ids`, the `conversations.id` of each item at the
   * same index (queue 4bt P2 Step 0). `ids` never reaches a consumer.
   */
  private async recallHybrid(
    query: string,
    options: RecallOptions,
  ): Promise<{ items: MemoryItem[]; ids: number[] }> {
    try {
      const db = getDatabase();
      const limit = options.maxResults ?? 10;
      const now = Date.now();
      const fetchLimit = limit * 3;
      const floorMode = recallFloorMode();
      // A failed lookup skips the floor (rare = null): shadow then returns what
      // off returns, and on behaves as off for this recall.
      let rare: string[][] | null = null;
      if (floorMode !== "off") {
        try {
          rare = rareQueryTerms(query, options.bank);
        } catch {
          traceRecallFloorError(floorMode, options);
        }
      }
      // Tombstones: loaded (cached) only under record|on and only for the
      // bank JME consolidates (TOMBSTONE_BANK); a failed load filters
      // nothing for this recall.
      const tombMode = options.bank === TOMBSTONE_BANK ? tombstoneMode() : "off";
      let tombs: readonly Tombstone[] | null = null;
      if (tombMode !== "off") {
        try {
          tombs = loadTombstones();
        } catch {
          traceTombstonesError(tombMode, options);
        }
      }
      let tombDrop = 0;
      const unsilenced = <T extends { content: string; created_at: string }>(rows: T[]): T[] => {
        if (!tombs || tombs.length === 0) return rows;
        const kept = rows.filter((r) => !silencedBy(r, tombs!));
        tombDrop += rows.length - kept.length;
        return tombMode === "on" ? kept : rows;
      };
      const traced = <T>(out: T[]): T[] => {
        if (tombs) traceTombstones(tombMode, options, out.length, tombDrop);
        return out;
      };

      // Build tag filter clause
      let tagClause = "";
      const tagParams: string[] = [];
      if (options.tags && options.tags.length > 0) {
        const placeholders = options.tags.map(() => "?").join(",");
        tagClause = `AND EXISTS (SELECT 1 FROM json_each(c.tags) je WHERE je.value IN (${placeholders}))`;
        tagParams.push(...options.tags);
      }

      // Helper: parse tags JSON column safely (defaults to [])
      const parseTags = (raw: string | null | undefined): string[] => {
        if (!raw) return [];
        try {
          const parsed = JSON.parse(raw);
          return Array.isArray(parsed)
            ? parsed.filter((t) => typeof t === "string")
            : [];
        } catch {
          return [];
        }
      };

      // Helper: compute decay-weighted final score
      const applyDecay = (
        row: {
          id: number;
          content: string;
          created_at: string;
          trust_tier: number;
          tags?: string | null;
        },
        rawScore: number,
      ): {
        content: string;
        createdAt: string;
        trustTier: TrustTier;
        tags: string[];
        _score: number;
        _id: number;
      } => {
        const ageDays =
          (now - new Date(row.created_at + "Z").getTime()) / 86_400_000;
        const tier = (
          [1, 2, 3, 4].includes(row.trust_tier) ? row.trust_tier : 3
        ) as TrustTier;
        const decayWeight = computeDecayWeight(tier, Math.max(0, ageDays));
        return {
          content: row.content,
          createdAt: row.created_at,
          trustTier: tier,
          tags: parseTags(row.tags),
          _score: rawScore + decayWeight,
          _id: row.id,
        };
      };

      // --- Layer 1: FTS5 full-text search (BM25 ranking) ---
      type ScoredRow = {
        id: number;
        content: string;
        created_at: string;
        trust_tier: number;
        tags?: string | null;
        score: number;
      };
      const ftsResults: ScoredRow[] = [];
      try {
        const ftsQuery = extractKeywords(query).join(" OR ");
        if (ftsQuery) {
          const ftsRows = db
            .prepare(
              `SELECT c.id, c.content, c.created_at, c.trust_tier, c.tags, f.rank AS score
               FROM conversations_fts f
               JOIN conversations c ON c.id = f.rowid
               WHERE conversations_fts MATCH ?
                 AND c.bank = ? ${tagClause}
               ORDER BY f.rank
               LIMIT ?`,
            )
            .all(
              ftsQuery,
              options.bank,
              ...tagParams,
              fetchLimit,
            ) as ScoredRow[];
          ftsResults.push(...ftsRows);
        }
      } catch {
        // FTS5 table may not exist yet — fall through to LIKE
      }

      // --- Layer 2: Embedding semantic search (cosine similarity) ---
      const embeddingResults: ScoredRow[] = [];
      try {
        const queryVec = await embed(query);
        if (queryVec) {
          // Load recent embeddings from DB (last 500 in bank)
          const rows = db
            .prepare(
              `SELECT c.id, c.content, c.created_at, c.trust_tier, c.tags, e.embedding
               FROM conversation_embeddings e
               JOIN conversations c ON c.id = e.conversation_id
               WHERE c.bank = ? ${tagClause}
               ORDER BY c.created_at DESC
               LIMIT 500`,
            )
            .all(options.bank, ...tagParams) as Array<{
            id: number;
            content: string;
            created_at: string;
            trust_tier: number;
            tags: string | null;
            embedding: Buffer;
          }>;

          for (const row of rows) {
            const vec = getCachedVector(row.id, row.embedding);
            const sim = cosineSimilarity(queryVec, vec);
            if (sim > 0.3) {
              // Only include above threshold
              embeddingResults.push({
                id: row.id,
                content: row.content,
                created_at: row.created_at,
                trust_tier: row.trust_tier,
                tags: row.tags,
                score: sim,
              });
            }
          }
          embeddingResults.sort((a, b) => b.score - a.score);
          embeddingResults.splice(fetchLimit); // cap
        }
      } catch {
        // Embedding search failed — continue with FTS5 only
      }

      // --- Layer 3: Fallback — LIKE keyword search (original logic) ---
      if (ftsResults.length === 0 && embeddingResults.length === 0) {
        const keywords = extractKeywords(query);
        if (keywords.length > 0) {
          const likeConditions = keywords
            .map(() => "content LIKE ?")
            .join(" OR ");
          const likeParams = keywords.map((k) => `%${k}%`);
          const matchSql = `
            SELECT id, content, created_at, trust_tier, tags,
              (${keywords.map(() => "CASE WHEN content LIKE ? THEN 1 ELSE 0 END").join(" + ")}) AS score
            FROM conversations
            WHERE bank = ? ${tagClause.replace("c.tags", "tags")}
              AND (${likeConditions})
            ORDER BY score DESC, created_at DESC
            LIMIT ?
          `;
          const matchParams = [
            ...likeParams,
            options.bank,
            ...tagParams,
            ...likeParams,
            fetchLimit,
          ];
          const matched = db
            .prepare(matchSql)
            .all(...matchParams) as ScoredRow[];
          if (matched.length > 0) {
            const live = unsilenced(matched);
            if (rare) {
              const kept = live.filter((r) => hasRareTerm(r.content, rare));
              const wouldDrop = live.length - kept.length;
              if (floorMode === "on") {
                const scored = kept.map((r) => applyDecay(r, r.score));
                scored.sort((a, b) => b._score - a._score);
                const top = scored.slice(0, limit);
                const out = top.map(({ _score: _, _id: _i, ...item }) => item);
                traceRecallFloor(floorMode, options, out.length, wouldDrop, rare.length);
                return { items: traced(out), ids: top.map((r) => r._id) };
              }
              traceRecallFloor(floorMode, options, Math.min(limit, live.length), wouldDrop, rare.length);
            }
            const scored = live.map((r) => applyDecay(r, r.score));
            scored.sort((a, b) => b._score - a._score);
            const top = scored.slice(0, limit);
            return {
              items: traced(top.map(({ _score: _, _id: _i, ...item }) => item)),
              ids: top.map((r) => r._id),
            };
          }
        }

        // The floor drops the newest-rows fallback: nothing matched, so nothing is relevant.
        if (floorMode === "on" && rare) {
          traceRecallFloor(floorMode, options, 0, 0, rare.length);
          return { items: traced([]), ids: [] };
        }

        // No matches at all — return recent
        const sql = `
          SELECT id, content, created_at, trust_tier, tags FROM conversations
          WHERE bank = ? ${tagClause.replace("c.tags", "tags")}
          ORDER BY created_at DESC
          LIMIT ?
        `;
        const rows = unsilenced(
          db.prepare(sql).all(options.bank, ...tagParams, limit) as Array<{
            id: number;
            content: string;
            created_at: string;
            trust_tier: number;
            tags: string | null;
          }>,
        );
        if (rare) traceRecallFloor(floorMode, options, rows.length, rows.length, rare.length);
        const items = traced(rows.map((r) => ({
          content: r.content,
          createdAt: r.created_at,
          trustTier: ([1, 2, 3, 4].includes(r.trust_tier)
            ? r.trust_tier
            : 3) as TrustTier,
          tags: parseTags(r.tags),
        })));
        return { items, ids: rows.map((r) => r.id) };
      }

      // --- Merge FTS5 + embedding results ---
      // Minimal sufficiency: discard results below relevance floor to avoid
      // injecting low-quality context that dilutes the prompt. Threshold tuned
      // empirically — 0.12 filters ~15% of merged results on typical queries.
      const MIN_RELEVANCE_SCORE = 0.12;
      const FTS_WEIGHT = 0.5;
      const EMBED_WEIGHT = 0.5;

      // Normalize scores to [0, 1]
      const normalize = (results: ScoredRow[]): Map<string, number> => {
        if (results.length === 0) return new Map();
        const scores = results.map((r) => Math.abs(r.score));
        const max = Math.max(...scores, 0.001);
        const map = new Map<string, number>();
        for (const r of results) {
          map.set(r.content, Math.abs(r.score) / max);
        }
        return map;
      };

      const ftsScores = normalize(ftsResults);
      const embedScores = normalize(embeddingResults);

      // Merge all unique results
      const allResults = new Map<
        string,
        {
          id: number;
          content: string;
          created_at: string;
          trust_tier: number;
          mergedScore: number;
        }
      >();

      for (const r of [...ftsResults, ...embeddingResults]) {
        if (allResults.has(r.content)) continue;
        const fts = ftsScores.get(r.content) ?? 0;
        const emb = embedScores.get(r.content) ?? 0;
        allResults.set(r.content, {
          ...r,
          mergedScore: FTS_WEIGHT * fts + EMBED_WEIGHT * emb,
        });
      }

      // Filter by minimum relevance on the MERGED score, then apply decay and
      // sort. The floor used to be applied after decay, and the decay weight
      // alone (≥0.16 for every row in the DB) exceeded it — the filter was
      // dead and zero-relevance rows were injected (logic audit F17).
      let scored = unsilenced([...allResults.values()].filter((r) => r.mergedScore >= MIN_RELEVANCE_SCORE)).map((r) =>
        applyDecay(r, r.mergedScore),
      );
      scored.sort((a, b) => b._score - a._score);

      // Recall floor: an FTS-only row needs a rare query keyword; a row the
      // embedding layer found is kept (that layer is unchanged).
      let floorDrop = 0;
      if (rare) {
        const keep = (r: { content: string }) => embedScores.has(r.content) || hasRareTerm(r.content, rare);
        floorDrop = scored.filter((r) => !keep(r)).length;
        if (floorMode === "on") scored = scored.filter(keep);
      }

      if (scored.length === 0 && allResults.size > 0) {
        if (floorMode === "on" && floorDrop > 0) {
          console.warn(`[memory] Recall floor dropped all ${floorDrop} results (no rare query keyword)`);
        } else if (tombMode === "on" && tombDrop > 0) {
          console.warn(`[memory] Tombstones silenced all ${tombDrop} results (old values)`);
        } else {
          console.warn(
            `[memory] Relevance filter discarded all ${allResults.size} results (threshold=${MIN_RELEVANCE_SCORE})`,
          );
        }
      }

      // Graph-aware coherence reranker: boost entity-linked clusters as a
      // strict tiebreaker (capped at 15%). Fixes independent-top-K hitting
      // mixed-topic results when several memories share project/person
      // entities. Pattern adapted from memorypilot (conceptually, not copied).
      const { reranked, coherence } = rerankByCoherence(scored);

      console.log(
        `[memory] Hybrid recall: FTS5=${ftsResults.length}, embed=${embeddingResults.length}, merged=${allResults.size}, coherence=${coherence.toFixed(2)}`,
      );

      // 2026-05-07 queue #7 part 2: surface _score as `relevance` on each
      // returned item so the recall-side outcome bias (outcome-bias.ts) has
      // a comparable score to add ±0.05–0.10 onto. Without this the bias
      // function falls back to insertion-order sort and the boost is a no-op.
      const top = reranked.slice(0, limit);
      const out = top.map(({ _score, _id: _i, ...item }) => ({
        ...item,
        relevance: _score,
      }));
      if (rare) traceRecallFloor(floorMode, options, out.length, floorDrop, rare.length);
      return { items: traced(out), ids: top.map((r) => r._id) };
    } catch {
      return { items: [], ids: [] };
    }
  }

  async reflect(_query: string, _options: ReflectOptions): Promise<string> {
    // SQLite backend doesn't support synthesis
    return "";
  }

  async isHealthy(): Promise<boolean> {
    try {
      getDatabase();
      return true;
    } catch {
      return false;
    }
  }
}
