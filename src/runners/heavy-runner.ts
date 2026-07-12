/**
 * Heavy Runner — Plan-Execute-Reflect, optionally inside a Docker container.
 *
 * When HEAVY_RUNNER_CONTAINERIZED=true, executes inside a container using the
 * same MC image with a worker entrypoint. Otherwise runs in-process.
 */

import { registerRunner } from "../dispatch/dispatcher.js";
import type { Runner, RunnerInput, RunnerOutput } from "./types.js";
import { orchestrate } from "../prometheus/orchestrator.js";
import { collectFinalAnswer } from "../prometheus/final-answer.js";
import { CACHE_BREAK_MARKER } from "../messaging/router.js";
import { getConfig } from "../config.js";
import {
  spawnContainer,
  killContainer,
  generateContainerName,
  imageExistsLocally,
} from "./container.js";
import type { ContainerHandle } from "./container.js";
import { recordNanoclawImageMissing } from "../observability/prometheus.js";
import { errMsg } from "../lib/err-msg.js";
import { renderConversationContext } from "./conversation-context.js";

async function executeInProcess(input: RunnerInput): Promise<RunnerOutput> {
  const start = Date.now();

  try {
    // Check for resumable snapshot from a prior early exit
    let snapshot:
      import("../prometheus/snapshot.js").PrometheusSnapshot | undefined;
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

    // v8 S1: heavy-runner uses description as a single blob prompt to
    // orchestrate(); strip the cache-break marker so it doesn't appear as
    // visible text. fast-runner's chat branch is the only path that benefits
    // from splitting; heavy/nanoclaw/swarm treat description as one piece.
    const result = await orchestrate(
      input.taskId,
      // 2026-07-12 (task 7416 class): chat tasks carry the CURRENT user
      // message as the last conversationHistory turn — append it or the
      // agent's instruction is just the truncated title.
      `${input.title}\n\n${input.description.replace(CACHE_BREAK_MARKER, "\n")}${renderConversationContext(input.conversationHistory)}`,
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
        // The agent's actual report (joined per-goal answers), distinct from
        // `content` (the reflector's meta-summary). Consumed by the dispatcher
        // for ritual persistResult so it stores what the agent produced.
        finalAnswer: collectFinalAnswer(result.executionResults),
      },
      toolCalls: result.executionResults.totalToolNames,
      tokenUsage: {
        promptTokens: result.tokenUsage.promptTokens,
        completionTokens: result.tokenUsage.completionTokens,
        ...(result.tokenUsage.cacheReadTokens !== undefined && {
          cacheReadTokens: result.tokenUsage.cacheReadTokens,
        }),
        ...(result.tokenUsage.cacheCreationTokens !== undefined && {
          cacheCreationTokens: result.tokenUsage.cacheCreationTokens,
        }),
        // 2026-05-10 cutover round-2 C1: surface SDK-reported model so
        // dispatcher attributes Opus/Haiku correctly in cost_ledger.
        ...(result.tokenUsage.actualModel !== undefined && {
          actualModel: result.tokenUsage.actualModel,
        }),
        // Surface SDK-reported total_cost_usd summed by the orchestrator so
        // dispatcher writes real $$ into cost_ledger instead of $0 (the
        // calculateCost() fallback returns $0 for Claude models).
        ...(result.tokenUsage.actualCostUsd !== undefined && {
          actualCostUsd: result.tokenUsage.actualCostUsd,
        }),
      },
      durationMs: Date.now() - start,
      goalGraph: result.goalGraph,
      trace: result.trace,
    };
  } catch (err) {
    return {
      success: false,
      error: errMsg(err),
      durationMs: Date.now() - start,
    };
  }
}

async function executeInContainer(input: RunnerInput): Promise<RunnerOutput> {
  const start = Date.now();
  const config = getConfig();

  const stdinPayload = {
    // v8 S1: strip cache-break marker (see in-process branch above for context).
    // conversationHistory appended for the same reason as the in-process branch.
    prompt: `${input.title}\n\n${input.description.replace(CACHE_BREAK_MARKER, "\n")}${renderConversationContext(input.conversationHistory)}`,
    taskId: input.taskId,
    tools: input.tools,
  };

  let handle: ContainerHandle | undefined;

  try {
    // Pre-flight: same `mission-control:latest` image used by nanoclaw-runner.
    // Currently dormant under `HEAVY_RUNNER_CONTAINERIZED=false` (default) per
    // feedback_heavy_runner_containerized_not_perf.md, but flipping that flag
    // without this guard would re-open the prune-recurrence blocker on the
    // heavy path. Counter reused with the nanoclaw bucket — both feed the
    // same image-prevention dashboard. qa-audit W2 (2026-05-23).
    if (!imageExistsLocally(config.heavyRunnerImage)) {
      recordNanoclawImageMissing();
      const errMsg =
        `Docker image '${config.heavyRunnerImage}' not found locally. ` +
        `Pre-flight failed before container spawn (heavy path). ` +
        `Rebuild: bash /root/claude/mission-control/scripts/build-mc-image.sh`;
      console.error(`[heavy-runner] FATAL: ${errMsg}`);
      return {
        success: false,
        error: errMsg,
        durationMs: Date.now() - start,
      };
    }

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

    handle = spawnContainer({
      image: config.heavyRunnerImage,
      name: generateContainerName(`heavy-${input.taskId.slice(0, 8)}`),
      command: ["node", "dist/runners/heavy-worker.js"],
      input: stdinPayload,
      envVars,
      volumes: isClaudeSdk
        ? ["/root/.claude/.credentials.json:/root/.claude/.credentials.json:ro"]
        : undefined,
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
      finalAnswer?: string | null;
      toolCalls?: string[];
      tokenUsage?: {
        promptTokens: number;
        completionTokens: number;
        cacheReadTokens?: number;
        cacheCreationTokens?: number;
        // 2026-05-10 cutover round-2 C1: container-side heavy-worker emits
        // this so the dispatcher attributes Opus/Haiku correctly.
        actualModel?: string;
        actualCostUsd?: number;
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
        durationMs: Date.now() - start,
      };
    }

    return {
      success: parsed.success ?? true,
      output: {
        content: parsed.content,
        score: parsed.score,
        learnings: parsed.learnings,
        finalAnswer: parsed.finalAnswer,
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
      error: errMsg(err),
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
