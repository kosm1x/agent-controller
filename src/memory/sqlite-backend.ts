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
import type {
  MemoryService,
  MemoryItem,
  TrustTier,
  RetainOptions,
  RecallOptions,
  ReflectOptions,
} from "./types.js";

/** Extract meaningful keywords from a query string for SQLite LIKE matching. */
function extractKeywords(query: string): string[] {
  const stopWords = new Set([
    "el",
    "la",
    "los",
    "las",
    "un",
    "una",
    "de",
    "del",
    "en",
    "con",
    "por",
    "para",
    "que",
    "es",
    "y",
    "o",
    "a",
    "al",
    "se",
    "no",
    "su",
    "mi",
    "me",
    "the",
    "a",
    "an",
    "is",
    "are",
    "was",
    "in",
    "on",
    "of",
    "and",
    "or",
    "to",
    "for",
    "it",
    "at",
    "by",
    "do",
    "be",
    "he",
    "she",
    "we",
    "you",
    "what",
    "how",
    "who",
    "when",
    "where",
    "this",
    "that",
    "my",
    "your",
    "user",
    "jarvis",
    "fede",
  ]);

  // FTS5 reserved operators must be excluded — they cause syntax errors in MATCH
  const fts5Operators = new Set(["and", "or", "not", "near"]);

  return query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !stopWords.has(w) && !fts5Operators.has(w))
    .slice(0, 6); // Cap at 6 keywords to keep queries fast
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

export class SqliteMemoryBackend implements MemoryService {
  readonly backend = "sqlite" as const;

  async retain(content: string, options: RetainOptions): Promise<void> {
    try {
      const db = getDatabase();
      const tags = JSON.stringify(options.tags ?? []);
      const trustTier = options.trustTier ?? 3;
      const source = options.source ?? "agent";
      const result = writeWithRetry(() =>
        db
          .prepare(
            "INSERT INTO conversations (bank, tags, content, trust_tier, source) VALUES (?, ?, ?, ?, ?)",
          )
          .run(options.bank, tags, content, trustTier, source),
      );

      // Async embed + store (fire-and-forget, non-blocking)
      const rowId = result.lastInsertRowid as number;
      embed(content)
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
            err instanceof Error ? err.message : err,
          );
        });
    } catch {
      // DB may not be initialized in tests — best-effort
    }
  }

  async recall(query: string, options: RecallOptions): Promise<MemoryItem[]> {
    try {
      const db = getDatabase();
      const limit = options.maxResults ?? 10;
      const now = Date.now();
      const fetchLimit = limit * 3;

      // Build tag filter clause
      let tagClause = "";
      const tagParams: string[] = [];
      if (options.tags && options.tags.length > 0) {
        const placeholders = options.tags.map(() => "?").join(",");
        tagClause = `AND EXISTS (SELECT 1 FROM json_each(c.tags) je WHERE je.value IN (${placeholders}))`;
        tagParams.push(...options.tags);
      }

      // Helper: compute decay-weighted final score
      const applyDecay = (
        row: { content: string; created_at: string; trust_tier: number },
        rawScore: number,
      ): {
        content: string;
        createdAt: string;
        trustTier: TrustTier;
        _score: number;
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
          _score: rawScore + decayWeight,
        };
      };

      // --- Layer 1: FTS5 full-text search (BM25 ranking) ---
      type ScoredRow = {
        content: string;
        created_at: string;
        trust_tier: number;
        score: number;
      };
      const ftsResults: ScoredRow[] = [];
      try {
        const ftsQuery = extractKeywords(query).join(" OR ");
        if (ftsQuery) {
          const ftsRows = db
            .prepare(
              `SELECT c.content, c.created_at, c.trust_tier, f.rank AS score
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
              `SELECT c.id, c.content, c.created_at, c.trust_tier, e.embedding
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
            embedding: Buffer;
          }>;

          for (const row of rows) {
            const vec = deserializeEmbedding(row.embedding);
            const sim = cosineSimilarity(queryVec, vec);
            if (sim > 0.3) {
              // Only include above threshold
              embeddingResults.push({
                content: row.content,
                created_at: row.created_at,
                trust_tier: row.trust_tier,
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
            SELECT content, created_at, trust_tier,
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
            const scored = matched.map((r) => applyDecay(r, r.score));
            scored.sort((a, b) => b._score - a._score);
            return scored.slice(0, limit).map(({ _score: _, ...item }) => item);
          }
        }

        // No matches at all — return recent
        const sql = `
          SELECT content, created_at, trust_tier FROM conversations
          WHERE bank = ? ${tagClause.replace("c.tags", "tags")}
          ORDER BY created_at DESC
          LIMIT ?
        `;
        const rows = db
          .prepare(sql)
          .all(options.bank, ...tagParams, limit) as Array<{
          content: string;
          created_at: string;
          trust_tier: number;
        }>;
        return rows.map((r) => ({
          content: r.content,
          createdAt: r.created_at,
          trustTier: ([1, 2, 3, 4].includes(r.trust_tier)
            ? r.trust_tier
            : 3) as TrustTier,
        }));
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

      // Apply decay, filter by minimum relevance, and sort
      const scored = [...allResults.values()]
        .map((r) => applyDecay(r, r.mergedScore))
        .filter((r) => r._score >= MIN_RELEVANCE_SCORE);
      scored.sort((a, b) => b._score - a._score);

      // Graph-aware coherence reranker: boost entity-linked clusters as a
      // strict tiebreaker (capped at 15%). Fixes independent-top-K hitting
      // mixed-topic results when several memories share project/person
      // entities. Pattern adapted from memorypilot (conceptually, not copied).
      const { reranked, coherence } = rerankByCoherence(scored);

      console.log(
        `[memory] Hybrid recall: FTS5=${ftsResults.length}, embed=${embeddingResults.length}, merged=${allResults.size}, coherence=${coherence.toFixed(2)}`,
      );

      return reranked.slice(0, limit).map(({ _score: _, ...item }) => item);
    } catch {
      return [];
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
