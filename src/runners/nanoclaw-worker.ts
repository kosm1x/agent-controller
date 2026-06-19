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

import { execFileSync } from "node:child_process";
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

/** Read-only reference mount of the host repo (never writable). */
const RO_REPO = "/root/claude/mission-control";
/** Writable working copy the coding agent edits/commits/pushes from. */
const WORKSPACE = "/workspace";

/**
 * Set up a WRITABLE clone of the read-only repo mount so coding tasks can edit,
 * test, commit and push. nanoclaw mounts the host repo `:ro` (deliberate — the
 * container must never write the host tree), so without this the agent dies on
 * `git commit` ("Read-only file system"). The clone gets the host's current
 * HEAD; the image's installed deps are symlinked in so tests run; push auth is
 * wired from the mounted gh token. Returns the workspace path, or null on
 * failure (read-only/analysis tasks still work from the `:ro` mount).
 */
function setupCodingWorkspace(): string | null {
  const run = (cmd: string, args: string[]): string =>
    execFileSync(cmd, args, { stdio: "pipe", encoding: "utf8" });
  try {
    // Writable clone of the current host repo (local path → fast, no network).
    run("git", ["clone", "--no-hardlinks", "--quiet", RO_REPO, WORKSPACE]);
    // Symlink the image's installed node_modules so `npx vitest`/tsc work.
    run("ln", ["-sfn", "/app/node_modules", `${WORKSPACE}/node_modules`]);
    // Repoint origin from the local clone path to the real GitHub remote.
    const ghUrl = run("git", [
      "-C",
      RO_REPO,
      "remote",
      "get-url",
      "origin",
    ]).trim();
    run("git", ["-C", WORKSPACE, "remote", "set-url", "origin", ghUrl]);
    // Wire `git push` auth from the mounted gh token + a commit identity.
    run("gh", ["auth", "setup-git"]);
    run("git", [
      "-C",
      WORKSPACE,
      "config",
      "user.email",
      "jarvis@mission-control.local",
    ]);
    run("git", ["-C", WORKSPACE, "config", "user.name", "Jarvis (nanoclaw)"]);
    process.chdir(WORKSPACE);
    // The image sets NODE_ENV=production; if the agent runs `npm install` it
    // would strip devDependencies (vitest, tsc) and clobber the symlink. Unset
    // it so any install the agent does still pulls dev tools. (Deps are already
    // present via the symlink — the prompt tells the agent not to install.)
    delete process.env.NODE_ENV;
    return WORKSPACE;
  } catch (err) {
    console.error(
      "[nanoclaw-worker] workspace setup failed (read-only tasks unaffected):",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

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

  // Coding tasks need a WRITABLE workspace — the repo is mounted read-only.
  // Clone it into one the agent can edit/commit/push from. Returns null for the
  // rare read-only task (still works against the :ro mount).
  const workspace = setupCodingWorkspace();
  const envNote = workspace
    ? `\n\n[ENVIRONMENT] You are in an isolated Docker container. Your WRITABLE working copy of the mission-control repo is at ${workspace} and is already your working directory — do ALL file edits, test runs, commits and pushes there. \`${RO_REPO}\` is a READ-ONLY reference mount; never write or commit in it. Dependencies are ALREADY installed (node_modules is present) — run tests directly with \`npx vitest run <file>\`; do NOT run \`npm install\`/\`npm ci\` (unnecessary, and it will strip dev tools). To DELIVER a change you MUST create a branch, commit, and \`git push -u origin <branch>\` (push auth + the GitHub remote are already configured). Report the pushed branch name.`
    : `\n\n[ENVIRONMENT] Isolated container; \`${RO_REPO}\` is READ-ONLY and no writable workspace is available — you can read code but cannot commit.`;

  // Build code index so code_search has data (from the workspace if cloned).
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
      input.prompt + envNote,
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
