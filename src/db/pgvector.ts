/**
 * pgvector KB client — raw PostgREST operations on kb_entries table.
 *
 * No SDK dependency. Uses fetch to Supabase REST API.
 * Provides: upsert, delete, search (vector + full-text hybrid),
 * access tracking, and retention scoring queries.
 */

import { createHash } from "crypto";

const SUPABASE_URL = "https://db.mycommit.net/rest/v1";
const RPC_URL = "https://db.mycommit.net/rest/v1/rpc";

export function getApiKey(): string | null {
  return process.env.COMMIT_DB_KEY ?? null;
}

export function supabaseHeaders(apiKey: string): Record<string, string> {
  return {
    apikey: apiKey,
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

/** SHA-256 content hash for dedup (M1 lesson fingerprinting). */
export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KbEntry {
  id?: string;
  path: string;
  title: string;
  content: string;
  content_hash?: string;
  embedding?: number[];
  type?: string;
  qualifier?: string;
  condition?: string;
  tags?: string[];
  priority?: number;
  salience?: number;
  confidence?: number;
  reinforcement_count?: number;
  access_count?: number;
  last_accessed_at?: string;
  last_reinforced_at?: string;
  stale?: boolean;
  source_task_id?: string;
  related_to?: string[];
  created_at?: string;
  updated_at?: string;
}

export interface SearchResult {
  id: string;
  path: string;
  title: string;
  content: string;
  type: string;
  qualifier: string;
  similarity: number;
  fts_rank: number;
  combined_score: number;
  salience: number;
  confidence: number;
  stale: boolean;
}

// ---------------------------------------------------------------------------
// Quality gate (SAGE pattern: pre-validation before memory writes)
// ---------------------------------------------------------------------------

/** Noise patterns that should never be stored as KB entries. */
const NOISE_PATTERNS = [
  /^(user said hi|user greeted|session started|brain online|no action taken)\s*[.!]?$/i,
  /^(hola|hello|hi|gracias|thanks|ok|sí|yes|no)\s*[.!]?$/i,
  /^(buenos días|buenas tardes|buenas noches)\s*[.!]?$/i,
  /^recibido\s*[.!]?$/i,
];

/**
 * Validate a KB entry before upserting. Rejects:
 * - Content too short (<20 chars for facts, <10 for corrections)
 * - Greeting/noise patterns
 * - Facts with low confidence (<0.3)
 * - Empty titles
 *
 * Returns null if valid, or a rejection reason string.
 */
export function validateKbEntry(entry: KbEntry): string | null {
  const content = entry.content?.trim() ?? "";
  const minLen = entry.type === "correction" ? 10 : 20;

  if (content.length < minLen) {
    return `content too short (${content.length} chars, min ${minLen})`;
  }

  if (!entry.title?.trim()) {
    return "empty title";
  }

  // Noise detection
  for (const pattern of NOISE_PATTERNS) {
    if (pattern.test(content)) {
      return `noise pattern: "${content.slice(0, 40)}"`;
    }
  }

  // Confidence threshold for facts
  const confidence = entry.confidence ?? 1.0;
  if (entry.type === "fact" && confidence < 0.3) {
    return `fact confidence too low (${confidence.toFixed(2)}, min 0.3)`;
  }

  return null; // valid
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Upsert a KB entry to pgvector. Merges on path (unique).
 * Pre-validates via quality gate — rejects noise before network call.
 * Non-blocking — returns success/failure, never throws.
 */
export async function pgUpsert(entry: KbEntry): Promise<boolean> {
  const apiKey = getApiKey();
  if (!apiKey) return false;

  // Quality gate: reject noise before upserting
  const rejection = validateKbEntry(entry);
  if (rejection) {
    console.log(`[pgvector] Quality gate rejected ${entry.path}: ${rejection}`);
    return false;
  }

  const newHash = entry.content_hash ?? contentHash(entry.content);

  const row = {
    path: entry.path,
    title: entry.title,
    content: entry.content,
    content_hash: newHash,
    embedding: entry.embedding ? `[${entry.embedding.join(",")}]` : null,
    type: entry.type ?? "fact",
    qualifier: entry.qualifier ?? "reference",
    condition: entry.condition ?? null,
    tags: entry.tags ?? [],
    priority: entry.priority ?? 50,
    salience: entry.salience ?? 0.5,
    confidence: entry.confidence ?? 1.0,
    stale: entry.stale ?? false,
    source_task_id: entry.source_task_id ?? null,
    related_to: entry.related_to ?? [],
    updated_at: new Date().toISOString(),
  };

  try {
    const res = await fetch(`${SUPABASE_URL}/kb_entries?on_conflict=path`, {
      method: "POST",
      headers: {
        ...supabaseHeaders(apiKey),
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify(row),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(
        `[pgvector] Upsert failed for ${entry.path}: ${res.status} ${text.slice(0, 200)}`,
      );
      return false;
    }

    // v6.4 G1: Cascade staleness — if content changed, mark related entries stale.
    // Fire-and-forget: staleness propagation shouldn't block the upsert caller.
    pgCascadeStale(entry.path, apiKey).catch((err) => {
      console.warn(
        `[pgvector] Cascade stale failed for ${entry.path}:`,
        err instanceof Error ? err.message : err,
      );
    });

    return true;
  } catch (err) {
    console.warn(
      `[pgvector] Upsert error for ${entry.path}:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Cascading staleness propagation (v6.4 G1).
 *
 * When an entry at `path` is superseded (content changed), find all entries
 * whose `related_to` array contains this path and mark them stale.
 * This ensures derived/dependent knowledge is flagged for re-evaluation
 * when its source changes.
 *
 * Uses PostgREST array containment operator: related_to @> [path]
 */
export async function pgCascadeStale(
  path: string,
  apiKey?: string,
): Promise<number> {
  const key = apiKey ?? getApiKey();
  if (!key) return 0;

  try {
    // Find entries whose related_to contains this path (PostgREST cs. operator)
    const searchRes = await fetch(
      `${SUPABASE_URL}/kb_entries?related_to=cs.{${encodeURIComponent(path)}}&stale=is.false&select=path`,
      {
        headers: supabaseHeaders(key),
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!searchRes.ok) return 0;
    const related = (await searchRes.json()) as Array<{ path: string }>;
    if (related.length === 0) return 0;

    // Mark them stale via PATCH
    const patchRes = await fetch(
      `${SUPABASE_URL}/kb_entries?related_to=cs.{${encodeURIComponent(path)}}&stale=is.false`,
      {
        method: "PATCH",
        headers: {
          ...supabaseHeaders(key),
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          stale: true,
          updated_at: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (patchRes.ok) {
      console.log(
        `[pgvector] Cascade stale: ${related.length} entries marked stale (source: ${path})`,
      );
    }
    return related.length;
  } catch {
    return 0;
  }
}

/**
 * Batch upsert multiple entries. Chunks to avoid payload limits.
 */
export async function pgBatchUpsert(
  entries: KbEntry[],
  batchSize = 20,
): Promise<{ success: number; failed: number }> {
  const apiKey = getApiKey();
  if (!apiKey) return { success: 0, failed: entries.length };

  let success = 0;
  let failed = 0;

  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    const rows = batch.map((e) => ({
      path: e.path,
      title: e.title,
      content: e.content,
      content_hash: e.content_hash ?? contentHash(e.content),
      embedding: e.embedding ? `[${e.embedding.join(",")}]` : null,
      type: e.type ?? "fact",
      qualifier: e.qualifier ?? "reference",
      condition: e.condition ?? null,
      tags: e.tags ?? [],
      priority: e.priority ?? 50,
      salience: e.salience ?? 0.5,
      confidence: e.confidence ?? 1.0,
      stale: e.stale ?? false,
      related_to: e.related_to ?? [],
      updated_at: new Date().toISOString(),
    }));

    try {
      const res = await fetch(`${SUPABASE_URL}/kb_entries?on_conflict=path`, {
        method: "POST",
        headers: {
          ...supabaseHeaders(apiKey),
          Prefer: "resolution=merge-duplicates",
        },
        body: JSON.stringify(rows),
        signal: AbortSignal.timeout(30_000),
      });

      if (res.ok) {
        success += batch.length;
      } else {
        console.warn(`[pgvector] Batch upsert failed: ${res.status}`);
        failed += batch.length;
      }
    } catch (err) {
      console.warn(
        `[pgvector] Batch error:`,
        err instanceof Error ? err.message : err,
      );
      failed += batch.length;
    }
  }

  return { success, failed };
}

/**
 * Delete a KB entry by path.
 */
export async function pgDelete(path: string): Promise<boolean> {
  const apiKey = getApiKey();
  if (!apiKey) return false;

  try {
    const res = await fetch(
      `${SUPABASE_URL}/kb_entries?path=eq.${encodeURIComponent(path)}`,
      {
        method: "DELETE",
        headers: supabaseHeaders(apiKey),
        signal: AbortSignal.timeout(10_000),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Hybrid search: vector similarity + full-text + salience weighting.
 * Calls the kb_hybrid_search Postgres function via RPC.
 */
export async function pgHybridSearch(
  queryEmbedding: number[],
  queryText: string,
  matchCount = 10,
  similarityThreshold = 0.3,
): Promise<SearchResult[]> {
  const apiKey = getApiKey();
  if (!apiKey) return [];

  try {
    const res = await fetch(`${RPC_URL}/kb_hybrid_search`, {
      method: "POST",
      headers: supabaseHeaders(apiKey),
      body: JSON.stringify({
        query_embedding: `[${queryEmbedding.join(",")}]`,
        query_text: queryText,
        match_count: matchCount,
        similarity_threshold: similarityThreshold,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      console.warn(`[pgvector] Search failed: ${res.status}`);
      return [];
    }

    return (await res.json()) as SearchResult[];
  } catch (err) {
    console.warn(
      `[pgvector] Search error:`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// Access tracking
// ---------------------------------------------------------------------------

/**
 * Increment access_count and update last_accessed_at for a KB entry.
 * Fire-and-forget — used by the enrichment pipeline on recall.
 */
export async function pgRecordAccess(path: string): Promise<void> {
  const apiKey = getApiKey();
  if (!apiKey) return;

  try {
    // Atomic server-side increment via RPC (C1 audit fix)
    await fetch(`${RPC_URL}/kb_record_access`, {
      method: "POST",
      headers: supabaseHeaders(apiKey),
      body: JSON.stringify({ p_path: path }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // Fire-and-forget
  }
}

/**
 * Check if a content hash already exists in the KB.
 * Used by M1 lesson fingerprinting to detect duplicates.
 */
export async function pgFindByHash(
  hash: string,
): Promise<{ path: string; confidence: number } | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  try {
    const res = await fetch(
      `${SUPABASE_URL}/kb_entries?content_hash=eq.${encodeURIComponent(hash)}&select=path,confidence&limit=1`,
      {
        headers: supabaseHeaders(apiKey),
        signal: AbortSignal.timeout(5_000),
      },
    );

    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{
      path: string;
      confidence: number;
    }>;
    return rows.length > 0 ? rows[0] : null;
  } catch {
    return null;
  }
}

/**
 * Strengthen an existing entry (M1 reinforcement pattern).
 * Atomic server-side: confidence += 0.1 * (1 - current), reinforcement_count++
 * (C2 audit fix: eliminates read-modify-write race condition)
 */
export async function pgReinforce(path: string): Promise<boolean> {
  const apiKey = getApiKey();
  if (!apiKey) return false;

  try {
    const res = await fetch(`${RPC_URL}/kb_reinforce`, {
      method: "POST",
      headers: supabaseHeaders(apiKey),
      body: JSON.stringify({ p_path: path }),
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Check if pgvector is available (COMMIT_DB_KEY configured).
 */
export function isPgvectorEnabled(): boolean {
  return !!getApiKey();
}
