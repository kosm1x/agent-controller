import { describe, expect, it } from "vitest";
import { shellTool } from "./shell.js";
import { fileDeleteTool, fileWriteTool } from "./file.js";
import { fileEditTool } from "./code-editing.js";
import {
  gitCommitTool,
  gitDiffTool,
  gitPushTool,
  gitStatusTool,
} from "./git.js";
import { wrapToolCached } from "../../inference/claude-sdk.js";

/**
 * With TOOL_SEARCH_ENABLED the SDK loads `deferred: true` tools only after a
 * ToolSearch hit. Tasks 8958/8961/8962/8963 (2026-09-01): on a coding-scoped
 * chat the model searched ONCE, missed, and replied "Necesito `shell_exec`
 * para esto." → STATUS: BLOCKED — while the tool was in scope the whole time.
 * The core coding set must be visible on turn 1; deferral stays for the long
 * tail (file_delete, gh_*, code_search, …).
 */
describe("core coding tools are always-loaded under tool search", () => {
  it.each([
    ["shell_exec", shellTool],
    ["file_write", fileWriteTool],
    ["file_edit", fileEditTool],
    ["git_status", gitStatusTool],
    ["git_diff", gitDiffTool],
    ["git_commit", gitCommitTool],
    ["git_push", gitPushTool],
  ])("%s is not deferred", (name, tool) => {
    expect(tool.name).toBe(name);
    expect(tool.deferred).toBeFalsy();
  });

  // qa R1 #7: the flag is the cause, the SDK carrier is the observable —
  // compose the REAL tool through the SDK wrap so a second gate inside it
  // cannot leave both halves green. The real `tool()` stores alwaysLoad as
  // `_meta["anthropic/alwaysLoad"] = true` and omits `_meta` when deferred.
  const alwaysLoadOf = (tool: typeof shellTool): unknown =>
    (wrapToolCached(tool) as unknown as { _meta?: Record<string, unknown> })
      ._meta?.["anthropic/alwaysLoad"];

  it.each([
    shellTool,
    fileWriteTool,
    fileEditTool,
    gitStatusTool,
    gitDiffTool,
    gitCommitTool,
    gitPushTool,
  ])("$name wraps with the SDK alwaysLoad carrier", (tool) => {
    expect(alwaysLoadOf(tool)).toBe(true);
  });

  it("a long-tail tool (file_delete) does NOT carry it — the assertion discriminates", () => {
    expect(fileDeleteTool.deferred).toBe(true);
    expect(alwaysLoadOf(fileDeleteTool)).toBeUndefined();
  });
});
