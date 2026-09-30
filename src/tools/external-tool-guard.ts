/**
 * Tool guard for an EXTERNAL request (jarvis-pull). Applied on both execution
 * paths of the fast runner: the OpenAI path wraps its executor with
 * `externalToolGuard`; the Claude SDK path (`wrapTool` in claude-sdk.ts) calls
 * `externalToolRefusal` / `filterExternalToolResult` when the run's execution
 * context carries `externalTools`.
 *
 * 1. A tool not in the run's list never executes.
 * 2. `jarvis_file_read` of a malformed path (traversal, backslash) never
 *    executes. Otherwise the read runs (it has no side effects) and its
 *    result is checked against the row it returned: path AND tags
 *    (src/lib/external-kb-policy.ts). A row outside the policy — and a
 *    "not found" for a path outside the seed prefixes — both answer
 *    `path not available`, so the reply is no existence oracle.
 * 3. What the policy can see per output:
 *    - `jarvis_file_read` by path: the row's own `tags` → full policy.
 *    - `jarvis_file_read` by tags (`results[]`): each entry carries `tags` →
 *      full policy. This is how the model finds rows tagged `external`.
 *    - `related[]` ({path,title}), `jarvis_file_search` and
 *      `jarvis_file_list` carry no tags → seed prefixes only; a tag-only row
 *      is not listed there (it is reachable through the tag read).
 *    - `jarvis_file_list` always runs at its max limit and never says
 *      "… more" (`externalToolArgs`), so a count cannot leak private rows.
 * 4. An output this guard cannot parse is refused (fail closed).
 */

import type { ToolExecutor } from "../inference/adapter.js";
import {
  isExternalKbPathShapeOk,
  isExternalKbRowAllowed,
  type ExternalKbRowRef,
} from "../lib/external-kb-policy.js";

export const TOOL_NOT_AVAILABLE = JSON.stringify({
  error: "tool not available on this path",
});
export const PATH_NOT_AVAILABLE = JSON.stringify({
  error: "path not available on this path",
});
export const RESULT_NOT_AVAILABLE = JSON.stringify({
  error: "result not available on this path",
});

/** Refusal text for a call that must not execute, or null to run it. */
export function externalToolRefusal(
  name: string,
  args: Record<string, unknown>,
  allowed: readonly string[],
): string | null {
  if (!allowed.includes(name)) return TOOL_NOT_AVAILABLE;
  if (
    name === "jarvis_file_read" &&
    args.path != null &&
    !isExternalKbPathShapeOk(args.path)
  ) {
    return PATH_NOT_AVAILABLE;
  }
  return null;
}

/** Max `limit` of jarvis_file_list (src/tools/builtin/jarvis-files.ts). */
const FILE_LIST_MAX = 500;

/**
 * Arguments an external call actually runs with. `jarvis_file_list` always
 * runs at its max limit and its filtered output never says "… more": with a
 * caller-chosen limit, "more" after filtering would count private rows.
 */
export function externalToolArgs(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return name === "jarvis_file_list" ? { ...args, limit: FILE_LIST_MAX } : args;
}

/** Seed-prefix test for an entry whose output carries no tags. */
const pathOnlyOk = (path: unknown): boolean => isExternalKbRowAllowed({ path });

function filterFileRead(raw: string, args: Record<string, unknown>): string {
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return RESULT_NOT_AVAILABLE;
    }
    obj = parsed as Record<string, unknown>;
  } catch {
    return RESULT_NOT_AVAILABLE;
  }
  if (typeof obj.error === "string") {
    // "File not found" for a path the caller may not know exists → same
    // answer as a private row. Errors without a path (bad args) pass.
    return args.path != null && !pathOnlyOk(args.path)
      ? PATH_NOT_AVAILABLE
      : raw;
  }
  if (typeof obj.path === "string") {
    if (!isExternalKbRowAllowed({ path: obj.path, tags: obj.tags })) {
      return PATH_NOT_AVAILABLE;
    }
    if (Array.isArray(obj.related)) {
      obj.related = obj.related.filter(
        (e) => !!e && typeof e === "object" && pathOnlyOk((e as { path?: unknown }).path),
      );
    }
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj.results)) {
    obj.results = obj.results.filter(
      (e) =>
        !!e &&
        typeof e === "object" &&
        isExternalKbRowAllowed(e as ExternalKbRowRef),
    );
    if ("total" in obj) obj.total = (obj.results as unknown[]).length;
    return JSON.stringify(obj);
  }
  return RESULT_NOT_AVAILABLE;
}

const SEARCH_HEADER_RE = /^🔍 (\d+) files matching (.*)$/;
const SEARCH_BLOCK_RE = /^\[(.+?)\] \(\d+ bytes\)/;

/**
 * `🔍 N files matching "q":`, a blank line, then one block per hit:
 * `[path] (size bytes)…` + snippet line(s), each block ended by a blank line.
 * Parsed as blank-line-separated blocks: a block is kept only when its FIRST
 * line is a header whose path passes; a block without a header is dropped.
 * A snippet is row content and may carry a forged header after a blank line
 * — that makes more header blocks than the N the tool reported, and the
 * whole result is refused.
 */
function filterFileSearch(raw: string): string {
  if (raw.startsWith("No files found matching ")) return raw;
  const lines = raw.split("\n");
  const header = SEARCH_HEADER_RE.exec(lines[0] ?? "");
  if (!header || (lines[1] ?? "") !== "") return RESULT_NOT_AVAILABLE;

  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of lines.slice(2)) {
    if (line === "") {
      if (current.length) blocks.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current);

  const headed = blocks.filter((b) => SEARCH_BLOCK_RE.test(b[0]!));
  if (headed.length !== Number(header[1])) return RESULT_NOT_AVAILABLE;

  const kept = headed.filter((b) => pathOnlyOk(SEARCH_BLOCK_RE.exec(b[0]!)![1]));
  const query = header[2]!.replace(/:$/, "");
  if (kept.length === 0) {
    return `No files found matching ${query} in the Knowledge Base.`;
  }
  const out = [`🔍 ${kept.length} files matching ${query}:`, ""];
  for (const b of kept) out.push(...b, "");
  return out.join("\n");
}

/**
 * `📂 **N files**` + `  <path> (<size>, <qualifier>)` lines + optional
 * `  … more`. The more line is dropped and an empty result is always the
 * tool's own empty text, so a private prefix reads exactly like an empty one.
 */
function filterFileList(raw: string): string {
  const lines = raw.split("\n");
  if (!/^📂 \*\*\d+ files\*\*$/.test(lines[0] ?? "")) {
    return raw === "📂 No files found." ? raw : RESULT_NOT_AVAILABLE;
  }
  const kept: string[] = [];
  for (const line of lines.slice(1)) {
    const entry = /^ {2}(.+) \([^()]*\)$/.exec(line);
    if (entry && pathOnlyOk(entry[1])) kept.push(line);
  }
  if (kept.length === 0) return "📂 No files found.";
  return [`📂 **${kept.length} files**`, ...kept].join("\n");
}

/** Drop policy-failing KB entries from a tool's raw output. */
export function filterExternalToolResult(
  name: string,
  raw: string,
  args: Record<string, unknown> = {},
): string {
  switch (name) {
    case "jarvis_file_read":
      return filterFileRead(raw, args);
    case "jarvis_file_search":
      return filterFileSearch(raw);
    case "jarvis_file_list":
      return filterFileList(raw);
    default:
      return raw;
  }
}

/** The OpenAI-path executor for an external run. */
export function externalToolGuard(
  executor: ToolExecutor,
  tools: readonly string[],
): ToolExecutor {
  return async (name, args) => {
    const refusal = externalToolRefusal(name, args, tools);
    if (refusal) return refusal;
    const runArgs = externalToolArgs(name, args);
    return filterExternalToolResult(name, await executor(name, runArgs), runArgs);
  };
}
