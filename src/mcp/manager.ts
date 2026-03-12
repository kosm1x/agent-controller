/**
 * MCP client manager — connects to MCP servers and registers their tools.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpConfig, McpServerConfig } from "./types.js";
import { createMcpTool } from "./bridge.js";
import type { McpCallResult } from "./bridge.js";
import type { ToolRegistry } from "../tools/registry.js";

/** Internal state for a connected MCP server. */
interface ServerEntry {
  client: Client;
  transport: StdioClientTransport;
  toolNames: string[];
}

const CONNECT_TIMEOUT_MS = 10_000;

export class McpManager {
  private servers = new Map<string, ServerEntry>();

  /**
   * Connect to all configured MCP servers and register their tools.
   * Each server is independent — one failure doesn't block others.
   */
  async init(config: McpConfig, registry: ToolRegistry): Promise<void> {
    const serverIds = Object.keys(config);
    let connected = 0;
    let totalTools = 0;

    for (const serverId of serverIds) {
      const serverConfig = config[serverId];
      if (serverConfig.enabled === false) {
        console.log(`[mcp] ${serverId}: skipped (disabled)`);
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
        console.warn(
          `[mcp] ${serverId}: failed to connect — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const total = serverIds.filter((id) => config[id].enabled !== false).length;
    console.log(
      `[mcp] Connected to ${connected}/${total} servers, ${totalTools} tools registered`,
    );
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

  /** Disconnect all MCP servers gracefully. */
  async shutdown(): Promise<void> {
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
    console.log("[mcp] All servers disconnected");
  }

  /** Get connected server IDs. */
  getServerIds(): string[] {
    return Array.from(this.servers.keys());
  }

  /** Get total number of MCP tools registered. */
  getToolCount(): number {
    let count = 0;
    for (const entry of this.servers.values()) {
      count += entry.toolNames.length;
    }
    return count;
  }
}
