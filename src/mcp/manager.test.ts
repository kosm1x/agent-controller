/**
 * MCP manager tests — mock SDK to test server lifecycle and tool registration.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ToolRegistry } from "../tools/registry.js";

// Mock the MCP SDK
const mockConnect = vi.fn();
const mockClose = vi.fn();
const mockListTools = vi.fn();
const mockCallTool = vi.fn();

/** Every mock Client constructed, in order (to fire `onclose` / inspect calls). */
interface MockClient {
  connect: typeof mockConnect;
  close: typeof mockClose;
  listTools: typeof mockListTools;
  callTool: ReturnType<typeof vi.fn>;
  onclose?: () => void;
}
const { createdClients } = vi.hoisted(() => ({
  createdClients: [] as MockClient[],
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => {
    const c: MockClient = {
      connect: mockConnect,
      close: mockClose,
      listTools: mockListTools,
      callTool: vi.fn((...args: unknown[]) => mockCallTool(...args)),
    };
    createdClients.push(c);
    return c;
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({})),
}));

import { McpManager } from "./manager.js";

beforeEach(() => {
  vi.clearAllMocks();
  createdClients.length = 0;
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

  // v7.2 — graphify-code MCP server registration.
  // Audit W2 fix: guard against an upstream rename of any of the 7 tools
  // silently breaking the scope group wiring.
  it("registers graphify-code 7 tools with deferred flag", async () => {
    const GRAPHIFY_TOOLS = [
      "query_graph",
      "get_node",
      "get_neighbors",
      "get_community",
      "god_nodes",
      "graph_stats",
      "shortest_path",
    ];
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue(
      makeMcpTools(
        GRAPHIFY_TOOLS.map((name) => ({
          name,
          description: `${name} tool`,
          inputSchema: { type: "object", properties: {} },
        })),
      ),
    );

    const registry = new ToolRegistry();
    const manager = new McpManager();

    await manager.init(
      {
        "graphify-code": {
          command: "./venv/graphify/bin/python",
          args: [
            "-m",
            "graphify.serve",
            "./data/graphify/code/graphify-out/graph.json",
          ],
          deferredTools: GRAPHIFY_TOOLS,
        },
      },
      registry,
    );

    for (const name of GRAPHIFY_TOOLS) {
      const fullName = `graphify-code__${name}`;
      expect(registry.has(fullName), `${fullName} not registered`).toBe(true);
      expect(registry.get(fullName)?.deferred).toBe(true);
    }
    await manager.shutdown();
  });
});

describe("McpManager dead-server recovery", () => {
  const CONFIG = { browser: { command: "node", args: ["b.js"] } };

  beforeEach(() => {
    vi.useFakeTimers();
    mockConnect.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue(
      makeMcpTools([{ name: "goto" }, { name: "markdown" }]),
    );
    mockCallTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
  });

  afterEach(() => {
    const live = vi.getTimerCount();
    vi.useRealTimers(); // first, so a failed test cannot leak timers onward
    expect(live).toBe(0);
  });

  async function connected() {
    const registry = new ToolRegistry();
    const manager = new McpManager();
    const alertSpy = vi.fn();
    manager.setAlertFn(alertSpy);
    await manager.init(CONFIG, registry);
    expect(manager.getServerIds()).toEqual(["browser"]);
    expect(alertSpy).not.toHaveBeenCalled();
    return { registry, manager, alertSpy, client: createdClients[0] };
  }

  it("(a) close on a connected server → failed set, one alert, reconnect scheduled", async () => {
    const { manager, alertSpy, client } = await connected();
    expect(typeof client.onclose).toBe("function");
    expect(vi.getTimerCount()).toBe(0);

    client.onclose!();

    expect(manager.getFailedServerIds()).toEqual(["browser"]);
    expect(manager.getServerIds()).toEqual([]);
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy.mock.calls[0][0]).toContain("DEGRADED");
    expect(alertSpy.mock.calls[0][0]).toContain("browser");
    expect(vi.getTimerCount()).toBe(1); // reconnect interval armed

    await manager.shutdown();
  });

  it("tool call while the server is down fails fast naming the server", async () => {
    const { registry, manager, client } = await connected();
    client.onclose!();

    const out = JSON.parse(
      await registry.get("browser__markdown")!.execute({}),
    );
    expect(out.error).toMatch(/MCP server browser is down/);
    expect(out.error).toMatch(/auto-reconnect pending/);
    expect(client.callTool).not.toHaveBeenCalled();

    await manager.shutdown();
  });

  it("in-flight call rejected by the SDK on death is reported as server down", async () => {
    const { registry, manager, client } = await connected();
    client.callTool.mockImplementationOnce(async () => {
      client.onclose!(); // SDK fires onclose before rejecting pending calls
      throw new Error("MCP error -32000: Connection closed");
    });

    const out = JSON.parse(
      await registry.get("browser__markdown")!.execute({}),
    );
    expect(out.error).toMatch(/MCP server browser is down/);

    await manager.shutdown();
  });

  it("(b) close during shutdown → no alert, no reconnect, no timers", async () => {
    const { manager, alertSpy, client } = await connected();
    // The real SDK fires onclose from inside client.close() (child exits).
    mockClose.mockImplementation(async () => client.onclose?.());

    await manager.shutdown();
    client.onclose!(); // a late close event after shutdown, too

    expect(alertSpy).not.toHaveBeenCalled();
    expect(manager.getFailedServerIds()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it("(c) reconnect success → tools registered once, bound to the new client, server leaves failed set", async () => {
    const { registry, manager, alertSpy, client } = await connected();
    const registerSpy = vi.spyOn(registry, "register");
    const before = registry.list().length;

    client.onclose!();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(manager.getFailedServerIds()).toEqual([]);
    expect(manager.getServerIds()).toEqual(["browser"]);
    expect(manager.getToolCount()).toBe(2);
    expect(registry.list().length).toBe(before);
    expect(registerSpy).toHaveBeenCalledTimes(2); // one per tool
    expect(alertSpy).toHaveBeenCalledTimes(2);
    expect(alertSpy.mock.calls[1][0]).toContain("reconnected");
    expect(vi.getTimerCount()).toBe(0); // loop stopped

    // The registered tool now calls through the NEW client, not the dead one.
    const fresh = createdClients[1];
    expect(fresh).toBeDefined();
    expect(await registry.get("browser__goto")!.execute({})).toBe("ok");
    expect(fresh.callTool).toHaveBeenCalledTimes(1);
    expect(client.callTool).not.toHaveBeenCalled();

    // The superseded client's late close is a no-op; the new one is armed.
    client.onclose!();
    expect(manager.getFailedServerIds()).toEqual([]);
    expect(typeof fresh.onclose).toBe("function");

    await manager.shutdown();
  });

  it("(d) two close events for the same death → one alert", async () => {
    const { manager, alertSpy, client } = await connected();

    client.onclose!();
    client.onclose!();

    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(manager.getFailedServerIds()).toEqual(["browser"]);
    expect(vi.getTimerCount()).toBe(1);

    await manager.shutdown();
  });

  it("dead server that never comes back hits the existing give-up cap", async () => {
    const { manager, alertSpy, client } = await connected();
    mockConnect.mockRejectedValue(new Error("spawn ENOENT"));

    client.onclose!();
    await vi.advanceTimersByTimeAsync(11 * 60_000);

    const msgs = alertSpy.mock.calls.map((c) => c[0] as string);
    expect(msgs.filter((m) => m.includes("DEGRADED"))).toHaveLength(1);
    expect(msgs.filter((m) => m.includes("giving up"))).toHaveLength(1);
    expect(manager.getFailedServerIds()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    await manager.shutdown();
  });

  it("(e) boot failure before setAlertFn → alert delivered once on setAlertFn", async () => {
    mockConnect.mockRejectedValue(new Error("Timeout"));
    const registry = new ToolRegistry();
    const manager = new McpManager();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await manager.init({ xpoz: { command: "bad" } }, registry);

    const alertSpy = vi.fn();
    manager.setAlertFn(alertSpy);
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy.mock.calls[0][0]).toContain("DEGRADED");
    expect(alertSpy.mock.calls[0][0]).toContain("xpoz");

    manager.setAlertFn(alertSpy); // re-wiring does not replay it
    expect(alertSpy).toHaveBeenCalledTimes(1);

    warn.mockRestore();
    await manager.shutdown();
  });

  it("boot failure that recovers before setAlertFn is not replayed", async () => {
    let n = 0;
    mockConnect.mockImplementation(() =>
      ++n === 1 ? Promise.reject(new Error("Timeout")) : Promise.resolve(),
    );
    const registry = new ToolRegistry();
    const manager = new McpManager();

    await manager.init({ xpoz: { command: "x" } }, registry);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager.getFailedServerIds()).toEqual([]);

    const alertSpy = vi.fn();
    manager.setAlertFn(alertSpy);
    expect(alertSpy).not.toHaveBeenCalled();

    await manager.shutdown();
  });

  it("flapping server converges on one give-up alert with a bounded alert count", async () => {
    const { manager, alertSpy } = await connected();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Dies right after every successful handshake.
    for (let i = 0; i < 30 && createdClients.at(-1)?.onclose; i++) {
      const live = createdClients.at(-1)!;
      if (!manager.getServerIds().includes("browser")) break;
      live.onclose!();
      await vi.advanceTimersByTimeAsync(60_000);
    }

    const msgs = alertSpy.mock.calls.map((c) => c[0] as string);
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toContain("DEGRADED");
    expect(msgs[1]).toContain("reconnected");
    expect(msgs[2]).toContain("giving up");
    expect(manager.getFailedServerIds()).toEqual([]);
    expect(manager.getServerIds()).toEqual([]);
    expect(mockConnect).toHaveBeenCalledTimes(11); // boot + 10 reconnects
    expect(vi.getTimerCount()).toBe(0);

    warn.mockRestore();
    await manager.shutdown();
  });

  it("server that always dies just past the stability window converges within the hourly bound", async () => {
    const { registry, manager, alertSpy } = await connected();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const at: Array<{ t: number; msg: string }> = [];
    alertSpy.mockImplementation((msg: string) =>
      at.push({ t: Date.now(), msg }),
    );

    // Up 5 min 01 s, then dies — every time.
    for (let i = 0; i < 40; i++) {
      if (!manager.getServerIds().includes("browser")) break;
      createdClients.at(-1)!.onclose!();
      await vi.advanceTimersByTimeAsync(60_000); // reconnect tick
      await vi.advanceTimersByTimeAsync(301_000); // stays up 5 min 01 s
    }

    const kinds = at.map(({ msg }) =>
      msg.includes("DEGRADED")
        ? "D"
        : msg.includes("reconnected")
          ? "R"
          : msg.includes("giving up")
            ? "G"
            : "?",
    );
    expect(kinds).toEqual(["D", "R", "D", "R", "G"]);
    // Net bound: ≤ 2 DEGRADED in any rolling hour, each followed by at most one
    // "reconnected", which can trail it by up to ~10 min (so a rolling hour can
    // hold 3 "reconnected" in general; this run emits only 2 in total).
    for (const { t } of at) {
      const hour = at.filter((a) => a.t >= t && a.t < t + 60 * 60_000);
      expect(
        hour.filter((a) => a.msg.includes("DEGRADED")).length,
      ).toBeLessThanOrEqual(2);
      expect(
        hour.filter((a) => a.msg.includes("reconnected")).length,
      ).toBeLessThanOrEqual(2);
    }
    expect(at[4].msg).toContain(
      "giving up after 10 reconnect attempts that failed or did not stay up. Manual restart required.",
    );
    expect(manager.getFailedServerIds()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    // Once abandoned, the proxy says so instead of "auto-reconnect pending".
    const out = JSON.parse(await registry.get("browser__goto")!.execute({}));
    expect(out.error).toBe(
      "MCP server browser is down (reconnect abandoned — restart required)",
    );

    warn.mockRestore();
    await manager.shutdown();
  });

  it("a boot failure counts as a death toward the hourly DEGRADED bound", async () => {
    mockConnect.mockRejectedValueOnce(new Error("Timeout"));
    const registry = new ToolRegistry();
    const manager = new McpManager();
    const at: Array<{ t: number; msg: string }> = [];
    manager.setAlertFn((msg: string) => at.push({ t: Date.now(), msg }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await manager.init(CONFIG, registry); // D@0
    await vi.advanceTimersByTimeAsync(60_000); // R@1

    // Then: up 6 min, dies, reconnects — repeated.
    for (let i = 0; i < 40; i++) {
      if (!manager.getServerIds().includes("browser")) break;
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      createdClients.at(-1)!.onclose!();
      await vi.advanceTimersByTimeAsync(60_000);
    }

    const kind = (m: string) =>
      m.includes("DEGRADED")
        ? "D"
        : m.includes("reconnected")
          ? "R"
          : m.includes("giving up")
            ? "G"
            : "?";
    expect(at.map((a) => kind(a.msg))).toEqual(["D", "R", "D", "R", "G"]);
    for (const { t } of at) {
      const hour = at.filter((a) => a.t >= t && a.t < t + 60 * 60_000);
      expect(
        hour.filter((a) => kind(a.msg) === "D").length,
      ).toBeLessThanOrEqual(2);
    }
    expect(vi.getTimerCount()).toBe(0);

    warn.mockRestore();
    await manager.shutdown();
  });

  it("a death exactly 60:00 after the first is still inside the window", async () => {
    const { manager, alertSpy } = await connected();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    createdClients[0].onclose!(); // death at 0
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    createdClients[1].onclose!(); // death at 30:00
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    createdClients[2].onclose!(); // death at 60:00 — 3rd in the closed hour

    const msgs = alertSpy.mock.calls.map((c) => c[0] as string);
    expect(msgs.filter((m) => m.includes("DEGRADED"))).toHaveLength(2);
    expect(manager.getFailedServerIds()).toEqual(["browser"]);

    warn.mockRestore();
    await manager.shutdown();
  });

  it("deaths outside the rolling hour do not count toward flapping", async () => {
    const { manager, alertSpy } = await connected();

    createdClients[0].onclose!(); // death 1 at t0
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    createdClients[1].onclose!(); // death 2 at t0+10 min (2nd in window)
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(79 * 60_000);
    createdClients[2].onclose!(); // death 3 at t0+90 min: window rolled over
    await vi.advanceTimersByTimeAsync(60_000);

    const msgs = alertSpy.mock.calls.map((c) => c[0] as string);
    expect(msgs).toHaveLength(6);
    expect(msgs[4]).toContain("DEGRADED");
    expect(msgs[5]).toContain("reconnected");
    expect(msgs[5]).toContain("attempt 1)");

    await manager.shutdown();
  });

  it("registration failure after connect closes the client and leaves no live server", async () => {
    const registry = new ToolRegistry();
    const realRegister = registry.register.bind(registry);
    let n = 0;
    vi.spyOn(registry, "register").mockImplementation((tool) => {
      if (++n === 2) throw new Error("schema boom");
      realRegister(tool);
    });
    const manager = new McpManager();

    await manager.init(CONFIG, registry);

    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(manager.getServerIds()).toEqual([]);
    expect(manager.getFailedServerIds()).toEqual(["browser"]);
    // ToolRegistry has no unregister: the one tool registered before the
    // throw stays, bound to the closed client, and fails fast.
    expect(registry.has("browser__markdown")).toBe(false);
    const out = JSON.parse(await registry.get("browser__goto")!.execute({}));
    expect(out.error).toBe(
      "MCP server browser is down (auto-reconnect pending)",
    );
    expect(createdClients[0].callTool).not.toHaveBeenCalled();

    await manager.shutdown();
  });

  it("server that stays up past the stability window gets a fresh counter on a later death", async () => {
    const { manager, alertSpy } = await connected();

    createdClients[0].onclose!();
    await vi.advanceTimersByTimeAsync(60_000); // reconnect, attempt 1
    await vi.advanceTimersByTimeAsync(6 * 60_000); // stays up past the window
    createdClients[1].onclose!();

    expect(manager.getFailedServerIds()).toEqual(["browser"]);
    await vi.advanceTimersByTimeAsync(60_000);

    const msgs = alertSpy.mock.calls.map((c) => c[0] as string);
    expect(msgs).toHaveLength(4);
    expect(msgs[2]).toContain("DEGRADED");
    expect(msgs[3]).toContain("reconnected");
    expect(msgs[3]).toContain("attempt 1)");

    await manager.shutdown();
  });

  it("connect timeout closes the spawned client", async () => {
    mockConnect.mockImplementation(() => new Promise(() => {}));
    const registry = new ToolRegistry();
    const manager = new McpManager();

    const booting = manager.init(CONFIG, registry);
    await vi.advanceTimersByTimeAsync(10_000);
    await booting;

    expect(manager.getFailedServerIds()).toEqual(["browser"]);
    expect(createdClients).toHaveLength(1);
    expect(mockClose).toHaveBeenCalledTimes(1);

    await manager.shutdown();
  });

  it("listTools failure closes the spawned client", async () => {
    mockListTools.mockRejectedValueOnce(new Error("boom"));
    const registry = new ToolRegistry();
    const manager = new McpManager();

    await manager.init(CONFIG, registry);

    expect(manager.getFailedServerIds()).toEqual(["browser"]);
    expect(mockClose).toHaveBeenCalledTimes(1);

    await manager.shutdown();
  });

  it("a reconnect tick still in flight is not re-entered by the next interval", async () => {
    mockConnect.mockRejectedValueOnce(new Error("Timeout"));
    const registry = new ToolRegistry();
    const manager = new McpManager();
    manager.setAlertFn(vi.fn());
    await manager.init(CONFIG, registry);

    let finishList: (v: unknown) => void = () => {};
    mockListTools.mockImplementationOnce(
      () => new Promise((r) => (finishList = r)),
    );
    await vi.advanceTimersByTimeAsync(60_000); // tick 1: hangs in listTools
    await vi.advanceTimersByTimeAsync(60_000); // tick 2 fires while tick 1 runs
    expect(mockConnect).toHaveBeenCalledTimes(2); // boot + tick 1 only

    finishList(makeMcpTools([{ name: "goto" }]));
    await vi.advanceTimersByTimeAsync(1);
    expect(manager.getServerIds()).toEqual(["browser"]);
    expect(createdClients).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);

    await manager.shutdown();
  });

  it("shutdown during an in-flight reconnect aborts quietly", async () => {
    mockConnect.mockRejectedValueOnce(new Error("Timeout"));
    const registry = new ToolRegistry();
    const manager = new McpManager();
    const alertSpy = vi.fn();
    manager.setAlertFn(alertSpy);
    await manager.init(CONFIG, registry);
    expect(alertSpy).toHaveBeenCalledTimes(1); // boot DEGRADED

    let finishConnect: () => void = () => {};
    mockConnect.mockImplementationOnce(
      () => new Promise<void>((r) => (finishConnect = r)),
    );
    await vi.advanceTimersByTimeAsync(60_000); // tick: awaiting connect
    mockClose.mockClear(); // drop the boot-failure client's close
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await manager.shutdown();
    finishConnect();
    await vi.advanceTimersByTimeAsync(1);

    expect(manager.getServerIds()).toEqual([]);
    expect(manager.getFailedServerIds()).toEqual([]);
    expect(createdClients[1].onclose).toBeUndefined();
    expect(mockClose).toHaveBeenCalledTimes(1); // the late client was closed
    expect(alertSpy).toHaveBeenCalledTimes(1); // no "reconnected"
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("reconnect attempt")),
    ).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    warn.mockRestore();
  });

  it("shutdown during an in-flight lazy activation aborts quietly", async () => {
    const registry = new ToolRegistry();
    const manager = new McpManager();
    const alertSpy = vi.fn();
    manager.setAlertFn(alertSpy);
    await manager.init(
      {
        playwright: {
          command: "npx",
          lazy: true,
          tools: [{ name: "goto", description: "Go" }],
        },
      },
      registry,
    );

    let finishConnect: () => void = () => {};
    mockConnect.mockImplementationOnce(
      () => new Promise<void>((r) => (finishConnect = r)),
    );
    const pending = registry.get("playwright__goto")!.execute({});
    await vi.advanceTimersByTimeAsync(1);

    await manager.shutdown();
    finishConnect();

    expect(JSON.parse(await pending).error).toMatch(/shut down/);
    expect(manager.getServerIds()).toEqual([]);
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(alertSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lazy proxies have no close hook until activated", async () => {
    const registry = new ToolRegistry();
    const manager = new McpManager();
    await manager.init(
      {
        playwright: {
          command: "npx",
          lazy: true,
          tools: [{ name: "browser_click", description: "Click" }],
        },
      },
      registry,
    );
    expect(createdClients).toHaveLength(0);
    expect(manager.getFailedServerIds()).toEqual([]);
    await manager.shutdown();
  });
});
