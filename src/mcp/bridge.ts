/**
 * MCP tool bridge — wraps an MCP tool as a Mission Control Tool.
 *
 * Handles schema conversion (MCP inputSchema → OpenAI ToolDefinition)
 * and execution proxying (toolRegistry.execute → client.callTool).
 */

import type { Tool } from "../tools/types.js";
import { MCP_NAMESPACE_SEP } from "./types.js";

/** MCP tool info as returned by client.listTools(). */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
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

/**
 * Create a Mission Control Tool from an MCP tool definition.
 * The tool name is namespaced as: serverId__toolName.
 */
export function createMcpTool(
  serverId: string,
  mcpTool: McpToolInfo,
  callFn: McpCallFn,
): Tool {
  const namespacedName = `${serverId}${MCP_NAMESPACE_SEP}${mcpTool.name}`;

  return {
    name: namespacedName,
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
      try {
        const result = await callFn(mcpTool.name, args);
        const text = extractText(result.content);
        if (result.isError) {
          return JSON.stringify({ error: text });
        }
        return text;
      } catch (err) {
        return JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
