/**
 * Outcome tracker — records task outcomes after completion.
 *
 * Writes structured outcomes to SQLite (for fast classifier queries)
 * and semantic summaries to Hindsight (for mental model evolution).
 *
 * Also manages a 2-minute feedback window: if the user sends a follow-up
 * shortly after a response, it may indicate the response was incomplete
 * or incorrect.
 */

import { recordOutcome, updateFeedback } from "../db/task-outcomes.js";
import { incrementSkillUsage } from "../db/skills.js";
import { getTask } from "../dispatch/dispatcher.js";
import { getMemoryService } from "../memory/index.js";

const FEEDBACK_WINDOW_MS = 120_000; // 2 minutes

/** Active feedback windows: taskId → timer */
const feedbackWindows = new Map<string, ReturnType<typeof setTimeout>>();

/** The most recent completed taskId per channel (for feedback linking). */
const lastCompletedTask = new Map<string, string>();

/**
 * Track a completed task's outcome.
 * Called from router.handleTaskCompleted for messaging tasks.
 */
export function trackTaskOutcome(
  taskId: string,
  durationMs: number,
  success: boolean,
  channel: string,
): void {
  try {
    const task = getTask(taskId);
    if (!task) return;

    const classification = task.classification
      ? JSON.parse(task.classification)
      : null;

    // Extract tools used from task output/metadata
    const toolsUsed = extractToolsUsed(task.output);

    const tags = task.metadata
      ? (() => {
          try {
            const meta = JSON.parse(task.metadata as string);
            return meta.tags ?? [];
          } catch {
            return [];
          }
        })()
      : [];

    // Write to SQLite
    recordOutcome({
      task_id: taskId,
      classified_as: classification?.agentType ?? task.agent_type ?? "unknown",
      ran_on: task.agent_type ?? "unknown",
      tools_used: toolsUsed,
      duration_ms: durationMs,
      success,
      tags,
    });

    // Write semantic summary to Hindsight
    const memory = getMemoryService();
    if (memory.backend === "hindsight") {
      const summary =
        `Task "${task.title}" classified as ${classification?.agentType ?? "unknown"} ` +
        `(score: ${classification?.score ?? "?"}), ran on ${task.agent_type} runner. ` +
        `Duration: ${durationMs}ms. Success: ${success}. ` +
        `Tools used: ${toolsUsed.join(", ") || "none"}.`;

      memory
        .retain(summary, {
          bank: "mc-operational",
          tags: ["outcome", task.agent_type ?? "unknown"],
          async: true,
          trustTier: 4, // unverified — mechanical task summary
          source: "system",
        })
        .catch(() => {});
    }

    // Update skill usage if skills were matched
    updateSkillTracking(tags, success);

    // Check for recurring patterns (may propose new skills)
    detectRecurringPatternsAsync();

    // Start feedback window
    startFeedbackWindow(taskId, channel);
  } catch (err) {
    console.warn(
      `[outcome-tracker] Failed to track outcome for ${taskId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Start a 2-minute feedback window for a completed task.
 * If a follow-up arrives in this window, it may signal response quality.
 */
function startFeedbackWindow(taskId: string, channel: string): void {
  // Clear any existing window for this channel
  const prevTaskId = lastCompletedTask.get(channel);
  if (prevTaskId) {
    const prevTimer = feedbackWindows.get(prevTaskId);
    if (prevTimer) clearTimeout(prevTimer);
    feedbackWindows.delete(prevTaskId);
  }

  lastCompletedTask.set(channel, taskId);

  const timer = setTimeout(() => {
    feedbackWindows.delete(taskId);
    // If window expires without follow-up, no signal recorded
  }, FEEDBACK_WINDOW_MS);

  feedbackWindows.set(taskId, timer);
}

/**
 * Check if an inbound message falls within a feedback window.
 * Returns the taskId it's feedback for, or null.
 */
export function checkFeedbackWindow(channel: string): string | null {
  const taskId = lastCompletedTask.get(channel);
  if (!taskId) return null;
  if (!feedbackWindows.has(taskId)) return null;

  // Close the window
  const timer = feedbackWindows.get(taskId)!;
  clearTimeout(timer);
  feedbackWindows.delete(taskId);
  lastCompletedTask.delete(channel);

  return taskId;
}

/**
 * Record feedback for a task outcome.
 */
export function recordTaskFeedback(
  taskId: string,
  signal: "positive" | "negative" | "rephrase" | "neutral",
): void {
  try {
    updateFeedback(taskId, signal);
  } catch {
    // Non-fatal
  }
}

/** Extract tool names from task output JSON. */
function extractToolsUsed(output: string | null): string[] {
  if (!output) return [];
  try {
    const parsed = JSON.parse(output);
    // Fast runner stores tool calls as string[] or { name }[]
    if (Array.isArray(parsed.toolCalls)) {
      const names = parsed.toolCalls.map((t: string | { name: string }) =>
        typeof t === "string" ? t : t.name,
      ) as string[];
      return [...new Set(names)];
    }
    // Prometheus stores in trace
    if (parsed.trace && Array.isArray(parsed.trace)) {
      const tools: string[] = [];
      for (const e of parsed.trace) {
        if (e?.type === "tool_call" && typeof e?.tool === "string") {
          tools.push(e.tool);
        }
      }
      return [...new Set(tools)];
    }
  } catch {
    // Output not JSON — no tools
  }
  return [];
}

/** Update skill usage counters for any matched skills in tags. */
function updateSkillTracking(tags: string[], success: boolean): void {
  for (const tag of tags) {
    if (tag.startsWith("skill:")) {
      const skillId = tag.slice(6);
      try {
        incrementSkillUsage(skillId, success);
      } catch {
        // Non-fatal — skill may have been deleted
      }
    }
  }
}

/** Fire-and-forget wrapper for skill discovery. */
function detectRecurringPatternsAsync(): void {
  import("./skill-discovery.js")
    .then((mod) => mod.detectRecurringPatterns())
    .catch(() => {});
}

/** Cleanup all timers (for shutdown). */
export function clearAllFeedbackWindows(): void {
  for (const timer of feedbackWindows.values()) {
    clearTimeout(timer);
  }
  feedbackWindows.clear();
  lastCompletedTask.clear();
}
