/**
 * v7.7 Spine 3 Phase 3 — operator-triggered embedding backfill.
 *
 * Iterates `skills` rows where `description_embedding IS NULL` AND a
 * non-empty `description` exists, calls `embedAndStoreSkill` per row.
 * Idempotent: re-running after a successful pass skips already-embedded
 * rows; partial-failure rows surface as `errors` and stay NULL until
 * the operator retries.
 *
 * Designed for `mc-ctl skills backfill-embeddings` invocation. Phase 3
 * boot does NOT auto-backfill — operator runs it once after deploy.
 * Subsequent skillSave calls embed in-line via lifecycle.ts.
 *
 * Embedding API failures (no key, network error, dim mismatch) are
 * counted as errors but do not abort the loop. Returns aggregate
 * counts + per-error details for the CLI to render.
 */

import { getDatabase } from "../db/index.js";
import { createLogger } from "../lib/logger.js";
import { embedAndStoreSkill } from "./embedding.js";

const moduleLog = createLogger("skills:backfill");

export interface BackfillResult {
  considered: number;
  embedded: number;
  skipped: number;
  errors: Array<{ skillId: string; name: string; reason: string }>;
}

export interface BackfillOptions {
  /** Cap on how many skills to process this run (operator throttle). */
  limit?: number;
  /** Optional sleep between embed calls to spread API load (ms). */
  sleepMs?: number;
  /** Optional progress callback after each row. */
  onProgress?: (i: number, total: number, name: string) => void;
}

export interface BackfillLog {
  info(msg: string, fields?: Record<string, unknown>): void;
}

// BackfillLog signature is `info(msg, fields)` (caller-friendly,
// console-style). Pino's native shape is the inverse: `info(fields, msg)`.
// This default translates between the two. Test callers (SILENT)
// implement the interface directly and skip the translation.
const DEFAULT_LOG: BackfillLog = {
  info: (msg, fields) => moduleLog.info(fields ?? {}, msg),
};

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

export async function backfillSkillEmbeddings(
  options: BackfillOptions = {},
  log: BackfillLog = DEFAULT_LOG,
): Promise<BackfillResult> {
  const db = getDatabase();

  // SELECT all candidate rows up front. The loop is long (network bound)
  // and a row added mid-run is fine to defer to the next backfill.
  const rows = db
    .prepare(
      `SELECT skill_id, name, description, trigger_examples_json
       FROM skills
       WHERE description_embedding IS NULL
         AND description IS NOT NULL
         AND TRIM(description) != ''
       ORDER BY use_count DESC, name ASC
       ${options.limit && options.limit > 0 ? "LIMIT ?" : ""}`,
    )
    .all(
      ...(options.limit && options.limit > 0 ? [options.limit] : []),
    ) as Array<{
    skill_id: string;
    name: string;
    description: string;
    trigger_examples_json: string;
  }>;

  const result: BackfillResult = {
    considered: rows.length,
    embedded: 0,
    skipped: 0,
    errors: [],
  };

  log.info("backfill started", { candidates: rows.length });

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let triggerExamples: string[] = [];
    try {
      const parsed = JSON.parse(row.trigger_examples_json || "[]");
      if (Array.isArray(parsed))
        triggerExamples = parsed.filter(
          (x): x is string => typeof x === "string",
        );
    } catch {
      // Legacy or malformed rows: fall through with empty triggers.
    }

    try {
      const ok = await embedAndStoreSkill(row.skill_id, {
        description: row.description,
        trigger_examples: triggerExamples,
      });
      if (ok) {
        result.embedded++;
      } else {
        result.skipped++;
        result.errors.push({
          skillId: row.skill_id,
          name: row.name,
          reason: "embed() returned null (no API key or upstream error)",
        });
      }
    } catch (err) {
      result.skipped++;
      result.errors.push({
        skillId: row.skill_id,
        name: row.name,
        reason: err instanceof Error ? err.message : String(err),
      });
    }

    if (options.onProgress) options.onProgress(i + 1, rows.length, row.name);
    if (options.sleepMs && options.sleepMs > 0 && i + 1 < rows.length) {
      await sleep(options.sleepMs);
    }
  }

  log.info("backfill complete", {
    embedded: result.embedded,
    skipped: result.skipped,
    errors: result.errors.length,
  });
  return result;
}
