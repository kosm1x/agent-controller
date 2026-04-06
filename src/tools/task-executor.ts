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
import { classifyMutation, recordMutation } from "../db/task-mutations.js";

const log = createLogger("task-executor");

/** Tools that require user confirmation before execution. */
const DESTRUCTIVE_MCP_TOOLS = new Set<string>([]);

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
          "PAUSE — this tool requires user confirmation before execution. " +
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
    const result = await registry.execute(name, args);

    // v6.2 S3: Record file mutations after successful tool execution.
    // Centralized here so individual tool handlers don't need modification.
    // Only records if the tool is a file-mutating tool and didn't return an error.
    try {
      // Detect error results — don't record failed mutations (C1 audit fix)
      let isError = result.startsWith("Error:");
      if (!isError) {
        try {
          const parsed = JSON.parse(result);
          if (parsed.error || parsed.success === false) isError = true;
        } catch {
          // Non-JSON result — not an error
        }
      }
      if (!isError) {
        const mutation = classifyMutation(name, args);
        if (mutation) {
          recordMutation(
            context.taskId,
            name,
            mutation.operation,
            mutation.filePath,
          );
        }
      }
    } catch {
      // Non-fatal — mutation log is best-effort
    }

    return result;
  };
}
