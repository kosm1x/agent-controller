/**
 * MCP tool source — wraps McpManager for tool server integration.
 */

import type { ToolRegistry } from "../registry.js";
import type {
  ToolSource,
  ToolSourceManifest,
  ToolSourceHealth,
} from "../source.js";
import { McpManager } from "../../mcp/manager.js";
import { loadMcpConfig } from "../../mcp/config.js";
import type { McpConfig } from "../../mcp/types.js";

export class McpToolSource implements ToolSource {
  readonly manifest: ToolSourceManifest = {
    name: "mcp",
    version: "1.0.0",
    description: "MCP server tools",
  };

  private manager: McpManager | null = null;
  private config: McpConfig | null = null;
  private alertFn: ((msg: string) => void) | null = null;

  /**
   * Wire MCP degradation/recovery alerts to a broadcast function (e.g. the
   * messaging router). This is the LIVE manager — the old src/mcp/index.ts
   * barrel held a separate `_manager` that was never initialized, so alert
   * wiring through it was a permanent no-op (alerts fell back to
   * console.warn only). Safe to call before or after registerTools.
   */
  setAlertFn(fn: (msg: string) => void): void {
    this.alertFn = fn;
    this.manager?.setAlertFn(fn);
  }

  async initialize(): Promise<void> {
    this.config = loadMcpConfig();
    if (!this.config || Object.keys(this.config).length === 0) {
      console.log("[mcp] No MCP config found, skipping");
      this.config = null;
    }
  }

  async registerTools(registry: ToolRegistry): Promise<string[]> {
    if (!this.config) return [];

    const beforeTools = new Set(registry.list());
    this.manager = new McpManager();
    if (this.alertFn) this.manager.setAlertFn(this.alertFn);
    await this.manager.init(this.config, registry);
    const afterTools = registry.list();

    return afterTools.filter((t) => !beforeTools.has(t));
  }

  async healthCheck(): Promise<ToolSourceHealth> {
    if (!this.manager) {
      return {
        healthy: true,
        message: "No MCP servers configured",
        checkedAt: new Date().toISOString(),
      };
    }
    const ids = this.manager.getServerIds();
    return {
      healthy: ids.length > 0,
      message: `${ids.length} server(s) connected`,
      checkedAt: new Date().toISOString(),
    };
  }

  async teardown(): Promise<void> {
    if (this.manager) {
      await this.manager.shutdown();
      this.manager = null;
    }
  }
}
