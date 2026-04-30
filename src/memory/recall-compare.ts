/**
 * Recall comparison tool — Ship C (2026-04-30).
 *
 * Side-by-side replay of a query against both Hindsight and the SQLite
 * backend. Used by `mc-ctl recall-compare` to inform the 2026-05-13
 * HARDEN/DEMOTE/REPLACE strategic decision: real-traffic A/B of
 * retrieval quality, not a benchmark.
 *
 * Each backend is invoked in parallel with an explicit per-side timeout
 * so a slow Hindsight doesn't block the whole comparison. Results are
 * trimmed to top-N (default 3) — manual review is the eval signal, so
 * verbosity isn't useful.
 */

import { HindsightClient } from "./hindsight-client.js";
import { SqliteMemoryBackend } from "./sqlite-backend.js";
import type { MemoryBank, MemoryItem } from "./types.js";

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_TOP_N = 3;

export interface CompareSideResult {
  /** Top-N memory items returned. content trimmed to ~200 chars for display. */
  results: Array<{ content: string; tags?: string[] }>;
  /** Wall-clock latency observed for this side. */
  latencyMs: number;
  /** Total result count BEFORE top-N trim (so the caller knows what was filtered). */
  totalCount: number;
  /** If the backend errored or timed out. */
  error?: string;
}

export interface CompareResult {
  query: string;
  bank: MemoryBank;
  hindsight: CompareSideResult;
  sqlite: CompareSideResult;
}

export interface CompareOptions {
  /** Per-side timeout in ms. Default 8000. */
  timeoutMs?: number;
  /** Top-N results to return per side. Default 3. */
  topN?: number;
  /** Hindsight base URL override (else read from process.env at call time). */
  hindsightUrl?: string;
  /** Hindsight API key override. */
  hindsightApiKey?: string;
}

/** Trim memory content to a display-safe length without losing fingerprint. */
function trimContent(text: string, max = 200): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

/**
 * Wrap a promise with a timeout that resolves to an error sentinel.
 * The timer is always cleared on settle — without this, two pending
 * timers per call (Hindsight + SQLite) keep the event loop alive for
 * up to `timeoutMs` after a successful real-result path, blocking
 * clean process exit and accumulating handle pressure under load.
 * (qa-auditor W1, 2026-04-30 — class previously seen in v6.4 H1-H3.)
 */
function withTimeout<T>(
  p: Promise<T>,
  timeoutMs: number,
): Promise<T | { __timeout: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ __timeout: true }>((resolve) => {
    timer = setTimeout(() => resolve({ __timeout: true }), timeoutMs);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function runHindsight(
  query: string,
  bank: MemoryBank,
  topN: number,
  timeoutMs: number,
  url: string,
  apiKey?: string,
): Promise<CompareSideResult> {
  const start = Date.now();
  try {
    const client = new HindsightClient(url, apiKey);
    const result = await withTimeout(
      client.recall(bank, { query, budget: "mid" }),
      timeoutMs,
    );
    const latencyMs = Date.now() - start;
    if ("__timeout" in result) {
      return {
        results: [],
        latencyMs,
        totalCount: 0,
        error: `timeout after ${timeoutMs}ms`,
      };
    }
    const items = (result.results ?? []).map((r) => ({
      content: trimContent(r.text ?? ""),
      tags: r.tags ?? [],
    }));
    return {
      results: items.slice(0, topN),
      latencyMs,
      totalCount: items.length,
    };
  } catch (err) {
    return {
      results: [],
      latencyMs: Date.now() - start,
      totalCount: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runSqlite(
  query: string,
  bank: MemoryBank,
  topN: number,
  timeoutMs: number,
): Promise<CompareSideResult> {
  const start = Date.now();
  try {
    const sqlite = new SqliteMemoryBackend();
    const result = await withTimeout(
      sqlite.recall(query, { bank, maxResults: topN * 5 }),
      timeoutMs,
    );
    const latencyMs = Date.now() - start;
    if ("__timeout" in result) {
      return {
        results: [],
        latencyMs,
        totalCount: 0,
        error: `timeout after ${timeoutMs}ms`,
      };
    }
    const items = (result as MemoryItem[]).map((r) => ({
      content: trimContent(r.content ?? ""),
      tags: r.tags ?? [],
    }));
    return {
      results: items.slice(0, topN),
      latencyMs,
      totalCount: items.length,
    };
  } catch (err) {
    return {
      results: [],
      latencyMs: Date.now() - start,
      totalCount: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Run a query against both backends in parallel and return both top-N
 * result sets. Backends fail independently — a Hindsight timeout does
 * not affect the SQLite result.
 */
export async function compareBackends(
  query: string,
  bank: MemoryBank,
  options: CompareOptions = {},
): Promise<CompareResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const topN = options.topN ?? DEFAULT_TOP_N;
  const hindsightUrl =
    options.hindsightUrl ??
    process.env.HINDSIGHT_URL ??
    "http://localhost:8888";
  const hindsightApiKey =
    options.hindsightApiKey ?? process.env.HINDSIGHT_API_KEY;

  const [hindsight, sqlite] = await Promise.all([
    runHindsight(query, bank, topN, timeoutMs, hindsightUrl, hindsightApiKey),
    runSqlite(query, bank, topN, timeoutMs),
  ]);

  return { query, bank, hindsight, sqlite };
}
