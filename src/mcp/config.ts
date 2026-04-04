/**
 * MCP configuration loader — reads mcp-servers.json.
 */

import { readFileSync, existsSync } from "fs";
import { getConfig } from "../config.js";
import type { McpConfig, McpServerConfig } from "./types.js";

/**
 * Load MCP server configuration from JSON file.
 * Returns null if the config file doesn't exist (graceful).
 * Throws on malformed data.
 */
export function loadMcpConfig(): McpConfig | null {
  const configPath = getConfig().mcpConfigPath ?? "./mcp-servers.json";

  if (!existsSync(configPath)) {
    return null;
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to read MCP config at ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in MCP config at ${configPath}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `MCP config must be a JSON object mapping server IDs to configs`,
    );
  }

  // Validate each entry
  for (const [serverId, entry] of Object.entries(parsed)) {
    const config = entry as McpServerConfig;
    if (!config || typeof config.command !== "string" || !config.command) {
      throw new Error(
        `MCP server "${serverId}": "command" must be a non-empty string`,
      );
    }
    // Validate lazy tool definitions
    if (config.lazy && config.tools) {
      for (const [i, tool] of config.tools.entries()) {
        if (!tool || typeof tool.name !== "string" || !tool.name) {
          throw new Error(
            `MCP server "${serverId}": tools[${i}].name must be a non-empty string`,
          );
        }
      }
    }
  }

  return parsed as McpConfig;
}
