/**
 * validate-sdk-tool-visibility — do registry tools actually reach the model?
 *
 * Born from the V8.5 Phase-1 SDK 0.3.207 gate FAIL (2026-07-12): tool_selection
 * dropped 57.95→53.59 and warm-call prompts shrank ~23k tokens — the size of
 * the tool-schema block — suggesting the SDK/CLI defers MCP tools behind tool
 * search despite `createSdkMcpServer({ alwaysLoad: true })`. This harness makes
 * the question observable: it asks the model to LIST the tools it can see
 * (no tool call, 1 turn) over a representative registry slice, twice (cold +
 * warm cache), and prints the list + usage accounting.
 *
 * Interpretation: a healthy run lists the real tool names. A deferral
 * regression lists a search/discovery tool (or a truncated set) — and the
 * warm call's prompt tokens undercount the schema block.
 *
 * Real spend (~$0.15 for two calls) — gated behind --run per convention.
 */

import { chmodSync, copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initDatabase } from "../src/db/index.js";
import { toolRegistry } from "../src/tools/registry.js";
import { ToolSourceManager } from "../src/tools/source.js";
import { BuiltinToolSource } from "../src/tools/sources/builtin.js";
import { queryClaudeSdk } from "../src/inference/claude-sdk.js";

const N_TOOLS = 30;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function main(): Promise<number> {
  if (!process.argv.includes("--run")) {
    console.log("DRY — pass --run to spend (~$0.15, two SDK calls).");
    return 3;
  }

  // Never open the live irreplaceable mc.db — initDatabase is a write path
  // (WAL pragma + DDL). Snapshot per the CLAUDE.md validation-harness
  // convention (qa-audit W1 2026-07-12); tool-source init only needs the
  // registry, but it runs against whatever DB is opened.
  const snapDir = mkdtempSync(join(tmpdir(), "sdk-tool-vis-"));
  const snapPath = join(snapDir, "mc.db");
  for (const suffix of ["", "-wal", "-shm"]) {
    const src = join(ROOT, "data", `mc.db${suffix}`);
    if (existsSync(src)) copyFileSync(src, `${snapPath}${suffix}`);
  }
  chmodSync(snapPath, 0o600);
  initDatabase(snapPath);
  const sourceManager = new ToolSourceManager();
  sourceManager.addSource(new BuiltinToolSource());
  await sourceManager.initAll(toolRegistry);

  const toolNames = toolRegistry.list().slice(0, N_TOOLS);
  console.log(
    `registry slice (${toolNames.length}): ${toolNames.join(", ")}\n`,
  );

  for (const label of ["cold", "warm"] as const) {
    const r = await queryClaudeSdk({
      prompt:
        "Without calling any tool, list the exact names of every tool you can call right now, one per line, then stop.",
      systemPrompt:
        "You are a diagnostic probe. Answer precisely and only from what is actually available to you.",
      toolNames,
      maxTurns: 1,
    });
    console.log(`--- ${label} ---`);
    console.log(r.text);
    console.log(
      `usage: prompt=${r.usage.promptTokens} (read=${r.usage.cacheReadTokens}, created=${r.usage.cacheCreationTokens}) completion=${r.usage.completionTokens} cost=$${r.costUsd.toFixed(4)}`,
    );
    const listed = toolNames.filter((n) => r.text.includes(n)).length;
    console.log(
      `visible: ${listed}/${toolNames.length} registry names in reply\n`,
    );
  }
  return 0;
}

process.exit(await main());
