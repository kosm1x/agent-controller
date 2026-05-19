/**
 * v7.7 Spine 3 Phase 3 — S5 description embedding helpers.
 *
 * Per spec §6: the embedded text is `description + "\n" + trigger_examples`.
 * Reuses `src/memory/embeddings.ts` primitives — same provider (Gemini
 * 1536d by default; override via EMBEDDING_DIMENSIONS), same Float32Array
 * shape, same Buffer serialization. No new dep.
 *
 * Storage: `skills.description_embedding` BLOB column (additive ALTER in
 * Phase 3 schema). JS cosine over BLOBs for Phase 3's 67-skill scale;
 * `sqlite-vec` virtual table is a future option when scale > 1000.
 *
 * Graceful degradation per existing memory pattern: a null return from
 * `embed()` (no API key, API error, malformed response) leaves the
 * column NULL. A future backfill catches it; retrieval falls back to
 * keyword path until then.
 */

import { getDatabase } from "../db/index.js";
import {
  cosineSimilarity,
  deserializeEmbedding,
  embed,
  EMBED_DIMS,
  serializeEmbedding,
} from "../memory/embeddings.js";
import type { ParsedSkill } from "./frontmatter.js";

/**
 * Compose the text fed to the embedder. Matches spec §6:
 * `description + "\n" + trigger_examples.join("\n")`. trigger_examples
 * may be empty for legacy DB skills predating frontmatter; the join
 * produces an empty string and the input degrades to description-only.
 */
export function composeEmbeddingText(args: {
  description: string;
  trigger_examples?: string[];
}): string {
  const triggers = (args.trigger_examples ?? []).join("\n");
  return triggers ? `${args.description}\n${triggers}` : args.description;
}

/**
 * Embed the composite text for a skill and write to its
 * `description_embedding` BLOB column. Returns true on a successful
 * embed + store; false when embed() returned null (graceful path).
 *
 * Does NOT throw — embedding failures must not abort the skill save.
 */
export async function embedAndStoreSkill(
  skillId: string,
  fm: Pick<ParsedSkill, "description" | "trigger_examples">,
): Promise<boolean> {
  const text = composeEmbeddingText(fm);
  if (!text.trim()) return false;

  const vec = await embed(text);
  if (!vec) return false;

  const blob = serializeEmbedding(vec);
  const db = getDatabase();
  db.prepare(
    `UPDATE skills SET description_embedding = ?, updated_at = datetime('now') WHERE skill_id = ?`,
  ).run(blob, skillId);
  return true;
}

/**
 * Load a skill's stored embedding. Returns null when the column is
 * NULL or the BLOB is malformed (wrong byte length for EMBED_DIMS).
 */
export function loadSkillEmbedding(skillId: string): Float32Array | null {
  const db = getDatabase();
  const row = db
    .prepare(
      "SELECT description_embedding AS blob FROM skills WHERE skill_id = ?",
    )
    .get(skillId) as { blob: Buffer | null } | undefined;
  if (!row?.blob) return null;
  // Float32 = 4 bytes. Defensive: reject if size doesn't match deployment
  // dimension. Dimension mismatch usually means the deployment EMBED_DIMS
  // changed and stale rows need a backfill.
  if (row.blob.byteLength !== EMBED_DIMS * 4) return null;
  return deserializeEmbedding(row.blob);
}

/**
 * Re-export cosine for callers that want to score arbitrary vectors
 * without re-importing from /memory.
 */
export { cosineSimilarity };
