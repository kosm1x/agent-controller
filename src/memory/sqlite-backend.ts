/**
 * SQLite memory backend — conversations table + learnings table.
 *
 * Maps the MemoryService interface to SQLite tables:
 * - conversations: bank/tags-aware storage for conversation memory
 * - learnings: legacy operational learnings (Prometheus reflections)
 *
 * No semantic search — recall returns recent matches filtered by bank/tags.
 */

import { getDatabase } from "../db/index.js";
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

  return query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !stopWords.has(w))
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
      db.prepare(
        "INSERT INTO conversations (bank, tags, content, trust_tier, source) VALUES (?, ?, ?, ?, ?)",
      ).run(options.bank, tags, content, trustTier, source);
    } catch {
      // DB may not be initialized in tests — best-effort
    }
  }

  async recall(query: string, options: RecallOptions): Promise<MemoryItem[]> {
    try {
      const db = getDatabase();
      const limit = options.maxResults ?? 10;
      const now = Date.now();

      // Extract keywords from query for relevance matching
      const keywords = extractKeywords(query);
      const hasKeywords = keywords.length > 0;

      // Build tag filter clause
      let tagClause = "";
      const tagParams: string[] = [];
      if (options.tags && options.tags.length > 0) {
        const placeholders = options.tags.map(() => "?").join(",");
        tagClause = `AND EXISTS (SELECT 1 FROM json_each(tags) je WHERE je.value IN (${placeholders}))`;
        tagParams.push(...options.tags);
      }

      // Helper: compute decay-weighted score for ranking
      const rankWithDecay = (
        rows: Array<{
          content: string;
          created_at: string;
          trust_tier: number;
          keyword_score?: number;
        }>,
      ): MemoryItem[] => {
        const scored = rows.map((r) => {
          const ageDays =
            (now - new Date(r.created_at + "Z").getTime()) / 86_400_000;
          const tier = (
            [1, 2, 3, 4].includes(r.trust_tier) ? r.trust_tier : 3
          ) as TrustTier;
          const decayWeight = computeDecayWeight(tier, Math.max(0, ageDays));
          const keywordBoost = r.keyword_score ?? 0;
          return {
            content: r.content,
            createdAt: r.created_at,
            trustTier: tier,
            _score: keywordBoost + decayWeight,
          };
        });
        scored.sort((a, b) => b._score - a._score);
        return scored.slice(0, limit).map(({ _score: _, ...item }) => item);
      };

      if (hasKeywords) {
        // Keyword-matched recall with decay weighting.
        // Fetch more candidates than needed, then re-rank with decay.
        const fetchLimit = limit * 3;
        const likeConditions = keywords
          .map(() => "content LIKE ?")
          .join(" OR ");
        const likeParams = keywords.map((k) => `%${k}%`);

        const matchSql = `
          SELECT content, created_at, trust_tier,
            (${keywords.map(() => "CASE WHEN content LIKE ? THEN 1 ELSE 0 END").join(" + ")}) AS keyword_score
          FROM conversations
          WHERE bank = ? ${tagClause}
            AND (${likeConditions})
          ORDER BY keyword_score DESC, created_at DESC
          LIMIT ?
        `;
        const matchParams = [
          ...likeParams, // for score calculation
          options.bank,
          ...tagParams,
          ...likeParams, // for WHERE filter
          fetchLimit,
        ];
        const matched = db.prepare(matchSql).all(...matchParams) as Array<{
          content: string;
          created_at: string;
          trust_tier: number;
          keyword_score: number;
        }>;

        if (matched.length > 0) {
          // Fill with recent rows if needed
          const matchedContents = new Set(matched.map((r) => r.content));
          const recentSql = `
            SELECT content, created_at, trust_tier FROM conversations
            WHERE bank = ? ${tagClause}
            ORDER BY created_at DESC
            LIMIT ?
          `;
          const recentRows = db
            .prepare(recentSql)
            .all(options.bank, ...tagParams, fetchLimit) as Array<{
            content: string;
            created_at: string;
            trust_tier: number;
          }>;
          const filler = recentRows.filter(
            (r) => !matchedContents.has(r.content),
          );
          const combined = [
            ...matched,
            ...filler.map((r) => ({ ...r, keyword_score: 0 })),
          ];
          return rankWithDecay(combined);
        }
      }

      // No keywords or no matches — recency + decay scoring
      const sql = `
        SELECT content, created_at, trust_tier FROM conversations
        WHERE bank = ? ${tagClause}
        ORDER BY created_at DESC
        LIMIT ?
      `;
      const rows = db
        .prepare(sql)
        .all(options.bank, ...tagParams, limit * 3) as Array<{
        content: string;
        created_at: string;
        trust_tier: number;
      }>;
      return rankWithDecay(rows);
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
