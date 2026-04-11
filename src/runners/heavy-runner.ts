/**
 * Heavy Runner — Plan-Execute-Reflect, optionally inside a Docker container.
 *
 * When HEAVY_RUNNER_CONTAINERIZED=true, executes inside a container using the
 * same MC image with a worker entrypoint. Otherwise runs in-process.
 */

import { registerRunner } from "../dispatch/dispatcher.js";
import type { Runner, RunnerInput, RunnerOutput } from "./types.js";
import { orchestrate } from "../prometheus/orchestrator.js";
import { getConfig } from "../config.js";
import {
  spawnContainer,
  killContainer,
  generateContainerName,
} from "./container.js";
import type { ContainerHandle } from "./container.js";

async function executeInProcess(input: RunnerInput): Promise<RunnerOutput> {
  const start = Date.now();

  try {
    // Check for resumable snapshot from a prior early exit
    let snapshot:
      | import("../prometheus/snapshot.js").PrometheusSnapshot
      | undefined;
    try {
      const { loadSnapshot } = await import("../prometheus/snapshot.js");
      snapshot = loadSnapshot(input.taskId) ?? undefined;
      if (snapshot) {
        console.log(
          `[heavy-runner] Resuming task ${input.taskId} from snapshot`,
        );
      }
    } catch {
      /* snapshot loading is best-effort */
    }

    const result = await orchestrate(
      input.taskId,
      `${input.title}\n\n${input.description}`,
      undefined,
      input.tools,
      snapshot,
    );

    return {
      success: result.success,
      output: {
        content: result.reflection.summary,
        score: result.reflection.score,
        learnings: result.reflection.learnings,
      },
      toolCalls: result.executionResults.totalToolNames,
      tokenUsage: {
        promptTokens: result.tokenUsage.promptTokens,
        completionTokens: result.tokenUsage.completionTokens,
      },
      durationMs: Date.now() - start,
      goalGraph: result.goalGraph,
      trace: result.trace,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
}

async function executeInContainer(input: RunnerInput): Promise<RunnerOutput> {
  const start = Date.now();
  const config = getConfig();

  const stdinPayload = {
    prompt: `${input.title}\n\n${input.description}`,
    taskId: input.taskId,
    tools: input.tools,
  };

  let handle: ContainerHandle | undefined;

  try {
    handle = spawnContainer({
      image: config.heavyRunnerImage,
      name: generateContainerName(`heavy-${input.taskId.slice(0, 8)}`),
      command: ["node", "dist/runners/heavy-worker.js"],
      input: stdinPayload,
      envVars: {
        INFERENCE_PRIMARY_URL: config.inferencePrimaryUrl,
        INFERENCE_PRIMARY_KEY: config.inferencePrimaryKey,
        INFERENCE_PRIMARY_MODEL: config.inferencePrimaryModel,
        MC_API_KEY: config.apiKey,
        MC_DB_PATH: "/tmp/mc.db",
      },
      timeoutMs: config.heavyRunnerTimeoutMs,
    });

    const containerOutput = await handle.result;

    if (containerOutput.status === "error") {
      return {
        success: false,
        error: containerOutput.error ?? "Container execution failed",
        durationMs: Date.now() - start,
      };
    }

    // Parse the structured output from the container
    const parsed = JSON.parse(containerOutput.result ?? "{}") as {
      success?: boolean;
      content?: string;
      score?: number;
      learnings?: string[];
      toolCalls?: string[];
      tokenUsage?: { promptTokens: number; completionTokens: number };
      goalGraph?: unknown;
      trace?: unknown[];
      error?: string;
      durationMs?: number;
    };

    if (parsed.error) {
      return {
        success: false,
        error: parsed.error,
        durationMs: Date.now() - start,
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
      durationMs: Date.now() - start,
      goalGraph: parsed.goalGraph,
      trace: parsed.trace,
    };
  } catch (err) {
    if (handle) killContainer(handle);
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
}

export const heavyRunner: Runner = {
  type: "heavy",

  async execute(input: RunnerInput): Promise<RunnerOutput> {
    const config = getConfig();
    if (config.heavyRunnerContainerized) {
      return executeInContainer(input);
    }
    return executeInProcess(input);
  },
};

// Auto-register on import
registerRunner(heavyRunner);
