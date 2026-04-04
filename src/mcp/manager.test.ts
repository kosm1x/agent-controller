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

    await manager.init({ weather: { command: "bad" } }, registry);

    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy.mock.calls[0][0]).toContain("DEGRADED");
    expect(alertSpy.mock.calls[0][0]).toContain("weather");
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

describe("McpManager lazy-load", () => {
  it("should register lazy tools without spawning a process", async () => {
    const registry = new ToolRegistry();
    const manager = new McpManager();

    await manager.init(
      {
        playwright: {
          command: "npx",
          args: ["@playwright/mcp"],
          lazy: true,
          tools: [
            { name: "browser_click", description: "Click an element" },
            { name: "browser_navigate", description: "Navigate to URL" },
          ],
        },
      },
      registry,
    );

    // Tools are registered in the registry
    expect(registry.has("playwright__browser_click")).toBe(true);
    expect(registry.has("playwright__browser_navigate")).toBe(true);

    // Server is listed as active (lazy counts)
    expect(manager.getServerIds()).toContain("playwright");
    expect(manager.getToolCount()).toBe(2);

    // No connection was attempted (mockConnect never called)
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockListTools).not.toHaveBeenCalled();
  });

  it("should activate lazy server on first tool call", async () => {
    // After activation, connectServer will discover real tools
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue(
      makeMcpTools([
        {
          name: "browser_click",
          description: "Click an element (real)",
          inputSchema: {
            type: "object",
            properties: { selector: { type: "string" } },
          },
        },
        {
          name: "browser_navigate",
          description: "Navigate to URL (real)",
          inputSchema: {
            type: "object",
            properties: { url: { type: "string" } },
          },
        },
      ]),
    );

    const registry = new ToolRegistry();
    const manager = new McpManager();

    await manager.init(
      {
        playwright: {
          command: "npx",
          args: ["@playwright/mcp"],
          lazy: true,
          tools: [
            { name: "browser_click", description: "Click an element" },
            { name: "browser_navigate", description: "Navigate to URL" },
          ],
        },
      },
      registry,
    );

    expect(mockConnect).not.toHaveBeenCalled();

    // Execute the lazy proxy tool — triggers activation
    const tool = registry.get("playwright__browser_click");
    expect(tool).toBeDefined();
    await tool!.execute({ selector: "#btn" });

    // Server was connected
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockListTools).toHaveBeenCalledTimes(1);

    // Lazy server removed from tracking
    expect(manager.getServerIds()).toContain("playwright");
    // Server is now in connected (not lazy) state
    expect(manager.getToolCount()).toBe(2);
  });

  it("should deduplicate concurrent activation calls", async () => {
    let resolveConnect: (() => void) | null = null;
    mockConnect.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveConnect = resolve;
        }),
    );
    mockListTools.mockResolvedValue(
      makeMcpTools([{ name: "tool_a", description: "Tool A" }]),
    );

    const registry = new ToolRegistry();
    const manager = new McpManager();

    await manager.init(
      {
        slow: {
          command: "node",
          args: ["slow.js"],
          lazy: true,
          tools: [{ name: "tool_a", description: "Tool A" }],
        },
      },
      registry,
    );

    // Fire two concurrent calls to the same lazy tool
    const call1 = registry.get("slow__tool_a")!.execute({});
    const call2 = registry.get("slow__tool_a")!.execute({});

    // Resolve the pending connection
    expect(resolveConnect).not.toBeNull();
    resolveConnect!();

    await Promise.all([call1, call2]);

    // connectServer (and thus mockConnect) should only be called once
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it("should handle lazy activation failure gracefully", async () => {
    mockConnect.mockRejectedValue(new Error("Playwright not installed"));

    const registry = new ToolRegistry();
    const manager = new McpManager();
    const alertSpy = vi.fn();
    manager.setAlertFn(alertSpy);

    await manager.init(
      {
        playwright: {
          command: "npx",
          args: ["@playwright/mcp"],
          lazy: true,
          tools: [{ name: "browser_click", description: "Click" }],
        },
      },
      registry,
    );

    const tool = registry.get("playwright__browser_click")!;

    // The proxy execute should throw (activation failed)
    await expect(tool.execute({})).rejects.toThrow("Playwright not installed");

    // Alert was fired
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy.mock.calls[0][0]).toContain("lazy activation failed");
  });

  it("should treat lazy:true with empty tools array as a normal server", async () => {
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue(
      makeMcpTools([{ name: "discovered_tool", description: "Found" }]),
    );

    const registry = new ToolRegistry();
    const manager = new McpManager();

    await manager.init(
      {
        server: {
          command: "node",
          args: ["s.js"],
          lazy: true,
          tools: [], // empty tools array -> length is 0 -> falsy
        },
      },
      registry,
    );

    // Falls through to normal connectServer path
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(registry.has("server__discovered_tool")).toBe(true);
  });

  it("should treat lazy:true without tools field as a normal server", async () => {
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue(
      makeMcpTools([{ name: "discovered_tool", description: "Found" }]),
    );

    const registry = new ToolRegistry();
    const manager = new McpManager();

    await manager.init(
      {
        server: {
          command: "node",
          args: ["s.js"],
          lazy: true,
          // no tools field at all
        },
      },
      registry,
    );

    // Falls through to normal connectServer path
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(registry.has("server__discovered_tool")).toBe(true);
  });

  it("should skip lazy server when enabled:false even if lazy:true", async () => {
    const registry = new ToolRegistry();
    const manager = new McpManager();

    await manager.init(
      {
        disabled_lazy: {
          command: "node",
          args: ["s.js"],
          lazy: true,
          enabled: false,
          tools: [{ name: "tool1", description: "T1" }],
        },
      },
      registry,
    );

    expect(mockConnect).not.toHaveBeenCalled();
    expect(registry.has("disabled_lazy__tool1")).toBe(false);
    expect(manager.getServerIds()).toEqual([]);
  });

  it("should leave stale proxy when tool names mismatch (documents known bug)", async () => {
    // BUG: If lazy config lists "browser_click" but server reports "click",
    // the proxy tool "pw__browser_click" is never overwritten by connectServer
    // (which registers "pw__click" instead). After activation, calling the
    // proxy re-fetches itself from the registry and recurses infinitely.
    // This test verifies the structural precondition without triggering the
    // stack overflow — the proxy remains in the registry pointing to itself.
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue(
      makeMcpTools([{ name: "click", description: "Click (different name)" }]),
    );

    const registry = new ToolRegistry();
    const manager = new McpManager();

    await manager.init(
      {
        pw: {
          command: "npx",
          args: ["mcp"],
          lazy: true,
          tools: [{ name: "browser_click", description: "Click" }],
        },
      },
      registry,
    );

    // Manually trigger activation (without calling the proxy's execute)
    // Access activateLazyServer indirectly via the proxy's dependencies
    // We can simulate by connecting directly
    expect(registry.has("pw__browser_click")).toBe(true);

    // Force the connection by calling the internal method via the proxy setup
    // The lazy entry exists; after connection it gets deleted
    const lazyIds = manager.getServerIds();
    expect(lazyIds).toContain("pw");

    // After lazy activation would complete, the real tool is pw__click,
    // but pw__browser_click still has the original proxy.
    // With the proxy marker fix, calling the stale proxy returns an error
    // instead of infinite recursion.
    expect(registry.has("pw__click")).toBe(false); // not yet connected

    // Simulate: activate server (registers pw__click, not pw__browser_click)
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue(
      makeMcpTools([{ name: "click", description: "Click" }]),
    );

    // The proxy for pw__browser_click detects it's still a proxy after activation
    const tool = registry.get("pw__browser_click")!;
    const result = await tool.execute({});
    expect(JSON.parse(result).error).toMatch(
      /not available after lazy activation/,
    );
  });

  it("should return error from proxy after shutdown instead of recursing", async () => {
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue(
      makeMcpTools([{ name: "tool1", description: "T1" }]),
    );

    const registry = new ToolRegistry();
    const manager = new McpManager();

    await manager.init(
      {
        srv: {
          command: "node",
          args: ["s.js"],
          lazy: true,
          tools: [{ name: "tool1", description: "T1" }],
        },
      },
      registry,
    );

    expect(registry.has("srv__tool1")).toBe(true);
    await manager.shutdown();

    // Proxy still exists in registry but should error gracefully
    const tool = registry.get("srv__tool1")!;
    const result = await tool.execute({});
    const parsed = JSON.parse(result);
    expect(parsed.error).toMatch(/shut down/);
  });
});
