/**
 * ReactionManager — automated response to task failures.
 *
 * Subscribes to the event bus for task.failed events, evaluates reaction rules,
 * and executes responses: retry, adjusted retry, escalation, or suppression.
 * Also polls for stuck tasks (running >15 min with no progress).
 */

import type Database from "better-sqlite3";
import { getEventBus } from "../lib/event-bus.js";
import { getTask, submitTask } from "../dispatch/dispatcher.js";
import type { Subscription } from "../lib/events/types.js";
import type { ReactionContext } from "./types.js";
import { DEFAULT_RULES, evaluateRules } from "./rules.js";
import {
  ensureReactionsTable,
  recordReaction,
  countReactionsForTask,
  countRecentClassificationFailures,
  updateReactionStatus,
  getLatestReaction,
} from "./store.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STUCK_CHECK_INTERVAL_MS = 60_000; // 1 minute
const STUCK_THRESHOLD_MINUTES = 15;
const COOLDOWN_MS = 30_000; // 30 seconds between reactions for same task

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class ReactionManager {
  private subscription: Subscription | null = null;
  private stuckCheckInterval: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly db: Database.Database) {}

  /** Start the reaction engine: subscribe to events + start stuck-task polling. */
  start(): void {
    ensureReactionsTable(this.db);

    this.subscription = getEventBus().subscribe<"task.failed">(
      "task.failed",
      (event) => {
        const data = event.data as { task_id: string; error: string };
        this.handleTaskFailed(data.task_id, data.error).catch((err) => {
          console.error("[reactions] Error handling task.failed:", err);
        });
      },
    );

    this.stuckCheckInterval = setInterval(() => {
      this.checkStuckTasks();
    }, STUCK_CHECK_INTERVAL_MS);

    console.log("[mc] Reaction engine started");
  }

  /** Stop the reaction engine. */
  stop(): void {
    if (this.subscription) {
      this.subscription.unsubscribe();
      this.subscription = null;
    }
    if (this.stuckCheckInterval) {
      clearInterval(this.stuckCheckInterval);
      this.stuckCheckInterval = null;
    }
  }

  /** Handle a task.failed event. */
  private async handleTaskFailed(taskId: string, error: string): Promise<void> {
    const task = getTask(taskId);
    if (!task) return;

    // Skip swarm subtasks — the swarm runner manages its own children
    if (task.spawn_type === "subtask") return;

    // Cooldown check: don't react if we just reacted to this task
    const latest = getLatestReaction(this.db, taskId);
    if (latest) {
      const elapsed = Date.now() - new Date(latest.created_at).getTime();
      if (elapsed < COOLDOWN_MS) return;
    }

    // Build reaction context
    const previousAttempts = countReactionsForTask(this.db, taskId);
    let classifiedAs = "unknown";
    try {
      if (task.classification) {
        const parsed = JSON.parse(task.classification);
        classifiedAs = parsed.agentType ?? "unknown";
      }
    } catch {
      // Ignore parse errors
    }
    const classificationFailures24h = countRecentClassificationFailures(
      this.db,
      classifiedAs,
    );

    const ctx: ReactionContext = {
      task,
      error,
      previousAttempts,
      classificationFailures24h,
    };

    // Evaluate rules
    const match = evaluateRules(DEFAULT_RULES, ctx);
    if (!match) return;

    const { rule, decision } = match;
    console.log(
      `[reactions] Task ${taskId}: rule "${rule.name}" → ${decision.action} (${decision.reason})`,
    );

    // Execute the reaction
    try {
      switch (decision.action) {
        case "retry": {
          const result = await submitTask({
            title: task.title,
            description: task.description,
            priority: task.priority as "critical" | "high" | "medium" | "low",
            tags: task.metadata ? JSON.parse(task.metadata).tags : undefined,
          });
          const reactionId = recordReaction(this.db, {
            trigger: "task_failed",
            sourceTaskId: taskId,
            spawnedTaskId: result.taskId,
            action: "retry",
            attempt: previousAttempts + 1,
            metadata: { error, rule: rule.name },
          });
          updateReactionStatus(this.db, reactionId, "completed");
          this.emitReactionEvent("reaction.triggered", {
            reaction_id: reactionId,
            trigger: "task_failed",
            source_task_id: taskId,
            spawned_task_id: result.taskId,
            action: "retry",
            attempt: previousAttempts + 1,
            reason: decision.reason,
          });
          break;
        }

        case "retry_adjusted": {
          const adjustedDesc = `[Auto-retry] Previous attempt failed: ${error}\nAdjust your approach.\n\n${task.description}`;
          const result = await submitTask({
            title: task.title,
            description: adjustedDesc,
            priority: task.priority as "critical" | "high" | "medium" | "low",
            tags: task.metadata ? JSON.parse(task.metadata).tags : undefined,
          });
          const reactionId = recordReaction(this.db, {
            trigger: "task_failed",
            sourceTaskId: taskId,
            spawnedTaskId: result.taskId,
            action: "retry_adjusted",
            attempt: previousAttempts + 1,
            metadata: { error, rule: rule.name },
          });
          updateReactionStatus(this.db, reactionId, "completed");
          this.emitReactionEvent("reaction.triggered", {
            reaction_id: reactionId,
            trigger: "task_failed",
            source_task_id: taskId,
            spawned_task_id: result.taskId,
            action: "retry_adjusted",
            attempt: previousAttempts + 1,
            reason: decision.reason,
          });
          break;
        }

        case "suppress": {
          const reactionId = recordReaction(this.db, {
            trigger: "repeated_failure",
            sourceTaskId: taskId,
            action: "suppress",
            attempt: previousAttempts + 1,
            metadata: {
              error,
              rule: rule.name,
              classificationFailures24h,
            },
          });
          updateReactionStatus(this.db, reactionId, "suppressed");
          this.emitReactionEvent("reaction.suppressed", {
            reaction_id: reactionId,
            trigger: "repeated_failure",
            source_task_id: taskId,
            spawned_task_id: null,
            action: "suppress",
            attempt: previousAttempts + 1,
            reason: decision.reason,
          });
          break;
        }

        case "escalate": {
          const reactionId = recordReaction(this.db, {
            trigger: "task_failed",
            sourceTaskId: taskId,
            action: "escalate",
            attempt: previousAttempts + 1,
            metadata: { error, rule: rule.name },
          });
          updateReactionStatus(this.db, reactionId, "completed");
          this.emitReactionEvent("reaction.escalated", {
            reaction_id: reactionId,
            trigger: "task_failed",
            source_task_id: taskId,
            spawned_task_id: null,
            action: "escalate",
            attempt: previousAttempts + 1,
            reason: decision.reason,
          });
          // Emit notification for Telegram/proactive system
          try {
            getEventBus().emitEvent("notification.warning", {
              title: "Task escalated",
              message: `Task "${task.title}" failed after ${previousAttempts} retries: ${error}`,
              source: "reaction-engine",
              context: { taskId, error },
            });
          } catch {
            // Best effort
          }
          break;
        }
      }
    } catch (err) {
      console.error(
        `[reactions] Failed to execute ${decision.action} for task ${taskId}:`,
        err,
      );
    }
  }

  /** Check for stuck tasks (running >15min with no progress). */
  private checkStuckTasks(): void {
    try {
      const stuckTasks = this.db
        .prepare(
          `SELECT task_id, title FROM tasks
           WHERE status = 'running'
           AND started_at < datetime('now', '-${STUCK_THRESHOLD_MINUTES} minutes')`,
        )
        .all() as { task_id: string; title: string }[];

      for (const stuck of stuckTasks) {
        console.log(
          `[reactions] Stuck task detected: ${stuck.task_id} ("${stuck.title}")`,
        );
        // Mark as failed — this triggers a task.failed event which handleTaskFailed picks up
        this.db
          .prepare(
            `UPDATE tasks SET status = 'failed', error = ?, updated_at = datetime('now'), completed_at = datetime('now')
             WHERE task_id = ? AND status = 'running'`,
          )
          .run(
            `Stuck task detected (no progress for ${STUCK_THRESHOLD_MINUTES} minutes)`,
            stuck.task_id,
          );

        try {
          getEventBus().emitEvent("task.failed", {
            task_id: stuck.task_id,
            agent_id: "reaction-engine",
            error: `Stuck task detected (no progress for ${STUCK_THRESHOLD_MINUTES} minutes)`,
            recoverable: true,
            attempts: 1,
          });
        } catch {
          // Best effort
        }
      }
    } catch (err) {
      console.error("[reactions] Error checking stuck tasks:", err);
    }
  }

  /** Emit a reaction event (best-effort). */
  private emitReactionEvent(
    type: string,
    data: {
      reaction_id: string;
      trigger: string;
      source_task_id: string;
      spawned_task_id: string | null;
      action: string;
      attempt: number;
      reason: string;
    },
  ): void {
    try {
      getEventBus().emitEvent(type as any, data as any);
    } catch {
      // Reaction events are observability — don't fail the reaction itself
    }
  }
}
