/**
 * Container entrypoint for heavy runner.
 *
 * Reads JSON from stdin, initializes an ephemeral environment,
 * runs orchestrate(), and writes sentinel-delimited JSON to stdout.
 */

import { loadConfig } from "../config.js";
import { initDatabase } from "../db/index.js";
import { initEventBus } from "../lib/event-bus.js";
import { toolRegistry } from "../tools/registry.js";
import { shellTool } from "../tools/builtin/shell.js";
import { httpTool } from "../tools/builtin/http.js";
import { fileReadTool, fileWriteTool } from "../tools/builtin/file.js";
import { orchestrate } from "../prometheus/orchestrator.js";
import { collectFinalAnswer } from "../prometheus/final-answer.js";
import { OUTPUT_START_MARKER, OUTPUT_END_MARKER } from "./container.js";
import { errMsg } from "../lib/err-msg.js";

async function main(): Promise<void> {
  // Read stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString()) as {
    prompt: string;
    taskId?: string;
    tools?: string[];
  };

  // Minimal init (mirrors src/index.ts)
  loadConfig();
  const db = initDatabase(process.env.MC_DB_PATH ?? "/tmp/mc.db");
  initEventBus(db);

  // Register built-in tools
  toolRegistry.register(shellTool);
  toolRegistry.register(httpTool);
  toolRegistry.register(fileReadTool);
  toolRegistry.register(fileWriteTool);

  const start = Date.now();

  // Activity-heartbeat: see nanoclaw-worker.ts for the full rationale.
  // Heavy runs the same orchestrate() loop and shares the same
  // host-side timer; symmetry matters even though HEAVY_RUNNER_CONTAINERIZED
  // is false by default — flipping the flag should not silently re-open
  // the timeout-without-progress failure mode.
  const heartbeat = setInterval(() => {
    process.stdout.write(
      `${OUTPUT_START_MARKER}\n${JSON.stringify({
        type: "progress",
        elapsedMs: Date.now() - start,
      })}\n${OUTPUT_END_MARKER}\n`,
    );
  }, 60_000);
  heartbeat.unref();

  try {
    const result = await orchestrate(
      input.taskId ?? "container-task",
      input.prompt,
      undefined,
      input.tools,
    );

    clearInterval(heartbeat);

    const output = {
      type: "result",
      success: result.success,
      content: result.reflection.summary,
      score: result.reflection.score,
      learnings: result.reflection.learnings,
      // Agent's actual report (joined per-goal answers), distinct from the
      // reflector meta-summary in `content`. See final-answer.ts.
      finalAnswer: collectFinalAnswer(result.executionResults),
      tokenUsage: result.tokenUsage,
      goalGraph: result.goalGraph,
      trace: result.trace,
      durationMs: Date.now() - start,
    };

    process.stdout.write(
      `${OUTPUT_START_MARKER}\n${JSON.stringify(output)}\n${OUTPUT_END_MARKER}\n`,
    );
  } catch (err) {
    clearInterval(heartbeat);
    const output = {
      type: "result",
      error: errMsg(err),
      durationMs: Date.now() - start,
    };
    process.stdout.write(
      `${OUTPUT_START_MARKER}\n${JSON.stringify(output)}\n${OUTPUT_END_MARKER}\n`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[heavy-worker] Fatal:", err);
  process.exit(1);
});
