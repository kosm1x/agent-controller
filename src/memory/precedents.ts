/**
 * Precedent retrieval — episodic memory keyed on TASK RECORDS.
 *
 * Agent-memory 5-layer plan, Phase 1 (docs/planning/agent-memory-5-layer-plan-
 * 2026-09-16.md). The paper's episodic layer answers "the last time this task
 * ran, what happened?" — Jarvis's existing episodic recall is free text over
 * the `mc-operational` conversation bank (565 recalls / 4 used in the 30 days
 * before this shipped). This module looks up similar PAST TASKS instead and
 * carries the validity signals the 2026-09-09 probe showed were missing:
 * the task's outcome, its Honest-Done gate verdict (`task_gates`), and whether
 * a later completed task with the same title superseded it.
 *
 * SHADOW MODE (this ship): precedents are computed and written to
 * `recall_audit` under bank `precedents` / source `precedents-shadow`, and
 * NOT injected into the prompt. The post-turn utility matcher then tells us
 * whether the reply re-derived what the precedent already said. Injection
 * (`inject` mode) lands only after the 14-day readout and an eval gate.
 *
 * Retrieval matches the user's message against past TITLES only. For root
 * `Chat:` tasks the title IS the request (first ~60 chars) — `description`
 * is the assembled system prompt (~24 KB per row) and `input` is empty, so
 * matching either would score boilerplate (qa audit C-1, 2026-09-16). Both
 * sides go through `extractContentTokens` (accent-folded, stopwords out).
 * No embeddings: `tasks` has no embedding column and embedding candidates
 * per turn would cost a network call per candidate. Revisit after the
 * readout, not before.
 */

import { getDatabase } from "../db/index.js";
import { errMsg } from "../lib/err-msg.js";
import { extractContentTokens, logRecall, redactSecrets } from "./recall-utility.js";
import type { MemoryItem } from "./types.js";

export type PrecedentOutcome = "success" | "concerns" | "failed" | "cancelled";
export type PrecedentGate = "met" | "failed" | "abandoned" | "pending" | "none";

export interface Precedent {
  taskId: string;
  /** Title with the `Chat: ` prefix stripped. */
  title: string;
  outcome: PrecedentOutcome;
  gate: PrecedentGate;
  /** task_id of a LATER completed task with the identical normalized title. */
  supersededBy: string | null;
  ageDays: number;
  /** Error text for failed tasks, otherwise the head of the output. */
  snippet: string;
  /** matched query tokens / query tokens, in (0, 1]. */
  score: number;
}

export type PrecedentsMode = "off" | "shadow";

/** `MEMORY_PRECEDENTS_MODE`: `off` | `shadow` (default). Any other value —
 * including `inject`, which is not implemented yet — folds to `shadow` so a
 * premature flip cannot change what the model sees. */
export function precedentsMode(env: NodeJS.ProcessEnv = process.env): PrecedentsMode {
  return env.MEMORY_PRECEDENTS_MODE === "off" ? "off" : "shadow";
}

/** Root `Chat:` tasks in the 90-day window number ~2,100 on the live DB
 * (2026-09-16); the cap is a safety rail, not a tuning knob. */
const CANDIDATE_LIMIT = 4000;
const MAX_QUERY_TOKENS = 12;
const SNIPPET_CHARS = 240;
const DEFAULT_WINDOW_DAYS = 90;
const CHAT_PREFIX_RE = /^Chat:\s*/i;

interface CandidateRow {
  task_id: string;
  title: string;
  status: string;
  created_at: string;
}

function outcomeOf(status: string): PrecedentOutcome {
  if (status === "completed") return "success";
  if (status === "completed_with_concerns") return "concerns";
  if (status === "cancelled") return "cancelled";
  return "failed";
}

function stripPrefix(title: string): string {
  return title.replace(CHAT_PREFIX_RE, "").trim();
}

function gateVerdict(states: string[]): PrecedentGate {
  if (states.length === 0) return "none";
  if (states.includes("failed")) return "failed";
  if (states.includes("abandoned")) return "abandoned";
  if (states.includes("pending")) return "pending";
  return "met";
}

function snippetOf(status: string, output: string | null, error: string | null): string {
  const raw = (status === "failed" && error) || output || error || "";
  const flat = redactSecrets(raw).replace(/\s+/g, " ").trim();
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS)}…` : flat;
}

export interface FindPrecedentsOptions {
  k?: number;
  /** The task being served — never its own precedent. */
  excludeTaskId?: string;
  windowDays?: number;
  /** Injectable clock for tests (ms since epoch). */
  now?: number;
}

/**
 * Top-k similar past chat tasks. Synchronous: one short-column scan of the
 * window's root `Chat:` tasks (task_id/title/status/created_at only), scored
 * in JS, then gate + snippet lookups for the k winners alone.
 *
 * Ordering: score desc, recency as tie-break, with SUPERSEDED precedents
 * moved last (they are stale by definition) — applied over the WHOLE scored
 * set, so a current row can never be cut by a stale one. Failed precedents
 * keep their score position — "it failed because X" is the highest-value
 * episode the paper describes — and are labeled, never hidden.
 */
export function findPrecedents(
  messageText: string,
  options: FindPrecedentsOptions = {},
): Precedent[] {
  const k = options.k ?? 3;
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = options.now ?? Date.now();
  const tokens = [...extractContentTokens(messageText)]
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_QUERY_TOKENS);
  // A single content token has no discriminating signal: live, 76 titles
  // share "verifica" — top-3 would be picked by recency alone at score 1.0.
  if (tokens.length < 2) return [];
  const MIN_MATCHES = 2;

  const db = getDatabase();
  const since = new Date(now - windowDays * 86_400_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");

  const rows = db
    .prepare(
      `SELECT task_id, title, status, created_at
         FROM tasks
        WHERE spawn_type = 'root'
          AND title LIKE 'Chat:%'
          AND status IN ('completed','completed_with_concerns','failed','cancelled')
          AND created_at >= ?
          AND task_id <> ?
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(since, options.excludeTaskId ?? "", CANDIDATE_LIMIT) as CandidateRow[];

  // Newest completed task per normalized title — rows arrive newest-first,
  // so the first completed row seen for a title is its newest. The key is
  // folded the same way matching is (accents, case, stopwords), so two
  // spellings of one request supersede each other.
  const titleKey = (title: string) => [...extractContentTokens(title)].sort().join(" ");
  const newestCompleted = new Map<string, { taskId: string; createdAt: string }>();
  for (const row of rows) {
    if (row.status !== "completed") continue;
    const key = titleKey(row.title);
    if (!newestCompleted.has(key)) {
      newestCompleted.set(key, { taskId: row.task_id, createdAt: row.created_at });
    }
  }

  const scored: { row: CandidateRow; score: number; supersededBy: string | null }[] = [];
  for (const row of rows) {
    const titleTokens = extractContentTokens(row.title);
    let matched = 0;
    for (const t of tokens) if (titleTokens.has(t)) matched++;
    if (matched < MIN_MATCHES) continue;
    const newest = newestCompleted.get(titleKey(row.title));
    const supersededBy =
      newest && newest.taskId !== row.task_id && newest.createdAt > row.created_at
        ? newest.taskId
        : null;
    scored.push({ row, score: matched / tokens.length, supersededBy });
  }
  // Stable sort keeps the newest-first arrival order as the tie-break.
  scored.sort((a, b) => b.score - a.score);
  const ordered = [
    ...scored.filter((s) => !s.supersededBy),
    ...scored.filter((s) => s.supersededBy),
  ].slice(0, k);

  const gateStmt = db.prepare(`SELECT state FROM task_gates WHERE task_id = ?`);
  const bodyStmt = db.prepare(`SELECT output, error FROM tasks WHERE task_id = ?`);

  return ordered.map(({ row, score, supersededBy }) => {
    let gate: PrecedentGate = "none";
    try {
      gate = gateVerdict(
        (gateStmt.all(row.task_id) as { state: string }[]).map((g) => g.state),
      );
    } catch {
      // task_gates absent (fresh DB) — verdict stays "none"
    }
    const body = bodyStmt.get(row.task_id) as
      | { output: string | null; error: string | null }
      | undefined;
    const createdMs = Date.parse(`${row.created_at.replace(" ", "T")}Z`);
    return {
      taskId: row.task_id,
      title: stripPrefix(row.title),
      outcome: outcomeOf(row.status),
      gate,
      supersededBy,
      ageDays: Number.isFinite(createdMs)
        ? Math.max(0, Math.round((now - createdMs) / 86_400_000))
        : 0,
      snippet: snippetOf(row.status, body?.output ?? null, body?.error ?? null),
      score,
    };
  });
}

/** One line per precedent — the shape a future `inject` mode would show the
 * model. */
export function formatPrecedent(p: Precedent): string {
  const tags = [
    `outcome:${p.outcome}`,
    `gate:${p.gate}`,
    p.supersededBy ? `superseded_by:${p.supersededBy}` : null,
    `${p.ageDays}d`,
  ]
    .filter(Boolean)
    .join(" ");
  return `[${tags}] ${p.title}${p.snippet ? ` → ${p.snippet}` : ""}`;
}

/**
 * Shadow-row content is the past task's OUTCOME text, not its title: the
 * title is by construction a near-copy of the current message, so a reply
 * that echoes the user's wording would score a false `was_used` hit (qa
 * audit W-5). Title is the fallback only when the task left no body.
 */
export function precedentsToMemoryItems(precedents: Precedent[]): MemoryItem[] {
  return precedents.map((p) => ({
    content: p.snippet || p.title,
    relevance: p.score,
    tags: [`outcome:${p.outcome}`, `gate:${p.gate}`, `task:${p.taskId}`],
  }));
}

/**
 * Shadow logger: compute precedents for a chat turn and write ONE
 * `recall_audit` row (bank `precedents`). Never throws, never awaited by the
 * caller — scheduled off the enrichment hot path with `setImmediate`. The
 * work itself is synchronous better-sqlite3, so `setImmediate` only moves it
 * after the current tick: it still stalls the event loop for its duration.
 * Measured live 2026-09-16 (read-only, 2,134 candidate rows): ~55 ms median
 * per call, once per chat turn (avg turn 77 s). The cost is the unindexed
 * scan of `tasks` (no index on spawn_type/created_at); an index is a schema
 * change and waits for the readout.
 * Writes nothing when there are no precedents: a zero-result row would
 * count as a "recall" the utility matcher can only ever score unused.
 */
export function shadowLogPrecedents(
  messageText: string,
  options: FindPrecedentsOptions = {},
): void {
  setImmediate(() => {
    try {
      const start = Date.now();
      const precedents = findPrecedents(messageText, options);
      if (precedents.length === 0) return;
      const breakdown = { success: 0, concerns: 0, failed: 0, unknown: 0 };
      for (const p of precedents) {
        if (p.outcome === "success") breakdown.success++;
        else if (p.outcome === "concerns") breakdown.concerns++;
        else if (p.outcome === "failed") breakdown.failed++;
        else breakdown.unknown++;
      }
      logRecall({
        bank: "precedents",
        query: messageText,
        source: "precedents-shadow",
        results: precedentsToMemoryItems(precedents),
        latencyMs: Date.now() - start,
        outcomeBreakdown: breakdown,
        topKIds: precedents.map((p) => p.taskId),
      });
    } catch (err) {
      console.warn("[precedents] shadow log failed:", errMsg(err));
    }
  });
}
