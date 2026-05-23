/**
 * Container entrypoint for NanoClaw coding tasks.
 *
 * Reads JSON from stdin, initializes an ephemeral environment,
 * registers all coding tools, runs orchestrate(), and writes
 * sentinel-delimited JSON to stdout (including toolCalls for
 * requiredTools validation in the dispatcher).
 *
 * Modeled on heavy-worker.ts but registers the full coding toolset
 * needed by autonomous improvement (jarvis_dev, code_search, etc.).
 */

import { loadConfig } from "../config.js";
import { initDatabase } from "../db/index.js";
import { initEventBus } from "../lib/event-bus.js";
import { toolRegistry } from "../tools/registry.js";

// Coding tools — all 11 from autonomous-improvement.ts
import { shellTool } from "../tools/builtin/shell.js";
import { fileReadTool, fileWriteTool } from "../tools/builtin/file.js";
import { fileEditTool } from "../tools/builtin/code-editing.js";
import {
  grepTool,
  globTool,
  listDirTool,
  codeSearchTool,
} from "../tools/builtin/code-search.js";
import { jarvisDevTool } from "../tools/builtin/jarvis-dev.js";
import {
  jarvisDiagnoseTool,
  jarvisTestRunTool,
} from "../tools/builtin/jarvis-self-repair.js";
import { rebuildIndex } from "../tools/builtin/code-index.js";

import { orchestrate } from "../prometheus/orchestrator.js";
import { OUTPUT_START_MARKER, OUTPUT_END_MARKER } from "./container.js";

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

  // Minimal init (mirrors heavy-worker.ts)
  loadConfig();
  const db = initDatabase(process.env.MC_DB_PATH ?? "/tmp/mc.db");
  initEventBus(db);

  // Register all coding tools
  toolRegistry.register(shellTool);
  toolRegistry.register(fileReadTool);
  toolRegistry.register(fileWriteTool);
  toolRegistry.register(fileEditTool);
  toolRegistry.register(grepTool);
  toolRegistry.register(globTool);
  toolRegistry.register(listDirTool);
  toolRegistry.register(codeSearchTool);
  toolRegistry.register(jarvisDevTool);
  toolRegistry.register(jarvisDiagnoseTool);
  toolRegistry.register(jarvisTestRunTool);

  // Build code index so code_search has data from the mounted repo
  try {
    rebuildIndex();
  } catch {
    // Non-fatal — code_search falls back to grep
  }

  const start = Date.now();

  // Activity-heartbeat: emit a sentinel-wrapped progress payload every 60s
  // so the host-side parsePayload() in container.ts resets the activity
  // timer mid-task. Without this, the "activity-aware timeout" comment in
  // container.ts is misleading — the timer only resets on a COMPLETE
  // sentinel pair, and we used to only emit one of those at the end.
  // 2026-05-14 incident: 5 nanoclaw tasks timed out at 300s because
  // orchestrate() was making real progress but emitting no interim signal.
  // heartbeat.unref() so the interval doesn't keep the worker alive after
  // main() returns.
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
      toolCalls: result.executionResults.totalToolNames,
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
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
    process.stdout.write(
      `${OUTPUT_START_MARKER}\n${JSON.stringify(output)}\n${OUTPUT_END_MARKER}\n`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[nanoclaw-worker] Fatal:", err);
  process.exit(1);
});
