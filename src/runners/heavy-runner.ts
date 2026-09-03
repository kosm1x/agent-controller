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
  IMAGE_LOCK_LABEL,
  RUNTIME_CODE_MOUNTS,
  generateContainerName,
  imageExistsLocally,
  imageLockDrift,
  missingHostDistAssets,
} from "./container.js";
import { spawnSandbox, type SandboxHandle } from "./sandbox-backend.js";
import {
  recordNanoclawImageDrift,
  recordNanoclawImageMissing,
} from "../observability/prometheus.js";
import { errMsg } from "../lib/err-msg.js";
import { renderConversationContext } from "./conversation-context.js";

async function executeInProcess(input: RunnerInput): Promise<RunnerOutput> {
  const start = Date.now();
  const config = getConfig();

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
      // Operator knobs (GOAL_TIMEOUT_MS / ORCHESTRATOR_TIMEOUT_MS) reach the
      // orchestrator only through this argument — with `undefined` it ran on
      // its compiled defaults and the 2026-06-24 drop-in raising the goal
      // cap to 300 s was dead for ten weeks (task 2b170ca6, 2026-09-03: a
      // 220-290 s Doc-writing goal "timed out after 120000ms" three times).
      {
        goalTimeoutMs: config.goalTimeoutMs,
        timeoutMs: config.orchestratorTimeoutMs,
      },
      input.tools,
      snapshot,
    );

    // Promote graded-down completions: every goal completed but reflection
    // scored below the success gate. The answer exists — deliver it as
    // completed_with_concerns instead of failing the task (task e6f3dfa0,
    // 2026-07-27: a full PDF-verification report reached the operator as
    // "[Task failed] Unknown error"). Same promote-to-deliver precedent as
    // fast-runner's needs-context text handling.
    const promoted = !result.success && result.completedWithConcerns === true;
    const exitNote = exitNoteOf(result.exitReason, result.unfinishedGoals);
    const unverifiedGoals = promoted
      ? Object.values(result.executionResults.goalResults)
          .filter((gr) => gr.criteriaMet === false)
          .map(
            (gr) =>
              `Goal ${gr.goalId}: success criteria not verified (best-effort)`,
          )
      : [];

    return {
      success: result.success || promoted,
      // Preserve the failure channel: a non-promoted early exit reached the
      // dispatcher as "Unknown error" and swarm-retry as terminal
      // unknown_failure (2026-09-03, task cbc9e3fa).
      ...(!result.success &&
        !promoted && {
          error:
            exitNote ??
            `Reflection below success gate (score ${result.reflection.score.toFixed(2)}): ${result.reflection.summary.slice(0, 200)}`,
        }),
      ...(promoted && {
        status: "DONE_WITH_CONCERNS" as const,
        concerns: [
          ...(exitNote ? [exitNote] : []),
          ...unverifiedGoals,
          ...(!exitNote && unverifiedGoals.length === 0
            ? [
                `Reflection score ${result.reflection.score.toFixed(2)} below success gate`,
              ]
            : []),
        ],
      }),
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

/**
 * One line naming why the orchestrator stopped early and which goals it left
 * unfinished — the error when the task is not promoted, the first concern
 * when it is. `undefined` when every goal finished.
 */
function exitNoteOf(
  exitReason: "timeout" | "budget_exhausted" | "aborted" | undefined,
  unfinishedGoals: string[] | undefined,
): string | undefined {
  if (!exitReason) return undefined;
  const why =
    exitReason === "timeout"
      ? "Orchestrator global timeout"
      : exitReason === "budget_exhausted"
        ? "Orchestrator iteration budget exhausted"
        : "Orchestrator stopped early";
  return `${why} before every goal finished — unfinished: ${unfinishedGoals?.join(", ") || "unknown"}`;
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

  let handle: SandboxHandle | undefined;

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

    // Pre-flight 2 (2026-09-01): host dist/ runs on the image's node_modules
    // (RUNTIME_CODE_MOUNTS) — refuse on package-lock drift; see nanoclaw-runner.
    const drift = imageLockDrift(config.heavyRunnerImage);
    if (drift) {
      recordNanoclawImageDrift();
      const driftMsg =
        `Docker image '${config.heavyRunnerImage}' was built from a different package-lock.json ` +
        `(image label ${IMAGE_LOCK_LABEL}=${drift.image ?? "<absent>"}, host sha256 ${drift.host.slice(0, 12)}…). ` +
        `Pre-flight failed before container spawn (heavy path). ` +
        `Rebuild: bash /root/claude/mission-control/scripts/build-mc-image.sh`;
      console.error(`[heavy-runner] FATAL: ${driftMsg}`);
      return {
        success: false,
        error: driftMsg,
        durationMs: Date.now() - start,
      };
    }

    // Pre-flight 3 (qa R2 W-C): host dist/ must be a full `npm run build`.
    const missingAssets = missingHostDistAssets();
    if (missingAssets.length > 0) {
      const assetsMsg =
        `Host dist/ is missing build assets (${missingAssets.join(", ")}) — the sandbox ` +
        `executes the host dist/, so it must come from \`npm run build\`, not bare tsc. ` +
        `Pre-flight failed before container spawn (heavy path). Fix: cd /root/claude/mission-control && npm run build`;
      console.error(`[heavy-runner] FATAL: ${assetsMsg}`);
      return {
        success: false,
        error: assetsMsg,
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

    handle = spawnSandbox({
      image: config.heavyRunnerImage,
      name: generateContainerName(`heavy-${input.taskId.slice(0, 8)}`),
      command: ["node", "dist/runners/heavy-worker.js"],
      input: stdinPayload,
      envVars,
      volumes: [
        // Deployed dist/ + prompt_modules/ over the image's baked copies
        // (2026-09-01, see container.ts RUNTIME_CODE_MOUNTS).
        ...RUNTIME_CODE_MOUNTS,
        ...(isClaudeSdk
          ? [
              "/root/.claude/.credentials.json:/root/.claude/.credentials.json:ro",
            ]
          : []),
      ],
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
      completedWithConcerns?: boolean;
      exitReason?: "timeout" | "budget_exhausted" | "aborted";
      unfinishedGoals?: string[];
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

    // Same graded-down promotion as the in-process branch. The container
    // JSON doesn't carry per-goal results, so concerns fall back to the
    // generic line.
    const containerPromoted =
      parsed.success === false && parsed.completedWithConcerns === true;
    const containerExitNote = exitNoteOf(
      parsed.exitReason,
      parsed.unfinishedGoals,
    );
    // V8.4 (2026-08-16): a blob with NO `success` field is a protocol gap,
    // not a success — deliver, but as completed_with_concerns.
    const selfAttested = typeof parsed.success === "boolean";

    return {
      success: (selfAttested ? parsed.success === true : true) || containerPromoted,
      ...(parsed.success === false &&
        !containerPromoted && {
          error:
            containerExitNote ??
            `Reflection below success gate (score ${typeof parsed.score === "number" ? parsed.score.toFixed(2) : "?"}): ${(parsed.content ?? "").slice(0, 200)}`,
        }),
      ...((containerPromoted || !selfAttested) && {
        status: "DONE_WITH_CONCERNS" as const,
        concerns: [
          ...(containerPromoted && containerExitNote
            ? [containerExitNote]
            : []),
          containerPromoted
            ? "Success criteria not fully verified (best-effort goals)"
            : "container worker returned no `success` field — completion not self-attested",
        ],
      }),
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
    if (handle) handle.kill();
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
