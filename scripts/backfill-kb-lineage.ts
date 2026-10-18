/**
 * backfill-kb-lineage.ts — give pre-4o PDF chunks their manifest lineage.
 *
 * OPERATOR-RUN: `--apply` writes the live pgvector index (kb_entries).
 *
 *   COMMIT_DB_KEY=<key in your shell env> npx tsx scripts/backfill-kb-lineage.ts            # dry run (default)
 *   COMMIT_DB_KEY=<key in your shell env> npx tsx scripts/backfill-kb-lineage.ts --apply
 *
 * Reads `type=ingested, qualifier=pdf` rows whose `related_to` is empty and
 * whose path has the chunk shape `<namespace>/<docSlug>/<sections…>/<NNNN>`
 * written by `kb_ingest_pdf_structured`, groups them by document, and per
 * document (with --apply):
 *   1. upserts the manifest row `<namespace>/<docSlug>.manifest.md` with
 *      content "backfilled manifest: <docSlug>, N chunks" by a plain POST,
 *      WITHOUT the staleness cascade (a backfill must never stale a live
 *      chunk, also on a re-run after a partial failure). The next real ingest
 *      hashes differently and cascades over the old chunk set.
 *   2. PATCHes `related_to = [manifest]` on that document's chunks.
 * The dry run prints counts per document only. The key comes from
 * process.env.COMMIT_DB_KEY (the variable mission-control reads); it is never
 * read from a file and never printed.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  contentHash,
  getApiKey,
  supabaseHeaders,
} from "../src/db/pgvector.js";
import { manifestPath, slugify } from "../src/kb/pdf-structured-ingest.js";
import { requireOperatorContext } from "../src/lib/operator-gate.js";

const SUPABASE_URL = "https://db.mycommit.net/rest/v1";
const PAGE = 1000;
const PATCH_BATCH = 50;

export interface ChunkRow {
  path: string;
  related_to: unknown;
  section_path: unknown;
}

export interface DocPlan {
  manifestPath: string;
  docSlug: string;
  chunkPaths: string[];
}

export interface BackfillPlan {
  docs: DocPlan[];
  skippedHasLineage: number;
  skippedNotChunk: number;
}

/**
 * Manifest location for a chunk path, or null when the path is not the
 * chunk shape. The section segments are matched against the row's own
 * `section_path` (slugified, `root` when empty), so a namespace containing
 * `/` still resolves exactly.
 */
export function deriveManifest(
  path: string,
  sectionPath: unknown,
): { manifestPath: string; docSlug: string } | null {
  const segs = path.split("/");
  if (!/^\d{4,}$/.test(segs[segs.length - 1] ?? "")) return null;
  const sections =
    Array.isArray(sectionPath) && sectionPath.length > 0
      ? sectionPath.map((s) => slugify(String(s)))
      : ["root"];
  const docIdx = segs.length - 2 - sections.length;
  if (docIdx < 1) return null;
  const actual = segs.slice(docIdx + 1, segs.length - 1);
  if (actual.join("/") !== sections.join("/")) return null;
  const docSlug = segs[docIdx];
  const namespace = segs.slice(0, docIdx).join("/");
  if (!docSlug || !namespace) return null;
  return { manifestPath: manifestPath(namespace, docSlug), docSlug };
}

/** Pure: group lineage-less chunk rows by document. */
export function buildBackfillPlan(rows: ChunkRow[]): BackfillPlan {
  const byManifest = new Map<string, DocPlan>();
  let skippedHasLineage = 0;
  let skippedNotChunk = 0;
  for (const row of rows) {
    if (Array.isArray(row.related_to) && row.related_to.length > 0) {
      skippedHasLineage++;
      continue;
    }
    const m = deriveManifest(row.path, row.section_path);
    if (!m) {
      skippedNotChunk++;
      continue;
    }
    let doc = byManifest.get(m.manifestPath);
    if (!doc) {
      doc = { manifestPath: m.manifestPath, docSlug: m.docSlug, chunkPaths: [] };
      byManifest.set(m.manifestPath, doc);
    }
    doc.chunkPaths.push(row.path);
  }
  const docs = [...byManifest.values()].sort((a, b) =>
    a.manifestPath.localeCompare(b.manifestPath),
  );
  return { docs, skippedHasLineage, skippedNotChunk };
}

export function formatPlan(plan: BackfillPlan): string {
  const lines = plan.docs.map(
    (d) => `  ${d.manifestPath}  ${d.chunkPaths.length} chunks`,
  );
  const total = plan.docs.reduce((n, d) => n + d.chunkPaths.length, 0);
  lines.push(
    `documents: ${plan.docs.length} | chunks: ${total} | skipped (already has lineage): ${plan.skippedHasLineage} | skipped (not chunk shape): ${plan.skippedNotChunk}`,
  );
  return lines.join("\n");
}

async function fetchRows(apiKey: string): Promise<ChunkRow[]> {
  const rows: ChunkRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const res = await fetch(
      `${SUPABASE_URL}/kb_entries?type=eq.ingested&qualifier=eq.pdf&select=path,related_to,section_path&order=path&limit=${PAGE}&offset=${offset}`,
      { headers: supabaseHeaders(apiKey), signal: AbortSignal.timeout(30_000) },
    );
    if (!res.ok) throw new Error(`read failed: HTTP ${res.status}`);
    const page = (await res.json()) as ChunkRow[];
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

/**
 * Manifest row body. No `related_to` (a manifest is a source, not a
 * dependent); `stale: true` like a live manifest, so it never surfaces in
 * search.
 */
export function manifestRow(doc: DocPlan, content: string): Record<string, unknown> {
  return {
    path: doc.manifestPath,
    title: `${doc.docSlug} (manifest)`,
    content,
    content_hash: contentHash(content),
    type: "ingested",
    qualifier: "pdf",
    tags: ["pdf", "manifest", "backfilled"],
    stale: true,
    updated_at: new Date().toISOString(),
  };
}

export async function applyDoc(doc: DocPlan, apiKey: string): Promise<boolean> {
  const content = `backfilled manifest: ${doc.docSlug}, ${doc.chunkPaths.length} chunks`;
  const up = await fetch(`${SUPABASE_URL}/kb_entries?on_conflict=path`, {
    method: "POST",
    headers: {
      ...supabaseHeaders(apiKey),
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(manifestRow(doc, content)),
    signal: AbortSignal.timeout(30_000),
  });
  if (!up.ok) {
    console.error(`  manifest upsert failed for ${doc.manifestPath}: HTTP ${up.status}`);
    return false;
  }
  for (let i = 0; i < doc.chunkPaths.length; i += PATCH_BATCH) {
    const list = doc.chunkPaths
      .slice(i, i + PATCH_BATCH)
      .map((p) => `"${p.replace(/["\\]/g, "\\$&")}"`)
      .join(",");
    const res = await fetch(
      `${SUPABASE_URL}/kb_entries?path=in.(${encodeURIComponent(list)})`,
      {
        method: "PATCH",
        headers: { ...supabaseHeaders(apiKey), Prefer: "return=minimal" },
        body: JSON.stringify({ related_to: [doc.manifestPath] }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!res.ok) {
      console.error(`  PATCH failed for ${doc.manifestPath}: HTTP ${res.status}`);
      return false;
    }
  }
  return true;
}

async function main(): Promise<void> {
  requireOperatorContext("backfill-kb-lineage", { tty: false });
  const apply = process.argv.includes("--apply");
  const apiKey = getApiKey();
  if (!apiKey) {
    console.error("COMMIT_DB_KEY is not set in this shell's environment.");
    process.exit(1);
  }
  const { failed } = await runBackfill(apiKey, apply);
  if (failed > 0) process.exit(1);
}

/** Read → plan → (with `apply`) write each document. Dry run is GET-only. */
export async function runBackfill(
  apiKey: string,
  apply: boolean,
): Promise<{ plan: BackfillPlan; done: number; failed: number }> {
  const plan = buildBackfillPlan(await fetchRows(apiKey));
  console.log(formatPlan(plan));
  let done = 0;
  let failed = 0;
  if (!apply) {
    console.log("dry run: nothing written (pass --apply to write)");
    return { plan, done, failed };
  }
  for (const doc of plan.docs) {
    if (await applyDoc(doc, apiKey)) done++;
    else {
      failed++;
      console.error(`  FAILED: ${doc.manifestPath}`);
    }
  }
  console.log(`applied: ${done} documents | failed: ${failed}`);
  return { plan, done, failed };
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
if (
  process.argv[1] !== undefined &&
  real(fileURLToPath(import.meta.url)) === real(process.argv[1])
) {
  main().catch((err) => {
    console.error(`backfill-kb-lineage: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
