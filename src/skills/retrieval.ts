/**
 * v7.7 Spine 3 Phase 3 Bundle 2 — vector skill retrieval.
 *
 * Per spec §6:
 *   1. Embed the task context (description + free prose).
 *   2. Load active + certified + anti-list-clean skills with embeddings.
 *   3. Cosine-rank each against the query; return top-k.
 *
 * Voyager pattern: anti-list filter (`consecutive_failures < 3`) hides
 * recently-failing skills from retrieval at the QUERY layer, not the
 * planner layer (spec §6 + §10).
 *
 * Graceful degradation:
 *   - Query embed returns null → keyword-LIKE fallback via `findSkillsByKeywords`
 *   - Zero candidates have embeddings (early Phase 3 state) → same fallback
 *   - Skill matches below `minSimilarity` → filtered out
 *
 * Phase 4+ will register top-k results as deferred `skill__<name>` tools.
 * Phase 3 just returns the ranked list — caller decides how to surface.
 */

import { embed } from "../memory/embeddings.js";
import { getDatabase } from "../db/index.js";
import { findSkillsByKeywords } from "../db/skills.js";
import { cosineSimilarity } from "./embedding.js";

export interface RetrievedSkill {
  skillId: string;
  name: string;
  description: string;
  /** Cosine similarity score, [-1, 1]. NaN coerced to 0. Higher = better. */
  similarity: number;
  /** Whether this hit came from vector path or keyword fallback. */
  source: "vector" | "keyword";
}

export interface RetrieveOptions {
  /** Max results to return. Default 5 (spec §6). */
  k?: number;
  /**
   * Skills below this cosine threshold are dropped. Default 0.4 — a
   * permissive baseline that filters noise without erasing the long
   * tail. Tune per operator after collecting retrieval-quality data.
   */
  minSimilarity?: number;
  /**
   * Allow fallback to keyword search when (a) query embed fails or
   * (b) no candidates have embeddings yet. Default true.
   */
  fallbackToKeyword?: boolean;
}

const DEFAULT_K = 5;
const DEFAULT_MIN_SIMILARITY = 0.4;

interface CandidateRow {
  skill_id: string;
  name: string;
  description: string;
  blob: Buffer;
}

/**
 * Vector-retrieve top-k skills for a task context. Never throws.
 */
export async function retrieveSkills(
  taskContext: string,
  options: RetrieveOptions = {},
): Promise<RetrievedSkill[]> {
  const k = options.k ?? DEFAULT_K;
  const minSimilarity = options.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const fallback = options.fallbackToKeyword ?? true;

  if (!taskContext.trim() || k <= 0) return [];

  // Phase 3 retrieval scope per spec §6: certified + active + anti-list-clean
  // + has-embedding. Order doesn't matter — we sort by cosine after loading.
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT skill_id, name, description, description_embedding AS blob
       FROM skills
       WHERE is_certified = 1
         AND active = 1
         AND consecutive_failures < 3
         AND description_embedding IS NOT NULL`,
    )
    .all() as CandidateRow[];

  if (rows.length === 0) {
    return fallback ? toKeywordResults(taskContext, k) : [];
  }

  const queryVec = await embed(taskContext);
  if (!queryVec) {
    return fallback ? toKeywordResults(taskContext, k) : [];
  }

  const scored: RetrievedSkill[] = [];
  let mismatched = 0;
  for (const row of rows) {
    // Dim mismatch (drift across deployments) → skip silently. Backfill
    // will re-embed on the next operator-triggered pass. Counted so the
    // post-loop fallback can recognize "all rows are dim-stale" as a
    // distinct state from "all rows are below threshold."
    const expectedBytes = queryVec.length * 4;
    if (row.blob.byteLength !== expectedBytes) {
      mismatched++;
      continue;
    }
    const skillVec = new Float32Array(
      row.blob.buffer.slice(
        row.blob.byteOffset,
        row.blob.byteOffset + row.blob.byteLength,
      ),
    );
    const sim = cosineSimilarity(queryVec, skillVec);
    const score = Number.isFinite(sim) ? sim : 0;
    if (score >= minSimilarity) {
      scored.push({
        skillId: row.skill_id,
        name: row.name,
        description: row.description,
        similarity: score,
        source: "vector",
      });
    }
  }

  // R1-W1 fold: if vector path collapsed because EVERY row's BLOB dim
  // mismatched the query (operator changed EMBEDDING_DIMENSIONS, model
  // swap), fall back to keyword. Below-threshold zero-results stay
  // empty (operator's threshold is intentional).
  if (scored.length === 0 && mismatched > 0 && fallback) {
    return toKeywordResults(taskContext, k);
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, k);
}

/**
 * Keyword-LIKE fallback. Used when query embed fails or no skills are
 * embedded yet. Maps the SkillRow shape to the RetrievedSkill shape;
 * similarity is set to a sentinel `0` so callers can identify these as
 * non-vector hits.
 */
function toKeywordResults(taskContext: string, k: number): RetrievedSkill[] {
  const rows = findSkillsByKeywords(taskContext);
  return rows.slice(0, k).map((r) => ({
    skillId: r.skill_id,
    name: r.name,
    description: r.description,
    similarity: 0,
    source: "keyword" as const,
  }));
}
