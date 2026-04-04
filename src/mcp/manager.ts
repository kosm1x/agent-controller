/**
 * MCP client manager — connects to MCP servers and registers their tools.
 *
 * Includes automatic reconnection for servers that fail on startup or
 * disconnect later, with Telegram alerts on degradation and recovery.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpConfig, McpServerConfig } from "./types.js";
import { MCP_NAMESPACE_SEP } from "./types.js";
import { createMcpTool } from "./bridge.js";
import type { McpCallResult } from "./bridge.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { Tool } from "../tools/types.js";

/** Internal state for a connected MCP server. */
interface ServerEntry {
  client: Client;
  transport: StdioClientTransport;
  toolNames: string[];
}

/** State for a lazy server pending first tool call. */
interface LazyServerEntry {
  config: McpServerConfig;
  toolNames: string[];
  connecting?: Promise<void>;
}

const CONNECT_TIMEOUT_MS = 10_000;
const RECONNECT_INTERVAL_MS = 60_000; // retry failed servers every 60s
const MAX_RECONNECT_ATTEMPTS = 10; // stop retrying after 10 failures

export class McpManager {
  private servers = new Map<string, ServerEntry>();
  private lazyServers = new Map<string, LazyServerEntry>();
  private failedServers = new Map<
    string,
    { config: McpServerConfig; attempts: number }
  >();
  private registry: ToolRegistry | null = null;
  private reconnectTimer: ReturnType<typeof setInterval> | null = null;
  private alertFn: ((msg: string) => void) | null = null;
  private isShutdown = false;

  /** Set alert callback for degradation/recovery notifications. */
  setAlertFn(fn: (msg: string) => void): void {
    this.alertFn = fn;
  }

  private alert(msg: string): void {
    console.warn(msg);
    if (this.alertFn) {
      try {
        this.alertFn(msg);
      } catch {
        /* non-fatal */
      }
    }
  }

  /**
   * Connect to all configured MCP servers and register their tools.
   * Each server is independent — one failure doesn't block others.
   * Failed servers are queued for automatic reconnection.
   */
  async init(config: McpConfig, registry: ToolRegistry): Promise<void> {
    this.registry = registry;
    const serverIds = Object.keys(config);
    let connected = 0;
    let totalTools = 0;

    let lazyCount = 0;

    for (const serverId of serverIds) {
      const serverConfig = config[serverId];
      if (serverConfig.enabled === false) {
        console.log(`[mcp] ${serverId}: skipped (disabled)`);
        continue;
      }

      // Lazy servers: register proxy tools without spawning the process
      if (serverConfig.lazy && serverConfig.tools?.length) {
        const toolNames = this.registerLazyServer(
          serverId,
          serverConfig,
          registry,
        );
        lazyCount++;
        totalTools += toolNames.length;
        continue;
      }

      try {
        const { toolCount } = await this.connectServer(
          serverId,
          serverConfig,
          registry,
        );
        connected++;
        totalTools += toolCount;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[mcp] ${serverId}: failed to connect — ${msg}`);
        this.failedServers.set(serverId, { config: serverConfig, attempts: 1 });
      }
    }

    const total = serverIds.filter((id) => config[id].enabled !== false).length;
    const parts = [`${connected}/${total - lazyCount} servers`];
    if (lazyCount > 0) parts.push(`${lazyCount} lazy`);
    parts.push(`${totalTools} tools registered`);
    console.log(`[mcp] ${parts.join(", ")}`);

    // Alert on startup degradation
    if (this.failedServers.size > 0) {
      const failed = Array.from(this.failedServers.keys()).join(", ");
      this.alert(
        `[mcp] ⚠️ DEGRADED: ${this.failedServers.size} MCP server(s) failed to connect (${failed}). Auto-reconnect started.`,
      );
    }

    // Start reconnection loop if any servers failed
    this.startReconnectLoop();
  }

  /** Connect a single MCP server and register its tools. */
  private async connectServer(
    serverId: string,
    config: McpServerConfig,
    registry: ToolRegistry,
  ): Promise<{ toolCount: number }> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: config.env
        ? ({ ...process.env, ...config.env } as Record<string, string>)
        : undefined,
    });

    const client = new Client({
      name: `mc-${serverId}`,
      version: "1.0.0",
    });

    // Connect with timeout
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(new Error(`Connection timeout (${CONNECT_TIMEOUT_MS}ms)`)),
          CONNECT_TIMEOUT_MS,
        ),
      ),
    ]);

    // Discover tools
    const { tools } = await client.listTools();
    const toolNames: string[] = [];

    // Create callFn bound to this client
    const callFn = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<McpCallResult> => {
      const result = await client.callTool({ name, arguments: args });
      return result as McpCallResult;
    };

    // Register each tool in the global registry
    for (const mcpTool of tools) {
      const tool = createMcpTool(
        serverId,
        {
          name: mcpTool.name,
          description: mcpTool.description,
          inputSchema: mcpTool.inputSchema as Record<string, unknown>,
        },
        callFn,
      );
      registry.register(tool);
      toolNames.push(tool.name);
    }

    this.servers.set(serverId, { client, transport, toolNames });
    console.log(
      `[mcp] ${serverId}: connected, ${tools.length} tools (${toolNames.join(", ")})`,
    );

    return { toolCount: tools.length };
  }

  /**
   * Register proxy tools for a lazy server without spawning its process.
   * The actual connection happens on first tool invocation.
   */
  private registerLazyServer(
    serverId: string,
    config: McpServerConfig,
    registry: ToolRegistry,
  ): string[] {
    const toolDefs = config.tools ?? [];
    const toolNames: string[] = [];

    for (const toolDef of toolDefs) {
      const namespacedName = `${serverId}${MCP_NAMESPACE_SEP}${toolDef.name}`;
      // Tag proxy tools so we can detect self-referencing after activation
      const proxyMarker = Symbol("lazy-proxy");
      const tool: Tool = {
        name: namespacedName,
        definition: {
          type: "function",
          function: {
            name: namespacedName,
            description: toolDef.description,
            parameters: toolDef.inputSchema ?? {
              type: "object",
              properties: {},
            },
          },
        },
        execute: async (args: Record<string, unknown>): Promise<string> => {
          if (this.isShutdown) {
            return JSON.stringify({
              error: `MCP server ${serverId} is shut down`,
            });
          }
          // Connect the server on first call
          await this.activateLazyServer(serverId);
          const realTool = registry.get(namespacedName);
          // Guard against infinite recursion: if the tool is still a proxy, fail
          if (
            !realTool ||
            (realTool as unknown as Record<symbol, boolean>)[proxyMarker]
          ) {
            return JSON.stringify({
              error: `Tool ${namespacedName} not available after lazy activation (server may expose different tool names)`,
            });
          }
          return realTool.execute(args);
        },
      };
      // Attach the proxy marker
      (tool as unknown as Record<symbol, boolean>)[proxyMarker] = true;
      registry.register(tool);
      toolNames.push(namespacedName);
    }

    this.lazyServers.set(serverId, { config, toolNames });
    console.log(
      `[mcp] ${serverId}: lazy-registered ${toolDefs.length} tools (will connect on first use)`,
    );
    return toolNames;
  }

  /**
   * Activate a lazy server: connect and replace proxy tools with real ones.
   * Safe for concurrent calls — only connects once.
   */
  private async activateLazyServer(serverId: string): Promise<void> {
    const lazy = this.lazyServers.get(serverId);
    if (!lazy) return; // already activated or not lazy

    // Deduplicate concurrent activations
    if (lazy.connecting) {
      await lazy.connecting;
      return;
    }

    const doConnect = async () => {
      console.log(`[mcp] ${serverId}: lazy activation — connecting...`);
      try {
        await this.connectServer(serverId, lazy.config, this.registry!);
        this.lazyServers.delete(serverId);
        console.log(`[mcp] ${serverId}: lazy activation complete`);
      } catch (err) {
        // Reset so next call retries instead of replaying cached rejection
        lazy.connecting = undefined;
        const msg = err instanceof Error ? err.message : String(err);
        this.alert(`[mcp] ⚠️ ${serverId}: lazy activation failed — ${msg}`);
        throw err;
      }
    };

    lazy.connecting = doConnect();
    await lazy.connecting;
  }

  /**
   * Periodically retry failed MCP server connections.
   * Stops when all servers are connected or max attempts exhausted.
   */
  private startReconnectLoop(): void {
    if (this.reconnectTimer) return; // already running
    if (this.failedServers.size === 0) return; // nothing to retry

    this.reconnectTimer = setInterval(async () => {
      if (this.failedServers.size === 0 || !this.registry) {
        this.stopReconnectLoop();
        return;
      }

      for (const [serverId, state] of this.failedServers) {
        if (state.attempts >= MAX_RECONNECT_ATTEMPTS) {
          this.alert(
            `[mcp] ❌ ${serverId}: giving up after ${state.attempts} reconnect attempts. Manual restart required.`,
          );
          this.failedServers.delete(serverId);
          continue;
        }

        try {
          const { toolCount } = await this.connectServer(
            serverId,
            state.config,
            this.registry,
          );
          this.failedServers.delete(serverId);
          this.alert(
            `[mcp] ✅ ${serverId}: reconnected (${toolCount} tools recovered, attempt ${state.attempts + 1})`,
          );
        } catch {
          state.attempts++;
          console.warn(
            `[mcp] ${serverId}: reconnect attempt ${state.attempts}/${MAX_RECONNECT_ATTEMPTS} failed`,
          );
        }
      }

      if (this.failedServers.size === 0) {
        this.stopReconnectLoop();
      }
    }, RECONNECT_INTERVAL_MS);
  }

  private stopReconnectLoop(): void {
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** Disconnect all MCP servers gracefully. */
  async shutdown(): Promise<void> {
    this.isShutdown = true;
    this.stopReconnectLoop();
    for (const [serverId, entry] of this.servers) {
      try {
        await entry.client.close();
      } catch (err) {
        console.warn(
          `[mcp] ${serverId}: close failed — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.servers.clear();
    this.lazyServers.clear();
    this.failedServers.clear();
    console.log("[mcp] All servers disconnected");
  }

  /** Get connected server IDs (includes lazy-registered). */
  getServerIds(): string[] {
    return [
      ...Array.from(this.servers.keys()),
      ...Array.from(this.lazyServers.keys()),
    ];
  }

  /** Get failed server IDs (pending reconnection). */
  getFailedServerIds(): string[] {
    return Array.from(this.failedServers.keys());
  }

  /** Get total number of MCP tools registered (connected + lazy). */
  getToolCount(): number {
    let count = 0;
    for (const entry of this.servers.values()) {
      count += entry.toolNames.length;
    }
    for (const entry of this.lazyServers.values()) {
      count += entry.toolNames.length;
    }
    return count;
  }
}
