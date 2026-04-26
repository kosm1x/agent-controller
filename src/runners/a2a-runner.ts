/**
 * A2A Runner — delegates tasks to external A2A agents.
 *
 * Discovers the remote agent via its agent card, sends the task via JSON-RPC,
 * then polls until a terminal state is reached. Uses exponential backoff
 * for polling.
 */

import { registerRunner } from "../dispatch/dispatcher.js";
import { A2ARpcClient, agentCardCache } from "../a2a/client.js";
import { A2A_TERMINAL_STATES } from "../a2a/types.js";
import { stripCacheMarker } from "../messaging/router.js";
import type { Runner, RunnerInput, RunnerOutput } from "./types.js";

const POLL_INITIAL_MS = 1_000;
const POLL_MAX_MS = 15_000;
const POLL_TIMEOUT_MS = 600_000; // 10 minutes

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const a2aRunner: Runner = {
  type: "a2a",

  async execute(input: RunnerInput): Promise<RunnerOutput> {
    const start = Date.now();

    // Extract target URL and optional API key from input
    const inputData = input.input as {
      a2a_target?: string;
      a2a_key?: string;
    } | null;

    if (!inputData?.a2a_target) {
      return {
        success: false,
        error: "A2A runner requires input.a2a_target (URL of remote A2A agent)",
        durationMs: Date.now() - start,
      };
    }

    const targetUrl = inputData.a2a_target;
    const targetKey = inputData.a2a_key;

    try {
      // Discover remote agent
      const card = await agentCardCache.fetch(targetUrl);
      console.log(`[a2a-runner] Delegating to ${card.name} at ${targetUrl}`);

      // Create RPC client and send message
      const client = new A2ARpcClient(targetUrl, targetKey);
      // v8 S1: strip cache-break marker before sending to remote A2A peer.
      // Marker is an mc-internal optimization; remote agents shouldn't see it.
      const message = {
        role: "user" as const,
        parts: [
          {
            type: "text" as const,
            text: `${input.title}\n\n${stripCacheMarker(input.description)}`,
          },
        ],
      };

      const task = await client.sendMessage(message);
      const remoteTaskId = task.id;

      // Poll until terminal state
      let pollDelay = POLL_INITIAL_MS;
      const deadline = Date.now() + POLL_TIMEOUT_MS;

      while (Date.now() < deadline) {
        await sleep(pollDelay);

        const current = await client.getTask(remoteTaskId);
        const state = current.status.state;

        if (A2A_TERMINAL_STATES.has(state)) {
          // Extract result
          const outputText =
            current.artifacts
              ?.flatMap((a) =>
                a.parts
                  .filter(
                    (p): p is Extract<typeof p, { type: "text" }> =>
                      p.type === "text",
                  )
                  .map((p) => p.text),
              )
              .join("\n") ?? current.status.message;

          return {
            success: state === "completed",
            output: outputText,
            error:
              state === "failed"
                ? (current.status.message ?? "Remote task failed")
                : undefined,
            durationMs: Date.now() - start,
          };
        }

        // Exponential backoff
        pollDelay = Math.min(pollDelay * 2, POLL_MAX_MS);
      }

      return {
        success: false,
        error: `A2A delegation timed out after ${POLL_TIMEOUT_MS}ms`,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  },
};

// Auto-register on import
registerRunner(a2aRunner);
