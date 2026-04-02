/**
 * Per-task tool executor — wraps toolRegistry.execute() with context-aware
 * destructive lock checks.
 *
 * The toolRegistry becomes a read-only singleton for tool definitions,
 * validation, and fuzzy matching. Mutable per-task state (destructive locks,
 * memory rate limits) lives in the TaskExecutionContext.
 *
 * v5.0 S2: enables safe concurrent task execution.
 */

import type { TaskExecutionContext } from "../inference/execution-context.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolExecutor } from "../inference/adapter.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("task-executor");

/** Tools that require user confirmation before execution. */
const DESTRUCTIVE_MCP_TOOLS = new Set(["commit__delete_item"]);

/**
 * Create a per-task executor that delegates to toolRegistry but uses the
 * task's own execution context for destructive lock checks and memory
 * rate limiting.
 */
export function createTaskExecutor(
  registry: ToolRegistry,
  context: TaskExecutionContext,
): ToolExecutor {
  return async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> => {
    // Destructive gate: check the per-task context, not the registry singleton
    if (
      DESTRUCTIVE_MCP_TOOLS.has(name) &&
      !context.isDestructiveUnlocked(name)
    ) {
      log.warn(
        { tool: name, taskId: context.taskId },
        "destructive tool BLOCKED (no confirmation in task context)",
      );
      return JSON.stringify({
        error: "CONFIRMATION_REQUIRED",
        message:
          "PAUSE — you DO have commit__delete_item and it WILL work after the user confirms. " +
          "Present the items to delete (name, type, count) and ask: '¿Los elimino?' or 'Shall I delete these?' " +
          "The user will confirm on the next message, and the tool will execute. Do NOT say you lack the tool.",
        tool: name,
      });
    }

    // Memory store rate limiting via context
    if (name === "memory_store") {
      if (!context.tryMemoryStore()) {
        return JSON.stringify({
          warning: `Memory store limit reached (${context.getMemoryStoreLimit()}/task). Prioritize quality over quantity — store only the most valuable observation.`,
        });
      }
    }

    // Delegate actual execution to the registry (read-only singleton)
    return registry.execute(name, args);
  };
}
