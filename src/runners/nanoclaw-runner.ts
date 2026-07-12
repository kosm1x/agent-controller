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
import { CACHE_BREAK_MARKER } from "../messaging/router.js";
import type { Runner, RunnerInput, RunnerOutput } from "./types.js";
import {
  spawnContainer,
  killContainer,
  generateContainerName,
  imageExistsLocally,
} from "./container.js";
import type { ContainerHandle } from "./container.js";
import { recordNanoclawImageMissing } from "../observability/prometheus.js";
import { errMsg } from "../lib/err-msg.js";

export const nanoclawRunner: Runner = {
  type: "nanoclaw",

  async execute(input: RunnerInput): Promise<RunnerOutput> {
    const start = Date.now();
    const config = getConfig();
    let handle: ContainerHandle | null = null;

    try {
      // Pre-flight: confirm the runner image actually exists locally.
      // The /etc/cron.d/docker-image-prune cron fires daily at 00:47 UTC and
      // removes images with no running container references — and mc API
      // runs in-process via systemd, so `mission-control:latest` has no live
      // reference. Without this guard, a pruned image surfaces only as the
      // opaque `Container exited with code 125: Unable to find image ...
      // docker: Error response from daemon: pull access denied for ...`
      // chain mid-task. Failing loud here gives the operator a rebuild
      // instruction. A race window exists between this check and
      // spawnContainer (~ms); if the cron fires mid-task, the resulting
      // exit-125 propagates and the circuit-breaker in
      // autonomous-improvement.ts catches the pattern on the next run.
      // Recurrence cause + fix: feedback_nanoclaw_image_recurrence_2026_05_23.md.
      if (!imageExistsLocally(config.heavyRunnerImage)) {
        recordNanoclawImageMissing();
        const errMsg =
          `Docker image '${config.heavyRunnerImage}' not found locally. ` +
          `Pre-flight failed before container spawn. ` +
          `Rebuild: bash /root/claude/mission-control/scripts/build-mc-image.sh`;
        console.error(`[nanoclaw-runner] FATAL: ${errMsg}`);
        return {
          success: false,
          error: errMsg,
          durationMs: Date.now() - start,
        };
      }

      // Build container input — include tools so the worker knows what to register
      // v8 S1: strip cache-break marker (nanoclaw uses description as a single
      // prompt blob; only fast-runner chat splits for cache-friendly emission).
      const containerInput = {
        prompt: `${input.title}\n\n${input.description.replace(CACHE_BREAK_MARKER, "\n")}`,
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
        // 2026-05-23 fix: was hardcoded 300_000 (5min), undersized vs the
        // orchestrate() workload nanoclaw-worker.ts runs — heavy on the
        // same workload uses 900s and routinely completes at 400-870s.
        // Now config-driven (NANOCLAW_TIMEOUT_MS, default 900_000).
        // Worker emits 60s heartbeat sentinels so this acts as inactivity
        // guard, not wall-clock cap.
        timeoutMs: config.nanoclawTimeoutMs,
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
        finalAnswer?: string | null;
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
          // Agent's actual report — the router prefers this over `content`
          // (the reflector meta-summary) for operator delivery. Without the
          // passthrough the worker's field is dropped and the operator gets
          // the English third-person verdict (07-11 heavy fix, nanoclaw
          // sibling swept 2026-07-12).
          finalAnswer: parsed.finalAnswer,
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
        error: errMsg(err),
        durationMs: Date.now() - start,
      };
    }
  },
};

// Auto-register on import
registerRunner(nanoclawRunner);
