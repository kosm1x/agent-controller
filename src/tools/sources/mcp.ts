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
import { registerRecordMcpRuleOfTwo } from "../rule-of-two.js";

export class McpToolSource implements ToolSource {
  readonly manifest: ToolSourceManifest = {
    name: "mcp",
    version: "1.0.0",
    description: "MCP server tools",
  };

  private manager: McpManager | null = null;
  private config: McpConfig | null = null;
  private alertFn: ((msg: string) => void) | null = null;
  /** S6 WS3: refused record servers, delivered once an alert channel exists. */
  private configAlerts: string[] = [];

  private deliverConfigAlerts(): void {
    if (!this.alertFn) return;
    const pending = this.configAlerts;
    this.configAlerts = [];
    for (const msg of pending) {
      try {
        this.alertFn(msg);
      } catch {
        /* non-fatal */
      }
    }
  }

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
    this.deliverConfigAlerts();
  }

  async initialize(): Promise<void> {
    this.config = loadMcpConfig({
      onRefused: (msg) => this.configAlerts.push(msg),
    });
    this.deliverConfigAlerts();
    if (!this.config || Object.keys(this.config).length === 0) {
      console.log("[mcp] No MCP config found, skipping");
      this.config = null;
      return;
    }
    // Before any server connects: the boot trifecta check reads these.
    registerRecordMcpRuleOfTwo(this.config);
  }

  /** S6 WS3: slug → ids of its record servers that load (trusted). */
  recordServerIds(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const [id, c] of Object.entries(this.config ?? {})) {
      if (c.source?.kind !== "record" || !c.source.trusted || c.enabled === false) continue;
      out.set(c.source.slug, [...(out.get(c.source.slug) ?? []), id]);
    }
    return out;
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
