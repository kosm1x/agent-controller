/**
 * Task Continuity — checkpoint persistence and recovery.
 *
 * When a task hits max_rounds, the runner writes a checkpoint so the user
 * can say "continúa" and Jarvis picks up where it left off.
 */

import { upsertFile, deleteFile, listFiles, getFile } from "../db/jarvis-fs.js";
import { errMsg } from "../lib/err-msg.js";

const CHECKPOINT_PREFIX = "workspace/checkpoints/";
const CHECKPOINT_TTL_MS = 30 * 60_000; // 30 minutes

/**
 * Parse a timestamp string from SQLite (`datetime('now')` → naïve UTC like
 * `"2026-05-23 00:12:30"`) or from JS (`toISOString()` → `"...Z"`) into ms
 * since epoch. Idempotent: appends `Z` only when no timezone marker is
 * present. Prevents the production `TZ=America/Mexico_City` parsing drift
 * that turned a 30-min TTL into a 6.5h TTL on the lazy path (audit C1).
 */
function parseUtcTimestamp(s: string): number {
  const hasOffset = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(s);
  return new Date(hasOffset ? s : s + "Z").getTime();
}

export interface Checkpoint {
  taskId: string;
  title: string;
  /** Thread key of the originating conversation (R3 audit W3). Absent on
   *  checkpoints from writers that don't know it — those match any thread. */
  threadKey?: string;
  userMessage: string;
  toolsCalled: string[];
  scopeGroups: string[];
  exitReason: string;
  roundsCompleted: number;
  maxRounds: number;
  summary: string;
  createdAt: string;
}

/**
 * Write a checkpoint when a task is about to exit due to max_rounds or token_budget.
 */
export function writeCheckpoint(opts: {
  taskId: string;
  title: string;
  userMessage: string;
  toolsCalled: string[];
  scopeGroups: string[];
  exitReason: string;
  roundsCompleted: number;
  maxRounds: number;
  responseText: string;
  threadKey?: string;
}): void {
  const path = `${CHECKPOINT_PREFIX}${opts.taskId}.md`;
  const now = new Date().toISOString();

  const content = [
    `# Checkpoint: ${opts.title}`,
    ``,
    `**Task ID:** ${opts.taskId}`,
    ...(opts.threadKey ? [`**Thread:** ${opts.threadKey}`] : []),
    `**Exit reason:** ${opts.exitReason} (round ${opts.roundsCompleted}/${opts.maxRounds})`,
    `**Created:** ${now}`,
    ``,
    `## User's Original Request`,
    `${opts.userMessage}`,
    ``,
    `## What Was Done`,
    `Tools called: ${opts.toolsCalled.join(", ") || "none"}`,
    ``,
    `## What Was NOT Completed`,
    `The task ran out of rounds before finishing. The user needs to say "continúa" to resume.`,
    ``,
    `## Last Response (truncated)`,
    `${opts.responseText.slice(0, 1000)}`,
    ``,
    `## Scope Groups`,
    `${opts.scopeGroups.join(", ")}`,
  ].join("\n");

  try {
    upsertFile(
      path,
      `Checkpoint: ${opts.title}`,
      content,
      ["checkpoint"],
      "workspace",
      0,
    );
    console.log(
      `[checkpoint] Saved: ${path} (${opts.exitReason}, round ${opts.roundsCompleted}/${opts.maxRounds})`,
    );
  } catch (err) {
    console.warn(`[checkpoint] Failed to save:`, errMsg(err));
  }
}

/**
 * Find the most recent checkpoint (within TTL).
 * Returns null if no checkpoint exists or it's expired.
 */
export function findRecentCheckpoint(
  threadKey?: string,
): Checkpoint | null {
  try {
    const files = listFiles({
      prefix: CHECKPOINT_PREFIX,
      qualifier: "workspace",
    });
    if (files.length === 0) return null;

    // Find most recent. `parseUtcTimestamp` (module-level) is the audit
    // C1 fix — see the helper's docstring.
    const sorted = files.sort(
      (a, b) =>
        parseUtcTimestamp(b.updated_at) - parseUtcTimestamp(a.updated_at),
    );

    // Phase 4 R1 audit W3: a boot-written `orphaned_restart` checkpoint is
    // an empty shell (no tools, no partial). When a richer runner-written
    // checkpoint is also live, prefer it — newest non-orphan first, orphan
    // only as fallback. Expired entries are pruned as encountered.
    let orphanFallback: Checkpoint | null = null;
    for (const entry of sorted) {
      const age = Date.now() - parseUtcTimestamp(entry.updated_at);
      if (age > CHECKPOINT_TTL_MS) {
        deleteFile(entry.path);
        continue;
      }
      const file = getFile(entry.path);
      if (!file) continue;
      const cp = parseCheckpoint(entry.path, file.content);
      if (!cp) continue;
      // R3 audit W3: a checkpoint stamped for another thread is invisible
      // here — sender A's "continúa" must not resume sender B's task. A
      // stamp of just the channel matches every thread on that channel
      // (the boot-orphan writer only knows the channel). Unstamped rows
      // (legacy + runner writers without thread context) match any.
      if (
        cp.threadKey &&
        threadKey &&
        cp.threadKey !== threadKey &&
        !threadKey.startsWith(cp.threadKey + ":")
      ) {
        continue;
      }
      if (cp.exitReason !== "orphaned_restart") return cp;
      if (!orphanFallback) orphanFallback = cp;
    }
    return orphanFallback;
  } catch {
    return null;
  }
}

/**
 * Bulk-delete checkpoints whose `updated_at` is older than the TTL. Returns
 * the count deleted. Companion to `pruneExpiredSnapshots` in
 * `prometheus/snapshot.ts`; both are driven from
 * `runners/checkpoint-prune-cron.ts`.
 *
 * Why: `findRecentCheckpoint` enforces TTL lazily (only when picking up a
 * "continúa"). If the user never says continúa, the file lingers in
 * `jarvis_files` AND on the FS mirror AND in pgvector. `deleteFile`
 * propagates to all three, so this prune cleans every layer.
 *
 * Best-effort: per-file delete failures are logged and counted but do not
 * abort the sweep.
 *
 * @param ttlMs optional override (defaults to CHECKPOINT_TTL_MS = 30 min).
 */
export function pruneExpiredCheckpoints(
  ttlMs: number = CHECKPOINT_TTL_MS,
): number {
  let deleted = 0;
  try {
    const files = listFiles({
      prefix: CHECKPOINT_PREFIX,
      qualifier: "workspace",
    });
    const cutoffMs = Date.now() - ttlMs;
    for (const f of files) {
      const updatedMs = parseUtcTimestamp(f.updated_at);
      if (!Number.isFinite(updatedMs) || updatedMs > cutoffMs) continue;
      try {
        deleteFile(f.path);
        deleted++;
      } catch (err) {
        console.warn(`[checkpoint] prune failed for ${f.path}: ${errMsg(err)}`);
      }
    }
  } catch (err) {
    console.warn(
      `[checkpoint] pruneExpiredCheckpoints listFiles failed: ${errMsg(err)}`,
    );
  }
  return deleted;
}

/**
 * Delete a checkpoint after successful continuation.
 */
export function clearCheckpoint(taskId: string): void {
  const path = `${CHECKPOINT_PREFIX}${taskId}.md`;
  try {
    deleteFile(path);
    console.log(`[checkpoint] Cleared: ${path}`);
  } catch {
    // non-fatal
  }
}

/**
 * Parse a checkpoint markdown file into structured data.
 */
function parseCheckpoint(_path: string, content: string): Checkpoint | null {
  try {
    const taskIdMatch = content.match(/\*\*Task ID:\*\*\s*(.+)/);
    const threadMatch = content.match(/\*\*Thread:\*\*\s*(.+)/);
    const exitMatch = content.match(
      /\*\*Exit reason:\*\*\s*(\S+)\s*\(round (\d+)\/(\d+)\)/,
    );
    const createdMatch = content.match(/\*\*Created:\*\*\s*(.+)/);
    const userMsgMatch = content.match(
      /## User's Original Request\n([\s\S]*?)(?=\n## )/,
    );
    const toolsMatch = content.match(/Tools called:\s*(.+)/);
    const scopeMatch = content.match(/## Scope Groups\n(.+)/);
    const summaryMatch = content.match(
      /## Last Response \(truncated\)\n([\s\S]*?)(?=\n## )/,
    );

    if (!taskIdMatch) return null;

    return {
      taskId: taskIdMatch[1].trim(),
      ...(threadMatch ? { threadKey: threadMatch[1].trim() } : {}),
      title: content.match(/^# Checkpoint:\s*(.+)/m)?.[1]?.trim() ?? "Unknown",
      userMessage: userMsgMatch?.[1]?.trim() ?? "",
      toolsCalled: (toolsMatch?.[1] ?? "").split(", ").filter(Boolean),
      scopeGroups: (scopeMatch?.[1] ?? "").split(", ").filter(Boolean),
      exitReason: exitMatch?.[1] ?? "unknown",
      roundsCompleted: parseInt(exitMatch?.[2] ?? "0"),
      maxRounds: parseInt(exitMatch?.[3] ?? "35"),
      summary: summaryMatch?.[1]?.trim() ?? "",
      createdAt: createdMatch?.[1]?.trim() ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
