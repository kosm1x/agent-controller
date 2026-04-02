/**
 * MCP manager tests — mock SDK to test server lifecycle and tool registration.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolRegistry } from "../tools/registry.js";

// Mock the MCP SDK
const mockConnect = vi.fn();
const mockClose = vi.fn();
const mockListTools = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    close: mockClose,
    listTools: mockListTools,
  })),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({})),
}));

import { McpManager } from "./manager.js";

beforeEach(() => {
  vi.clearAllMocks();
});

function makeMcpTools(
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>,
) {
  return { tools };
}

describe("McpManager", () => {
  it("should connect to a server and register its tools", async () => {
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue(
      makeMcpTools([
        {
          name: "read_file",
          description: "Read a file",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
        {
          name: "write_file",
          description: "Write a file",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
            },
          },
        },
      ]),
    );

    const registry = new ToolRegistry();
    const manager = new McpManager();

    await manager.init(
      {
        filesystem: { command: "node", args: ["server.js"] },
      },
      registry,
    );

    expect(registry.list()).toContain("filesystem__read_file");
    expect(registry.list()).toContain("filesystem__write_file");
    expect(manager.getServerIds()).toEqual(["filesystem"]);
    expect(manager.getToolCount()).toBe(2);
  });

  it("should skip disabled servers", async () => {
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue(makeMcpTools([{ name: "tool1" }]));

    const registry = new ToolRegistry();
    const manager = new McpManager();

    await manager.init(
      {
        enabled_server: { command: "node", args: ["a.js"] },
        disabled_server: {
          command: "node",
          args: ["b.js"],
          enabled: false,
        },
      },
      registry,
    );

    expect(manager.getServerIds()).toEqual(["enabled_server"]);
    expect(registry.has("disabled_server__tool1")).toBe(false);
    expect(registry.has("enabled_server__tool1")).toBe(true);
  });

  it("should continue when one server fails to connect", async () => {
    let callCount = 0;
    mockConnect.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error("Connection refused"));
      }
      return Promise.resolve(undefined);
    });
    mockListTools.mockResolvedValue(makeMcpTools([{ name: "tool_a" }]));

    const registry = new ToolRegistry();
    const manager = new McpManager();

    await manager.init(
      {
        failing: { command: "bad-cmd" },
        working: { command: "node", args: ["good.js"] },
      },
      registry,
    );

    // Only the working server's tool should be registered
    expect(registry.has("failing__tool_a")).toBe(false);
    expect(registry.has("working__tool_a")).toBe(true);
    expect(manager.getServerIds()).toEqual(["working"]);
  });

  it("should handle empty config", async () => {
    const registry = new ToolRegistry();
    const manager = new McpManager();

    await manager.init({}, registry);

    expect(manager.getServerIds()).toEqual([]);
    expect(manager.getToolCount()).toBe(0);
  });

  it("should handle server with no tools", async () => {
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue(makeMcpTools([]));

    const registry = new ToolRegistry();
    const manager = new McpManager();

    await manager.init(
      { empty_server: { command: "node", args: ["empty.js"] } },
      registry,
    );

    expect(manager.getServerIds()).toEqual(["empty_server"]);
    expect(manager.getToolCount()).toBe(0);
  });

  it("should call close on all servers during shutdown", async () => {
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue(makeMcpTools([{ name: "t" }]));
    mockClose.mockResolvedValue(undefined);

    const registry = new ToolRegistry();
    const manager = new McpManager();

    await manager.init(
      {
        server1: { command: "node", args: ["a.js"] },
        server2: { command: "node", args: ["b.js"] },
      },
      registry,
    );

    await manager.shutdown();

    expect(mockClose).toHaveBeenCalledTimes(2);
    expect(manager.getServerIds()).toEqual([]);
  });

  it("should handle close errors during shutdown", async () => {
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue(makeMcpTools([{ name: "t" }]));
    mockClose.mockRejectedValue(new Error("Already closed"));

    const registry = new ToolRegistry();
    const manager = new McpManager();

    await manager.init(
      { server1: { command: "node", args: ["a.js"] } },
      registry,
    );

    // Should not throw
    await expect(manager.shutdown()).resolves.toBeUndefined();
  });

  it("should track failed servers for reconnection", async () => {
    mockConnect.mockRejectedValue(new Error("Connection refused"));

    const registry = new ToolRegistry();
    const manager = new McpManager();

    await manager.init({ failing: { command: "bad-cmd" } }, registry);

    expect(manager.getServerIds()).toEqual([]);
    expect(manager.getFailedServerIds()).toEqual(["failing"]);
  });

  it("should call alertFn on startup degradation", async () => {
    mockConnect.mockRejectedValue(new Error("Timeout"));
    const alertSpy = vi.fn();

    const registry = new ToolRegistry();
    const manager = new McpManager();
    manager.setAlertFn(alertSpy);

    await manager.init({ commit: { command: "bad" } }, registry);

    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy.mock.calls[0][0]).toContain("DEGRADED");
    expect(alertSpy.mock.calls[0][0]).toContain("commit");
  });

  it("should clear failed servers and timer on shutdown", async () => {
    mockConnect.mockRejectedValue(new Error("Timeout"));

    const registry = new ToolRegistry();
    const manager = new McpManager();

    await manager.init({ failing: { command: "bad" } }, registry);

    expect(manager.getFailedServerIds()).toEqual(["failing"]);

    await manager.shutdown();

    expect(manager.getFailedServerIds()).toEqual([]);
  });

  it("should register tools with correct definitions", async () => {
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue(
      makeMcpTools([
        {
          name: "search",
          description: "Search docs",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      ]),
    );

    const registry = new ToolRegistry();
    const manager = new McpManager();

    await manager.init(
      { docs: { command: "node", args: ["docs.js"] } },
      registry,
    );

    const defs = registry.getDefinitions(["docs__search"]);
    expect(defs).toHaveLength(1);
    expect(defs[0].function.name).toBe("docs__search");
    expect(defs[0].function.description).toBe("Search docs");
    expect(defs[0].function.parameters).toEqual({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    });
  });
});
