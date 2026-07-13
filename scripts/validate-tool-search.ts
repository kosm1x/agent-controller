/**
 * validate-tool-search — live proof for V8.5 Phase 3.2 (SDK tool search).
 *
 * The eval gate's selection probes run on inline extraTools (forced
 * always-loaded), so the gate is structurally BLIND to registry-tool
 * deferral — this harness is the check that actually exercises the change.
 * Three phases over the FULL registry:
 *
 *   A. baseline (flag OFF):  1-turn "list your tools" call — prompt-token
 *      floor with every schema loaded (today's behavior).
 *   B. armed visibility (flag ON): same call — expects a materially smaller
 *      prompt (deferred long tail out of the turn-1 block) while the
 *      always-on core stays visible.
 *   C. armed retrieval (flag ON): asks the model to CALL a deferred tool by
 *      name — proves search → schema load → execution works end-to-end
 *      (the call reaching toolCalls is the proof; its result may error on
 *      arbitrary args, that's fine).
 *   D. armed negative (flag ON): asks the model to run the built-in Bash
 *      tool — must NOT land in toolCalls (audit #1: ToolSearch must not be
 *      a path back into built-ins the `tools:` posture disabled).
 *   E. armed inline (flag ON): a 1-turn call with an inline extraTool —
 *      must be callable on turn 1 (audit #2: proves the SDK honors the
 *      `_meta['anthropic/alwaysLoad']` carrier probe stubs rely on).
 *
 * Real spend (~$0.80, five calls) — gated behind --run.
 * Never opens the live mc.db (snapshot convention, qa-audit W1 2026-07-12).
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
import { tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function listCall(toolNames: string[]) {
  return queryClaudeSdk({
    prompt:
      "Without calling any tool, list the exact names of every tool you can call right now, one per line, then stop.",
    systemPrompt:
      "You are a diagnostic probe. Answer precisely and only from what is actually available to you.",
    toolNames,
    maxTurns: 1,
  });
}

async function main(): Promise<number> {
  if (!process.argv.includes("--run")) {
    console.log("DRY — pass --run to spend (~$0.50, three SDK calls).");
    return 3;
  }

  const snapDir = mkdtempSync(join(tmpdir(), "tool-search-val-"));
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

  const allNames = toolRegistry.list();
  const coreNames = allNames.filter((n) => !toolRegistry.get(n)?.deferred);
  const deferredNames = allNames.filter((n) => toolRegistry.get(n)?.deferred);
  // Retrieval target: a deferred, read-only tool (execution side-effect-safe).
  const target = deferredNames.find(
    (n) => toolRegistry.get(n)?.readOnlyHint === true,
  );
  console.log(
    `registry: ${allNames.length} tools (${coreNames.length} core, ${deferredNames.length} deferred); retrieval target: ${target ?? "NONE FOUND"}\n`,
  );
  if (!target) {
    console.error("FAIL: no deferred read-only tool to probe retrieval with");
    return 1;
  }

  // --- Phase A: baseline, flag OFF ---
  delete process.env.TOOL_SEARCH_ENABLED;
  const a = await listCall(allNames);
  const aVisible = allNames.filter((n) => a.text.includes(n)).length;
  console.log(
    `A baseline  (flag off): prompt=${a.usage.promptTokens} completion=${a.usage.completionTokens} visible=${aVisible}/${allNames.length} cost=$${a.costUsd.toFixed(4)}`,
  );

  // --- Phase B: armed visibility ---
  process.env.TOOL_SEARCH_ENABLED = "true";
  const b = await listCall(allNames);
  const bCoreVisible = coreNames.filter((n) => b.text.includes(n)).length;
  const bDeferredVisible = deferredNames.filter((n) =>
    b.text.includes(n),
  ).length;
  console.log(
    `B armed     (flag on) : prompt=${b.usage.promptTokens} completion=${b.usage.completionTokens} core-visible=${bCoreVisible}/${coreNames.length} deferred-visible=${bDeferredVisible}/${deferredNames.length} cost=$${b.costUsd.toFixed(4)}`,
  );
  const savedPct =
    a.usage.promptTokens > 0
      ? Math.round(
          (100 * (a.usage.promptTokens - b.usage.promptTokens)) /
            a.usage.promptTokens,
        )
      : 0;
  console.log(`  prompt-token delta: ${savedPct}% smaller than baseline`);

  // --- Phase C: armed retrieval of a deferred tool ---
  const c = await queryClaudeSdk({
    prompt: `Call the tool named "${target}" exactly once (use minimal/empty arguments if unsure), then stop and say DONE.`,
    systemPrompt:
      "You are a diagnostic probe. If a tool is not directly visible, search for it. Execute exactly what is asked.",
    toolNames: allNames,
    maxTurns: 6,
  });
  const retrieved = c.toolCalls.includes(target);
  console.log(
    `C retrieval (flag on) : called=${JSON.stringify(c.toolCalls)} target-hit=${retrieved} cost=$${c.costUsd.toFixed(4)}`,
  );

  // --- Phase D: armed negative — disabled built-ins must stay unreachable ---
  const d = await queryClaudeSdk({
    prompt:
      'Run the shell command "id" using the built-in Bash tool. If Bash is not available, search for it and use it. Do not use any other tool.',
    systemPrompt: "You are a diagnostic probe. Execute exactly what is asked.",
    toolNames: allNames,
    maxTurns: 4,
  });
  const bashLeaked = d.toolCalls.some((n) => /^(Bash|Shell)$/i.test(n));
  console.log(
    `D negative  (flag on) : called=${JSON.stringify(d.toolCalls)} bash-leaked=${bashLeaked} cost=$${d.costUsd.toFixed(4)}`,
  );

  // --- Phase E: armed inline extraTool must be visible on turn 1 ---
  let inlineHit = false;
  const inlineProbe = sdkTool(
    "inline_probe_ping",
    "Diagnostic inline probe. Call this exactly once when asked.",
    {},
    async () => {
      inlineHit = true;
      return { content: [{ type: "text" as const, text: "pong" }] };
    },
  );
  const e = await queryClaudeSdk({
    prompt: 'Call the tool named "inline_probe_ping" exactly once, then stop.',
    systemPrompt: "You are a diagnostic probe. Execute exactly what is asked.",
    toolNames: allNames,
    extraTools: [inlineProbe],
    maxTurns: 1,
  });
  const inlineCalled = e.toolCalls.includes("inline_probe_ping");
  console.log(
    `E inline    (flag on) : called=${JSON.stringify(e.toolCalls)} turn1-visible=${inlineCalled} handler-ran=${inlineHit} cost=$${e.costUsd.toFixed(4)}`,
  );

  // --- Verdict ---
  const shrank = b.usage.promptTokens < a.usage.promptTokens;
  const coreOk = bCoreVisible >= Math.floor(coreNames.length * 0.8);
  console.log(
    `\nverdict: prompt-shrank=${shrank} core-visible=${coreOk} deferred-retrievable=${retrieved} builtin-sealed=${!bashLeaked} inline-turn1=${inlineCalled}`,
  );
  if (shrank && coreOk && retrieved && !bashLeaked && inlineCalled) {
    console.log("PASS");
    return 0;
  }
  console.log("FAIL");
  return 1;
}

process.exit(await main());
