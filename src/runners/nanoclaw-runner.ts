/**
 * NanoClaw Runner — Docker container-based coding task execution.
 *
 * Spawns a container with the nanoclaw-worker entrypoint, which runs
 * the Prometheus orchestrator with all coding tools (jarvis_dev,
 * code_search, file_edit, etc.) inside Docker isolation.
 *
 * The container uses the mission-control:latest image (same as heavy-runner)
 * with the mission-control repo volume-mounted for git/test operations.
 */

import { getConfig } from "../config.js";
import { registerRunner } from "../dispatch/dispatcher.js";
import { getEventBus } from "../lib/event-bus.js";
import type { Runner, RunnerInput, RunnerOutput } from "./types.js";
import {
  spawnContainer,
  killContainer,
  generateContainerName,
} from "./container.js";
import type { ContainerHandle } from "./container.js";

const CONTAINER_TIMEOUT_MS = 300_000; // 5 minutes

export const nanoclawRunner: Runner = {
  type: "nanoclaw",

  async execute(input: RunnerInput): Promise<RunnerOutput> {
    const start = Date.now();
    const config = getConfig();
    let handle: ContainerHandle | null = null;

    try {
      // Build container input — include tools so the worker knows what to register
      const containerInput = {
        prompt: `${input.title}\n\n${input.description}`,
        taskId: input.taskId,
        tools: input.tools,
      };

      const isClaudeSdk = config.inferencePrimaryProvider === "claude-sdk";
      const envVars: Record<string, string> = {
        INFERENCE_PRIMARY_URL: config.inferencePrimaryUrl,
        INFERENCE_PRIMARY_KEY: config.inferencePrimaryKey,
        INFERENCE_PRIMARY_MODEL: config.inferencePrimaryModel,
        INFERENCE_PRIMARY_PROVIDER: config.inferencePrimaryProvider,
        MC_API_KEY: config.apiKey,
        MC_DB_PATH: "/tmp/mc.db",
      };
      if (isClaudeSdk) {
        // Claude Agent SDK reads ~/.claude/.credentials.json via os.homedir() → HOME.
        envVars.HOME = "/root";
      }

      // Sec3 round-1 fix: mission-control source is mounted read-only.
      // nanoclaw-worker.ts only reads compiled `dist/` + `package.json` —
      // any writes from the container would bypass file_write / shell_exec
      // host-side guards + immutable-core. DB writes go to /tmp/mc.db.
      const volumes = [
        "/root/claude/mission-control:/root/claude/mission-control:ro",
        "/root/.config/gh:/root/.config/gh:ro",
      ];
      if (isClaudeSdk) {
        volumes.push(
          "/root/.claude/.credentials.json:/root/.claude/.credentials.json:ro",
        );
      }

      // Spawn container with worker entrypoint, credentials, and repo mount
      handle = spawnContainer({
        image: config.heavyRunnerImage, // mission-control:latest (has compiled dist/)
        name: generateContainerName(`nanoclaw-${input.taskId.slice(0, 8)}`),
        command: ["node", "dist/runners/nanoclaw-worker.js"],
        input: containerInput,
        envVars,
        volumes,
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
          error: containerOutput.error ?? "Container execution failed",
          durationMs,
        };
      }

      // Parse structured output from the worker (mirrors heavy-runner.ts:94-125)
      const parsed = JSON.parse(containerOutput.result ?? "{}") as {
        success?: boolean;
        content?: string;
        score?: number;
        learnings?: string[];
        toolCalls?: string[];
        tokenUsage?: {
          promptTokens: number;
          completionTokens: number;
          cacheReadTokens?: number;
          cacheCreationTokens?: number;
        };
        goalGraph?: unknown;
        trace?: unknown[];
        error?: string;
        durationMs?: number;
      };

      if (parsed.error) {
        return {
          success: false,
          error: parsed.error,
          durationMs,
        };
      }

      return {
        success: parsed.success ?? true,
        output: {
          content: parsed.content,
          score: parsed.score,
          learnings: parsed.learnings,
        },
        toolCalls: parsed.toolCalls,
        tokenUsage: parsed.tokenUsage,
        durationMs,
        goalGraph: parsed.goalGraph,
        trace: parsed.trace,
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
