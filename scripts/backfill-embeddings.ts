/**
 * Backfill conversation_embeddings with Gemini 1536-dim vectors.
 *
 * Reads conversations missing embeddings, generates in batches of 50,
 * and inserts into conversation_embeddings. Idempotent — skips rows
 * that already have embeddings.
 *
 * Run via: npx tsx scripts/backfill-embeddings.ts
 */

import { initDatabase } from "../src/db/index.js";
import { generateEmbeddings } from "../src/inference/embeddings.js";
import { serializeEmbedding } from "../src/memory/embeddings.js";

const BATCH_SIZE = 50;
const DELAY_MS = 1000; // 1s between batches to respect rate limits
const MAX_CHARS = 512; // match embed() truncation

async function backfill() {
  const db = initDatabase(process.env.MC_DB_PATH ?? "./data/mc.db");

  // Find conversations without embeddings
  const rows = db
    .prepare(
      `SELECT c.id, c.content
       FROM conversations c
       LEFT JOIN conversation_embeddings e ON c.id = e.conversation_id
       WHERE e.conversation_id IS NULL
       ORDER BY c.created_at DESC`,
    )
    .all() as Array<{ id: number; content: string }>;

  console.log(`[backfill] ${rows.length} conversations need embeddings`);

  if (rows.length === 0) {
    console.log("[backfill] Nothing to do");
    return;
  }

  let success = 0;
  let failed = 0;
  const start = Date.now();

  const insert = db.prepare(
    "INSERT OR IGNORE INTO conversation_embeddings (conversation_id, embedding) VALUES (?, ?)",
  );

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const texts = batch.map((r) => r.content.slice(0, MAX_CHARS));

    try {
      const vectors = await generateEmbeddings(texts);

      const insertMany = db.transaction(() => {
        for (let j = 0; j < batch.length; j++) {
          const vec = vectors[j];
          if (vec && vec.length > 0) {
            insert.run(batch[j].id, serializeEmbedding(new Float32Array(vec)));
            success++;
          } else {
            failed++;
          }
        }
      });
      insertMany();

      const pct = Math.round(((i + batch.length) / rows.length) * 100);
      console.log(
        `[backfill] ${i + batch.length}/${rows.length} (${pct}%) — ${success} ok, ${failed} failed`,
      );
    } catch (err) {
      console.warn(
        `[backfill] Batch ${i}-${i + batch.length} error:`,
        err instanceof Error ? err.message : err,
      );
      failed += batch.length;
    }

    // Rate limit pause between batches
    if (i + BATCH_SIZE < rows.length) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `[backfill] Done in ${elapsed}s — ${success} embedded, ${failed} failed, ${rows.length} total`,
  );
}

backfill().catch((err) => {
  console.error("[backfill] Fatal:", err);
  process.exit(1);
});
