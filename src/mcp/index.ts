/**
 * MCP integration barrel — init and shutdown.
 */

import { McpManager } from "./manager.js";
import { loadMcpConfig } from "./config.js";
import { toolRegistry } from "../tools/registry.js";

let _manager: McpManager | null = null;

/** Initialize MCP tool servers. No-op if config doesn't exist. */
export async function initMcp(): Promise<void> {
  const config = loadMcpConfig();
  if (!config) {
    console.log("[mcp] No MCP config found, skipping");
    return;
  }

  const serverCount = Object.keys(config).length;
  if (serverCount === 0) {
    console.log("[mcp] MCP config is empty, skipping");
    return;
  }

  _manager = new McpManager();
  await _manager.init(config, toolRegistry);
}

/**
 * Wire MCP alerts to a broadcast function (e.g., Telegram).
 * Call after messaging router is ready.
 */
export function setMcpAlertFn(fn: (msg: string) => void): void {
  if (_manager) {
    _manager.setAlertFn(fn);
  }
}

/** Shut down all MCP server connections. */
export async function shutdownMcp(): Promise<void> {
  if (_manager) {
    await _manager.shutdown();
    _manager = null;
  }
}
