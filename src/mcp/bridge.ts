/**
 * MCP tool bridge — wraps an MCP tool as a Mission Control Tool.
 *
 * Handles schema conversion (MCP inputSchema → OpenAI ToolDefinition)
 * and execution proxying (toolRegistry.execute → client.callTool).
 */

import type { Tool } from "../tools/types.js";
import { MCP_NAMESPACE_SEP } from "./types.js";
import { validateArgsUrlsResolved } from "../lib/url-safety.js";
import { getMcpToolHints } from "./annotations.js";
import type { McpToolHintOverride } from "./annotations.js";
import { errMsg } from "../lib/err-msg.js";
import { scrubSecrets } from "../lib/secret-refs.js";

/** The four MCP-spec hints a server may return with a tool (all optional). */
export interface McpServerAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** MCP tool info as returned by client.listTools(). */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** `tools/list` annotations, when the server ships them. */
  annotations?: McpServerAnnotations;
}

const HINT_KEYS = [
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
] as const;

/**
 * S6 WS3 — the hints an MCP tool registers with, per field in order of
 * preference: (1) the server's own `tools/list` annotations (the manager
 * passes them for RECORD servers only — service servers keep the curated
 * table, audit R1 W1), (2) the
 * record's per-tool `destructive` flag, (3) the name-pattern lookup
 * (`getMcpToolHints`). Undefined when no level says anything, so the
 * registry's conservative-unknown defaults (destructive) apply. A field the
 * server leaves out falls to the next level; a read-only tool with no
 * destructive hint anywhere is non-destructive (MCP spec: destructiveHint
 * is meaningful only when readOnlyHint is false).
 */
export function resolveMcpToolHints(
  namespacedName: string,
  serverAnnotations?: McpServerAnnotations,
  recordFlags?: { destructive?: boolean },
): McpToolHintOverride | undefined {
  const record: McpToolHintOverride | undefined =
    recordFlags?.destructive === undefined
      ? undefined
      : {
          readOnlyHint: false,
          destructiveHint: recordFlags.destructive,
          idempotentHint: false,
          openWorldHint: true,
        };
  const base = record ?? getMcpToolHints(namespacedName);
  const server = Object.fromEntries(
    HINT_KEYS.filter((k) => typeof serverAnnotations?.[k] === "boolean").map(
      (k) => [k, serverAnnotations![k] as boolean],
    ),
  ) as Partial<McpToolHintOverride>;
  if (!base && Object.keys(server).length === 0) return undefined;
  const readOnlyHint = server.readOnlyHint ?? base?.readOnlyHint ?? false;
  return {
    readOnlyHint,
    destructiveHint:
      server.destructiveHint ??
      (server.readOnlyHint === true ? false : undefined) ??
      base?.destructiveHint ??
      !readOnlyHint,
    idempotentHint: server.idempotentHint ?? base?.idempotentHint ?? false,
    openWorldHint: server.openWorldHint ?? base?.openWorldHint ?? true,
  };
}

/** MCP callTool result content item. */
export interface McpContentItem {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** MCP callTool result shape. */
export interface McpCallResult {
  content: McpContentItem[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Function that calls an MCP tool on the server. */
export type McpCallFn = (
  name: string,
  args: Record<string, unknown>,
) => Promise<McpCallResult>;

/** Extract text from MCP result content array. */
export function extractText(content: McpContentItem[]): string {
  const texts = content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string);
  return texts.length > 0 ? texts.join("\n") : "[No text content returned]";
}

/** One labelled line for a non-text content item (payloads never inlined). */
function renderItem(item: McpContentItem): string {
  const s = (v: unknown): string => (typeof v === "string" ? v : "");
  switch (item.type) {
    case "resource_link":
      return `[resource_link] ${s(item.name)} ${s(item.uri)} ${s(item.mimeType)} ${s(item.description)}`
        .replace(/\s+/g, " ")
        .trim();
    case "resource": {
      const r = (item.resource ?? {}) as Record<string, unknown>;
      const len = typeof r.text === "string" ? r.text.length : s(r.blob).length;
      return `[resource] ${s(r.uri)} ${s(r.mimeType)} (${len} chars)`.replace(
        /\s+/g,
        " ",
      );
    }
    case "image":
    case "audio":
      return `[${item.type}] ${s(item.mimeType) || "unknown"} ${s(item.data).length} bytes base64 (not forwarded on this path)`;
    default:
      return `[${item.type ?? "unknown"}]`;
  }
}

/** Key-order-insensitive JSON equality (text item vs structuredContent). */
const sortKeys = (_k: string, v: unknown): unknown =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(
        Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      )
    : v;
function sameJson(text: string, value: unknown): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return JSON.stringify(parsed, sortKeys) === JSON.stringify(value, sortKeys);
  } catch {
    return false;
  }
}

/**
 * L2 (2026-10-09) — the whole MCP result on the string tool-result contract:
 * text items first (joined as extractText does), then `structuredContent` as a
 * JSON block always labelled `[structured]` (so a result never starts with
 * `{"error"` unless the server wrote that text) and omitted when a text item
 * already carries the same JSON (the spec's SHOULD), then one labelled line
 * per non-text item.
 * Images/audio are not forwarded on this path (vision input exists only for
 * user images: inference/claude-sdk.ts buildVisionPromptStream). No cap here:
 * the existing caps own size (adapter-openai.ts MAX_TOOL_RESULT_CHARS
 * eviction; the SDK path passes the string through sanitizeToolResult +
 * scrub). No configured server emits `structuredContent` yet: that half is
 * forward-compatible (the SDK already validates it against an outputSchema).
 */
export function renderResult(result: McpCallResult): string {
  const content = result.content ?? [];
  const parts: string[] = [];
  const texts = content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string);
  const structured = result.structuredContent;
  const joined = texts.join("\n");
  if (
    texts.length > 0 &&
    (structured === undefined || texts.some((t) => t !== ""))
  ) {
    parts.push(joined);
  }
  if (structured !== undefined) {
    // Plain stringify first: a circular value throws here (execute's catch).
    const json = JSON.stringify(structured);
    if (!texts.some((t) => sameJson(t, structured))) {
      parts.push(`${parts.length > 0 ? "\n" : ""}[structured]\n${json}`);
    }
  }
  const items = content
    .filter((item) => item.type !== "text")
    .map(renderItem)
    .join("\n");
  if (items) parts.push(items);
  return parts.length > 0 ? parts.join("\n") : "[No text content returned]";
}

/**
 * Create a Mission Control Tool from an MCP tool definition.
 * The tool name is namespaced as: serverId__toolName.
 * When `deferred` is true, the tool's full schema is excluded from initial
 * context — only name + description are sent. The executor returns the full
 * schema on first call so the LLM can retry with correct arguments.
 */
export function createMcpTool(
  serverId: string,
  mcpTool: McpToolInfo,
  callFn: McpCallFn,
  deferred = false,
  recordFlags?: { destructive?: boolean },
): Tool {
  const namespacedName = `${serverId}${MCP_NAMESPACE_SEP}${mcpTool.name}`;

  // v7.6 Spine 4 W4 (shipped 2026-05-09): hint override by name pattern,
  // so an unannotated MCP tool does not fall back to getToolAnnotations
  // defaults (destructive: true) and pollute the destructive-cohort metric
  // mc-ctl audit-claim reports. S6 WS3: the server's own annotations and
  // the record's per-tool flags come first (resolveMcpToolHints).
  const hints = resolveMcpToolHints(
    namespacedName,
    mcpTool.annotations,
    recordFlags,
  );

  return {
    name: namespacedName,
    deferred,
    ...(hints && {
      readOnlyHint: hints.readOnlyHint,
      destructiveHint: hints.destructiveHint,
      idempotentHint: hints.idempotentHint,
      openWorldHint: hints.openWorldHint,
    }),
    definition: {
      type: "function",
      function: {
        name: namespacedName,
        description: mcpTool.description ?? "",
        parameters: (mcpTool.inputSchema as Record<string, unknown>) ?? {
          type: "object",
          properties: {},
        },
      },
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      // v7.6.1 — Pillar 6 SSRF defense: pre-flight URL validation across
      // ALL MCP tool calls (lightpanda, playwright, future servers).
      // Blocks file://, private IPs, cloud metadata, localhost BEFORE
      // the args reach the upstream MCP server. Catches the SSRF class
      // that Playwright's UnsupportedProtocol allowlist would miss
      // (http://localhost:*, http://10.x, etc.). See V7-READINESS-CRITERIA.md
      // Known Issues for the full threat model.
      // 2026-09-22: resolved — a public name pointing at loopback is refused too.
      const urlError = await validateArgsUrlsResolved(args);
      if (urlError) {
        // Args here may carry a resolved secret (ruling 3c): scrub the log.
        console.warn(
          `[mcp] blocked URL-bearing arg on ${namespacedName}: ${scrubSecrets(urlError)}`,
        );
        return JSON.stringify({
          error: `Blocked outbound URL: ${urlError}`,
        });
      }

      try {
        const result = await callFn(mcpTool.name, args);
        const text = renderResult(result);
        if (result.isError) {
          return JSON.stringify({ error: text });
        }
        return text;
      } catch (err) {
        return JSON.stringify({
          error: errMsg(err),
        });
      }
    },
  };
}
