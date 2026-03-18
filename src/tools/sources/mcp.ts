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
    description: "MCP server tools (commit-bridge, etc.)",
  };

  private manager: McpManager | null = null;
  private config: McpConfig | null = null;

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
