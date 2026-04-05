/**
 * Task Continuity — checkpoint persistence and recovery.
 *
 * When a task hits max_rounds, the runner writes a checkpoint so the user
 * can say "continúa" and Jarvis picks up where it left off.
 */

import { upsertFile, deleteFile, listFiles, getFile } from "../db/jarvis-fs.js";

const CHECKPOINT_PREFIX = "workspace/checkpoints/";
const CHECKPOINT_TTL_MS = 30 * 60_000; // 30 minutes

export interface Checkpoint {
  taskId: string;
  title: string;
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
}): void {
  const path = `${CHECKPOINT_PREFIX}${opts.taskId}.md`;
  const now = new Date().toISOString();

  const content = [
    `# Checkpoint: ${opts.title}`,
    ``,
    `**Task ID:** ${opts.taskId}`,
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
    console.warn(
      `[checkpoint] Failed to save:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Find the most recent checkpoint (within TTL).
 * Returns null if no checkpoint exists or it's expired.
 */
export function findRecentCheckpoint(): Checkpoint | null {
  try {
    const files = listFiles({
      prefix: CHECKPOINT_PREFIX,
      qualifier: "workspace",
    });
    if (files.length === 0) return null;

    // Find most recent
    const sorted = files.sort(
      (a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );
    const latest = sorted[0];

    // Check TTL
    const age = Date.now() - new Date(latest.updated_at).getTime();
    if (age > CHECKPOINT_TTL_MS) {
      // Expired — clean up
      deleteFile(latest.path);
      return null;
    }

    // Read full content for parsing
    const file = getFile(latest.path);
    if (!file) return null;
    return parseCheckpoint(latest.path, file.content);
  } catch {
    return null;
  }
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
