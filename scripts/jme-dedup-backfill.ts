/**
 * jme-dedup-backfill.ts — one-shot cleanup of near-identical live jme_facts.
 *
 * JME hardening 2026-09-30 (audit C3): the consolidator's dedup compared each
 * new fact against the wrong row (queryMemory k=3 after temporal dedup), so
 * twins accumulated — 16 live pairs at cosine ≥ 0.95. upsertFact now does an
 * exact per-category scan; this script clears the backlog it left.
 *
 * Per category: every live embedded pair at cosine ≥ CONSOLIDATOR_SKIP_THRESHOLD
 * is joined (union-find); each cluster keeps its NEWEST row and the rest are
 * expired (expires_at = now — the nightly pruneExpiredFacts deletes them).
 * An operator-confirmed preference (confidence ≥ 1.0) is never expired: a
 * cluster holding one keeps its newest confirmed row instead.
 *
 *   npx tsx scripts/jme-dedup-backfill.ts            # dry run: print the plan
 *   npx tsx scripts/jme-dedup-backfill.ts --apply    # expire (operator only)
 *
 * MC_DB_PATH overrides the database (default data/mc.db); the dry run opens it
 * read-only. Invoked as `mc-ctl jme-dedup [--apply]`.
 */

import Database from "better-sqlite3";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cosineSimilarity,
  deserializeEmbedding,
} from "../src/memory/embeddings.js";
import { CONSOLIDATOR_SKIP_THRESHOLD } from "../src/memory/jme.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DB_PATH =
  process.env.MC_DB_PATH ?? join(SCRIPT_DIR, "..", "data", "mc.db");

interface Row {
  id: number;
  ts: number;
  category: string;
  fact_text: string;
  confidence: number;
  vec: Float32Array;
}

const apply = process.argv.includes("--apply");
const db = new Database(DB_PATH, { readonly: !apply });
db.pragma("busy_timeout = 5000");
const now = Date.now();

const rows = (
  db
    .prepare(
      `SELECT id, ts, category, fact_text, confidence, embedding FROM jme_facts
       WHERE embedding IS NOT NULL AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .all(now) as Array<Omit<Row, "vec"> & { embedding: Buffer }>
).map(({ embedding, ...r }) => ({ ...r, vec: deserializeEmbedding(embedding) }));

const confirmed = (r: Row) => r.category === "preference" && r.confidence >= 1.0;
const newest = (a: Row, b: Row) =>
  b.ts > a.ts || (b.ts === a.ts && b.id > a.id) ? b : a;
const snippet = (t: string) => t.replace(/\s+/g, " ").slice(0, 60);

const toExpire: number[] = [];
let clusterCount = 0;

for (const category of [...new Set(rows.map((r) => r.category))].sort()) {
  const group = rows.filter((r) => r.category === category);
  const parent = group.map((_, i) => i);
  const find = (i: number): number =>
    parent[i] === i ? i : (parent[i] = find(parent[i]!));
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      if (
        cosineSimilarity(group[i]!.vec, group[j]!.vec) >=
        CONSOLIDATOR_SKIP_THRESHOLD
      ) {
        parent[find(i)] = find(j);
      }
    }
  }

  const clusters = new Map<number, Row[]>();
  group.forEach((r, i) => {
    const root = find(i);
    clusters.set(root, [...(clusters.get(root) ?? []), r]);
  });

  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    clusterCount++;
    const pinned = members.filter(confirmed);
    const keep = (pinned.length > 0 ? pinned : members).reduce(newest);
    console.log(
      `[${category}] keep #${keep.id} ${new Date(keep.ts).toISOString().slice(0, 10)} "${snippet(keep.fact_text)}"`,
    );
    for (const m of members) {
      if (m === keep) continue;
      if (confirmed(m)) {
        console.log(`    hold   #${m.id} (confirmed preference) "${snippet(m.fact_text)}"`);
        continue;
      }
      toExpire.push(m.id);
      console.log(
        `    expire #${m.id} cos=${cosineSimilarity(keep.vec, m.vec).toFixed(3)} ${new Date(m.ts).toISOString().slice(0, 10)} "${snippet(m.fact_text)}"`,
      );
    }
  }
}

console.log(
  `\n${rows.length} live embedded facts · ${clusterCount} cluster(s) at cosine ≥ ${CONSOLIDATOR_SKIP_THRESHOLD} · ${toExpire.length} row(s) to expire`,
);

if (!apply) {
  console.log("dry run — nothing written. Re-run with --apply to expire them.");
} else if (toExpire.length > 0) {
  const expire = db.prepare(
    `UPDATE jme_facts SET expires_at = ? WHERE id = ? AND (expires_at IS NULL OR expires_at > ?)`,
  );
  const changed = db.transaction((ids: number[]) =>
    ids.reduce((n, id) => n + expire.run(now, id, now).changes, 0),
  )(toExpire);
  console.log(`applied — ${changed} row(s) expired (pruned by the next jme-consolidate run).`);
}
db.close();
