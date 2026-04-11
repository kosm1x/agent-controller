/**
 * Essential Facts Layer (v6.5 M2) — compact identity/context block for LLM wake-up.
 *
 * Selects top memories by composite score (trust × recency × reinforcement)
 * and formats them as a ~150-200 token block injected into every chat system prompt.
 * Inspired by mempalace's L0+L1 layered wake-up pattern.
 *
 * Cache: refreshed every 5 minutes to avoid recomputing per request.
 */

import { getDatabase } from "../db/index.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ESSENTIALS_LIMIT = 12;
const CACHE_TTL_MS = 5 * 60_000; // 5 minutes
const MAX_CHARS = 1200; // ~300 tokens hard cap

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

let cachedBlock: string | null = null;
let cacheTimestamp = 0;

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Composite score: trust weight × recency × reinforcement bonus.
 * Higher = more essential. Tier 1 verified facts from recent days dominate.
 */
function scoreMemory(
  trustTier: number,
  ageDays: number,
  accessCount: number,
): number {
  const trustWeight = [0, 1.0, 0.8, 0.6, 0.4][trustTier] ?? 0.4;
  const recency = 1 / (1 + ageDays / 30);
  const reinforcement = 1 + Math.min(accessCount, 10) * 0.1;
  return trustWeight * recency * reinforcement;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get a compact block of essential facts for system prompt injection.
 * Returns empty string if no memories exist.
 */
export function getEssentialFacts(bank = "mc-jarvis"): string {
  const now = Date.now();
  if (cachedBlock !== null && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedBlock;
  }

  try {
    const db = getDatabase();

    // Fetch recent high-trust memories with access metadata
    const rows = db
      .prepare(
        `SELECT c.content, c.trust_tier, c.created_at,
                (SELECT COUNT(*) FROM conversation_embeddings ce WHERE ce.conversation_id = c.id) as has_embed
         FROM conversations c
         WHERE c.bank = ? AND c.trust_tier <= 2
         ORDER BY c.trust_tier ASC, c.created_at DESC
         LIMIT 100`,
      )
      .all(bank) as Array<{
      content: string;
      trust_tier: number;
      created_at: string;
      has_embed: number;
    }>;

    if (rows.length === 0) {
      cachedBlock = "";
      cacheTimestamp = now;
      return "";
    }

    // Score and rank
    const scored = rows.map((r) => {
      const ageDays = Math.max(
        0,
        (now - new Date(r.created_at + "Z").getTime()) / 86_400_000,
      );
      return {
        content: r.content,
        score: scoreMemory(r.trust_tier, ageDays, r.has_embed),
      };
    });

    scored.sort((a, b) => b.score - a.score);

    // Build compact block within character budget
    const lines: string[] = [];
    let totalChars = 0;
    for (const entry of scored.slice(0, ESSENTIALS_LIMIT)) {
      // Truncate individual entries to keep block compact
      const line =
        entry.content.length > 150
          ? entry.content.slice(0, 147) + "..."
          : entry.content;
      if (totalChars + line.length > MAX_CHARS) break;
      lines.push(`• ${line}`);
      totalChars += line.length;
    }

    if (lines.length === 0) {
      cachedBlock = "";
      cacheTimestamp = now;
      return "";
    }

    cachedBlock = `[Essential context — ${lines.length} key facts]\n${lines.join("\n")}`;
    cacheTimestamp = now;
    return cachedBlock;
  } catch {
    // Best-effort — don't crash the runner
    return "";
  }
}

/** Clear the cache (for testing or after memory changes). */
export function clearEssentialsCache(): void {
  cachedBlock = null;
  cacheTimestamp = 0;
}
