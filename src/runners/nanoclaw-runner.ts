/**
 * NanoClaw Runner — Docker container-based task execution.
 *
 * Spawns a NanoClaw Docker container, sends the task via stdin JSON,
 * and collects output via sentinel-delimited stdout protocol.
 * This is the only runner type that uses Docker containers.
 */

import { getConfig } from "../config.js";
import { registerRunner } from "../dispatch/dispatcher.js";
import { getEventBus } from "../lib/event-bus.js";
import type { Runner, RunnerInput, RunnerOutput } from "./types.js";
import { spawnContainer, killContainer } from "./container.js";
import type { ContainerHandle } from "./container.js";

const CONTAINER_TIMEOUT_MS = 300_000; // 5 minutes

export const nanoclawRunner: Runner = {
  type: "nanoclaw",

  async execute(input: RunnerInput): Promise<RunnerOutput> {
    const start = Date.now();
    const config = getConfig();
    let handle: ContainerHandle | null = null;

    try {
      // Build container input
      const containerInput = {
        prompt: `${input.title}\n\n${input.description}`,
        taskId: input.taskId,
        ...(input.input != null ? { data: input.input } : {}),
      };

      // Spawn container
      handle = spawnContainer({
        image: config.nanoclawImage,
        input: containerInput,
        timeoutMs: CONTAINER_TIMEOUT_MS,
      });

      // Emit progress
      try {
        getEventBus().emitEvent("task.progress", {
          task_id: input.taskId,
          agent_id: "nanoclaw",
          progress: 20,
          phase: "execute",
          message: `Container ${handle.name} spawned`,
        });
      } catch {
        // Best-effort
      }

      // Wait for result
      const containerOutput = await handle.result;

      const durationMs = Date.now() - start;

      if (containerOutput.status === "error") {
        return {
          success: false,
          error: containerOutput.error ?? "Container returned error",
          output: containerOutput.result,
          durationMs,
        };
      }

      return {
        success: true,
        output: containerOutput.result,
        durationMs,
      };
    } catch (err) {
      // Kill container on unexpected error
      if (handle) {
        try {
          killContainer(handle);
        } catch {
          // Ignore cleanup errors
        }
      }

      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  },
};

// Auto-register on import
registerRunner(nanoclawRunner);
