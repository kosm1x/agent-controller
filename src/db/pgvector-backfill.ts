/**
 * pgvector backfill — one-time migration of jarvis_files to kb_entries.
 *
 * Reads all 315+ entries from SQLite jarvis_files, generates embeddings
 * in batches, and upserts to pgvector. Idempotent (upsert on path).
 *
 * Run via: npx tsx src/db/pgvector-backfill.ts
 */

import { getDatabase } from "./index.js";
import { generateEmbeddings } from "../inference/embeddings.js";
import { pgBatchUpsert, contentHash } from "./pgvector.js";
import type { KbEntry } from "./pgvector.js";

interface JarvisFileRow {
  path: string;
  title: string;
  content: string;
  tags: string;
  qualifier: string;
  condition: string | null;
  priority: number;
  created_at: string;
  updated_at: string;
}

/**
 * Backfill all jarvis_files to pgvector kb_entries.
 * Generates embeddings in batches to stay within rate limits.
 */
export async function backfillToPgvector(): Promise<{
  total: number;
  success: number;
  failed: number;
  duration_ms: number;
}> {
  const start = Date.now();
  const db = getDatabase();

  const rows = db
    .prepare(
      "SELECT path, title, content, tags, qualifier, condition, priority, created_at, updated_at FROM jarvis_files ORDER BY path",
    )
    .all() as JarvisFileRow[];

  console.log(`[backfill] Found ${rows.length} jarvis_files to migrate`);

  // Process in batches of 10 (embedding API limit + memory)
  const BATCH_SIZE = 10;
  let totalSuccess = 0;
  let totalFailed = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(rows.length / BATCH_SIZE);

    console.log(
      `[backfill] Batch ${batchNum}/${totalBatches}: ${batch.length} entries`,
    );

    // Generate embeddings for the batch
    const embeddingTexts = batch.map(
      (r) => `${r.title}\n\n${r.content.slice(0, 8000)}`,
    );

    let embeddings: number[][];
    try {
      embeddings = await generateEmbeddings(embeddingTexts);
    } catch (err) {
      console.warn(
        `[backfill] Embedding generation failed for batch ${batchNum}:`,
        err instanceof Error ? err.message : err,
      );
      embeddings = batch.map(() => []);
    }

    // Build KB entries
    const entries: KbEntry[] = batch.map((row, idx) => {
      let tags: string[] = [];
      try {
        tags = JSON.parse(row.tags ?? "[]");
      } catch {
        tags = [];
      }

      return {
        path: row.path,
        title: row.title,
        content: row.content,
        content_hash: contentHash(row.content),
        embedding:
          embeddings[idx] && embeddings[idx].length > 0
            ? embeddings[idx]
            : undefined,
        qualifier: row.qualifier,
        condition: row.condition ?? undefined,
        tags,
        priority: row.priority,
        salience: qualifierToSalience(row.qualifier),
      };
    });

    // Upsert to pgvector
    const result = await pgBatchUpsert(entries);
    totalSuccess += result.success;
    totalFailed += result.failed;

    // Rate limit: 200ms between batches
    if (i + BATCH_SIZE < rows.length) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  const duration = Date.now() - start;
  console.log(
    `[backfill] Complete: ${totalSuccess} success, ${totalFailed} failed (${duration}ms)`,
  );

  return {
    total: rows.length,
    success: totalSuccess,
    failed: totalFailed,
    duration_ms: duration,
  };
}

function qualifierToSalience(qualifier: string): number {
  switch (qualifier) {
    case "enforce":
      return 0.95;
    case "always-read":
      return 0.9;
    case "conditional":
      return 0.7;
    case "workspace":
      return 0.3;
    default:
      return 0.5;
  }
}

// CLI entry point
if (
  process.argv[1]?.endsWith("pgvector-backfill.ts") ||
  process.argv[1]?.endsWith("pgvector-backfill.js")
) {
  // Initialize SQLite database when running as standalone script
  const { initDatabase } = await import("./index.js");
  initDatabase(process.env.MC_DB_PATH ?? "./data/mc.db");

  backfillToPgvector()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.failed > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error("Backfill failed:", err);
      process.exit(1);
    });
}
