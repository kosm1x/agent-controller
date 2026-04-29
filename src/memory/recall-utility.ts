/**
 * Recall utility instrumentation — answers "was this recall actually used?"
 *
 * Workflow:
 *   1. logRecall() inserts a row at recall time with {bank, query, source,
 *      result_snippets, latency_ms}, was_used=NULL, task_id=NULL.
 *   2. markRecallUtility() runs at turn end (router auto-persist hook). Given
 *      the final assistant text + taskId, it claims unmatched rows from the
 *      last MATCH_WINDOW_MS, substring-matches snippets against the text, and
 *      writes was_used + used_count + task_id + checked_at.
 *
 * Aggregates are queryable via mc-ctl recall-utility. The signal is directional
 * (text-substring overlap), not perfect — agents that paraphrase recalled
 * content will register as "unused" even when the recall informed them. Used
 * to compare cohorts (Hindsight vs sqlite-fallback), not as ground truth.
 */

import { getDatabase, writeWithRetry } from "../db/index.js";
import type { MemoryItem } from "./types.js";

/** Time window for claiming unmatched recall rows during a turn-end sweep. */
export const MATCH_WINDOW_MS = 60_000;

/**
 * Minimum snippet length to consider for substring matching.
 *
 * Floor was raised 30 → 50 (qa-auditor W2, 2026-04-29) because 30-char
 * snippets like "the user mentioned the migration" trivially match across
 * unrelated turns and inflate was_used. 50 chars is short enough to fit a
 * single distinctive sentence fragment, long enough that boilerplate-only
 * matches collapse to was_used=0. Calibrate against 2 weeks of data before
 * trusting the headline ratio.
 */
export const SNIPPET_MIN_CHARS = 50;

/** Snippet cap — long enough to be specific, short enough to survive truncation. */
export const SNIPPET_MAX_CHARS = 80;

/** Per-result snippets to fingerprint. Most memories yield 1-2 useful chunks. */
const MAX_SNIPPETS_PER_RESULT = 2;

/**
 * Max recall rows to log/match per turn — sanity ceiling against runaway loops.
 * Note (qa-auditor W6, 2026-04-29): if a swarm runner exceeds this in 60s, the
 * surplus rows stay was_used=NULL forever. Acceptable today (organic traffic
 * < 5 recalls/turn). Add a periodic reaper if NULL backlog grows visibly via
 * `mc-ctl recall-utility`.
 */
const MAX_ROWS_PER_SWEEP = 50;

/**
 * Strip well-known credential patterns out of strings before they hit mc.db.
 * Defense-in-depth (qa-auditor W3, 2026-04-29) — user may paste secrets in
 * chat that flow into recall queries / source memories. Replace with marker
 * so we still see the structure but lose the value.
 */
const SECRET_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /sk-[A-Za-z0-9-]{20,}/g, label: "[REDACTED-OPENAI-LIKE]" },
  { re: /sk-ant-[A-Za-z0-9-]{20,}/g, label: "[REDACTED-ANTHROPIC]" },
  { re: /AKIA[0-9A-Z]{16}/g, label: "[REDACTED-AWS-AKID]" },
  { re: /AIza[0-9A-Za-z_-]{35}/g, label: "[REDACTED-GOOGLE-API]" },
  { re: /ghp_[0-9A-Za-z]{36}/g, label: "[REDACTED-GITHUB-PAT]" },
  {
    re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    label: "[REDACTED-JWT]",
  },
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const { re, label } of SECRET_PATTERNS) {
    out = out.replace(re, label);
  }
  return out;
}

/** Normalize whitespace + cap length, used on queries before insert. */
function sanitizeQuery(text: string, max = 500): string {
  return redactSecrets(text).replace(/\s+/g, " ").trim().slice(0, max);
}

interface LogRecallInput {
  bank: string;
  query: string;
  /** Where the recall results came from. */
  source: "hindsight" | "sqlite-fallback" | "sqlite-only" | "circuit-open";
  /** Results AFTER the outcome filter has run. result_count and snippets in
   * the audit row reflect what the agent saw, not what the vendor returned. */
  results: MemoryItem[];
  latencyMs: number;
  /** Count of vendor results dropped by the recall-side outcome filter. */
  excludedCount?: number;
}

/**
 * Strip common framing prefixes from memory content so snippets stay distinctive.
 * Examples removed:
 *   "[AUTO-PERSIST task=abc...]\nUser: "
 *   "User: ... Jarvis: "
 */
const PREFIX_STRIP = [
  /^\[AUTO-PERSIST[^\]]*\]\s*/i,
  /^User:\s+/i,
  /^Jarvis:\s+/i,
  /^Usuario:\s+/i,
];

function stripPrefix(text: string): string {
  let cleaned = text.trim();
  for (const re of PREFIX_STRIP) {
    cleaned = cleaned.replace(re, "");
  }
  return cleaned.trim();
}

/**
 * Derive up to MAX_SNIPPETS_PER_RESULT distinctive substrings from a memory.
 * - Snippet 1: first SNIPPET_MAX_CHARS chars after prefix strip
 * - Snippet 2: middle window (skips repetitive headers, more discriminating)
 * Returns [] when content is too short to fingerprint reliably.
 */
export function deriveSnippets(content: string): string[] {
  // Redact secrets BEFORE prefix-stripping so we never emit a fingerprint
  // containing a credential the user pasted into chat (qa-auditor W3).
  const cleaned = stripPrefix(redactSecrets(content));
  if (cleaned.length < SNIPPET_MIN_CHARS) return [];

  const snippets: string[] = [];

  // Snippet 1 — head
  snippets.push(cleaned.slice(0, SNIPPET_MAX_CHARS));

  // Snippet 2 — middle (only if content long enough to have a distinct middle)
  if (
    cleaned.length >= SNIPPET_MAX_CHARS * 2 &&
    snippets.length < MAX_SNIPPETS_PER_RESULT
  ) {
    const mid = Math.floor(cleaned.length / 2) - SNIPPET_MAX_CHARS / 2;
    snippets.push(cleaned.slice(mid, mid + SNIPPET_MAX_CHARS));
  }

  return [...new Set(snippets.map((s) => s.trim()))].filter(
    (s) => s.length >= SNIPPET_MIN_CHARS,
  );
}

/**
 * Insert a recall_audit row capturing what came back from a recall call.
 * Fire-and-forget — never throws to the caller; logs and returns on failure.
 */
export function logRecall(input: LogRecallInput): void {
  try {
    const db = getDatabase();

    const allSnippets: string[] = [];
    for (const r of input.results) {
      if (allSnippets.length >= MAX_SNIPPETS_PER_RESULT * 10) break;
      for (const s of deriveSnippets(r.content)) {
        if (allSnippets.length >= MAX_SNIPPETS_PER_RESULT * 10) break;
        allSnippets.push(s);
      }
    }

    writeWithRetry(() =>
      db
        .prepare(
          `INSERT INTO recall_audit
             (bank, query, source, result_count, result_snippets, latency_ms, excluded_count)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.bank,
          sanitizeQuery(input.query),
          input.source,
          input.results.length,
          JSON.stringify(allSnippets),
          input.latencyMs,
          input.excludedCount ?? 0,
        ),
    );
  } catch (err) {
    // Instrumentation must never break the recall path
    console.warn(
      "[recall-audit] logRecall failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

interface MarkUtilityInput {
  taskId: string;
  responseText: string;
  /** Override the default 60s window — useful for tests. */
  windowMs?: number;
  /** Override the now() reference — useful for tests. */
  nowMs?: number;
}

interface MarkUtilityResult {
  /** Number of recall_audit rows updated. */
  updated: number;
  /** Of those, how many had any snippet match. */
  used: number;
}

/**
 * Claim unmatched recall_audit rows from the last MATCH_WINDOW_MS, substring-
 * match each row's snippets against responseText, and write was_used + task_id.
 *
 * Matching is case-insensitive substring. A row is `used` iff at least one
 * snippet appears verbatim in the response. used_count counts how many of
 * the row's snippets matched.
 */
export function markRecallUtility(input: MarkUtilityInput): MarkUtilityResult {
  const { taskId, responseText, windowMs, nowMs } = input;
  const db = getDatabase();

  const window = windowMs ?? MATCH_WINDOW_MS;
  const cutoffMs = (nowMs ?? Date.now()) - window;
  const cutoffIso = new Date(cutoffMs)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);

  let rows: Array<{ id: number; result_snippets: string }>;
  try {
    rows = db
      .prepare(
        `SELECT id, result_snippets FROM recall_audit
         WHERE was_used IS NULL AND created_at >= ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(cutoffIso, MAX_ROWS_PER_SWEEP) as Array<{
      id: number;
      result_snippets: string;
    }>;
  } catch (err) {
    console.warn(
      "[recall-audit] sweep query failed:",
      err instanceof Error ? err.message : err,
    );
    return { updated: 0, used: 0 };
  }

  if (rows.length === 0) return { updated: 0, used: 0 };

  const responseLower = responseText.toLowerCase();
  const update = db.prepare(
    `UPDATE recall_audit
     SET was_used = ?, used_count = ?, task_id = ?, checked_at = datetime('now')
     WHERE id = ? AND was_used IS NULL`,
  );

  let updated = 0;
  let used = 0;

  for (const row of rows) {
    let snippets: string[];
    try {
      snippets = JSON.parse(row.result_snippets);
      if (!Array.isArray(snippets)) snippets = [];
    } catch {
      snippets = [];
    }

    let matchCount = 0;
    for (const s of snippets) {
      if (
        typeof s === "string" &&
        s.length >= SNIPPET_MIN_CHARS &&
        responseLower.includes(s.toLowerCase())
      ) {
        matchCount++;
      }
    }

    const wasUsed = matchCount > 0 ? 1 : 0;
    try {
      const result = writeWithRetry(() =>
        update.run(wasUsed, matchCount, taskId, row.id),
      );
      if (result.changes > 0) {
        updated++;
        if (wasUsed) used++;
      }
    } catch (err) {
      console.warn(
        "[recall-audit] update failed for row",
        row.id,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return { updated, used };
}
