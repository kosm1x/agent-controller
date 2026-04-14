/**
 * MCP bridge tests — schema conversion, namespacing, execute routing.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createMcpTool,
  extractText,
  type McpCallFn,
  type McpContentItem,
} from "./bridge.js";

describe("extractText", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("should join text content items", () => {
    const content: McpContentItem[] = [
      { type: "text", text: "Hello" },
      { type: "text", text: "World" },
    ];
    expect(extractText(content)).toBe("Hello\nWorld");
  });

  it("should skip non-text content", () => {
    const content: McpContentItem[] = [
      { type: "image", data: "base64..." },
      { type: "text", text: "Only text" },
    ];
    expect(extractText(content)).toBe("Only text");
  });

  it("should return fallback when no text content", () => {
    const content: McpContentItem[] = [{ type: "image", data: "base64..." }];
    expect(extractText(content)).toBe("[No text content returned]");
  });

  it("should return fallback for empty content", () => {
    expect(extractText([])).toBe("[No text content returned]");
  });
});

describe("createMcpTool", () => {
  const mockCallFn: McpCallFn = vi.fn();

  it("should namespace tool name with double underscore", () => {
    const tool = createMcpTool(
      "weather",
      { name: "get_forecast", description: "Get weather" },
      mockCallFn,
    );
    expect(tool.name).toBe("weather__get_forecast");
  });

  it("should convert inputSchema to OpenAI ToolDefinition", () => {
    const tool = createMcpTool(
      "fs",
      {
        name: "read_file",
        description: "Read a file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      mockCallFn,
    );

    expect(tool.definition).toEqual({
      type: "function",
      function: {
        name: "fs__read_file",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    });
  });

  it("should default missing description to empty string", () => {
    const tool = createMcpTool("s", { name: "t" }, mockCallFn);
    expect(tool.definition.function.description).toBe("");
  });

  it("should default missing inputSchema to empty object", () => {
    const tool = createMcpTool("s", { name: "t" }, mockCallFn);
    expect(tool.definition.function.parameters).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("should extract text on successful execute", async () => {
    const callFn: McpCallFn = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: '{"temp": 72}' }],
      isError: false,
    });
    const tool = createMcpTool("w", { name: "t" }, callFn);

    const result = await tool.execute({ city: "NYC" });
    expect(result).toBe('{"temp": 72}');
    expect(callFn).toHaveBeenCalledWith("t", { city: "NYC" });
  });

  it("should wrap isError result in error JSON", async () => {
    const callFn: McpCallFn = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "Server not found" }],
      isError: true,
    });
    const tool = createMcpTool("w", { name: "t" }, callFn);

    const result = await tool.execute({});
    expect(JSON.parse(result)).toEqual({ error: "Server not found" });
  });

  it("should catch thrown errors from callFn", async () => {
    const callFn: McpCallFn = vi
      .fn()
      .mockRejectedValue(new Error("Connection lost"));
    const tool = createMcpTool("w", { name: "t" }, callFn);

    const result = await tool.execute({});
    expect(JSON.parse(result)).toEqual({ error: "Connection lost" });
  });

  it("should handle non-Error thrown values", async () => {
    const callFn: McpCallFn = vi.fn().mockRejectedValue("unknown failure");
    const tool = createMcpTool("w", { name: "t" }, callFn);

    const result = await tool.execute({});
    expect(JSON.parse(result)).toEqual({ error: "unknown failure" });
  });

  // -------------------------------------------------------------------------
  // v7.6.1 — SSRF defense at MCP bridge boundary
  // -------------------------------------------------------------------------

  describe("SSRF pre-flight validation", () => {
    it("blocks file:// in url arg before calling upstream", async () => {
      const callFn: McpCallFn = vi.fn();
      const tool = createMcpTool(
        "playwright",
        { name: "browser_navigate" },
        callFn,
      );

      const result = await tool.execute({ url: "file:///etc/passwd" });
      expect(JSON.parse(result).error).toMatch(/Blocked outbound URL/);
      expect(JSON.parse(result).error).toMatch(/Blocked scheme/);
      expect(callFn).not.toHaveBeenCalled();
    });

    it("blocks http://localhost in url arg", async () => {
      const callFn: McpCallFn = vi.fn();
      const tool = createMcpTool("browser", { name: "goto" }, callFn);

      const result = await tool.execute({
        url: "http://localhost:3000/api/datasources",
      });
      expect(JSON.parse(result).error).toMatch(/Blocked host: localhost/);
      expect(callFn).not.toHaveBeenCalled();
    });

    it("blocks 169.254.169.254 cloud metadata endpoint", async () => {
      const callFn: McpCallFn = vi.fn();
      const tool = createMcpTool(
        "playwright",
        { name: "browser_navigate" },
        callFn,
      );

      const result = await tool.execute({
        url: "http://169.254.169.254/latest/meta-data/iam/security-credentials",
      });
      expect(JSON.parse(result).error).toMatch(/Blocked/);
      expect(callFn).not.toHaveBeenCalled();
    });

    it("blocks RFC1918 private IPs (192.168.x)", async () => {
      const callFn: McpCallFn = vi.fn();
      const tool = createMcpTool(
        "playwright",
        { name: "browser_navigate" },
        callFn,
      );

      const result = await tool.execute({ url: "http://192.168.1.1/" });
      expect(JSON.parse(result).error).toMatch(/Blocked private/);
      expect(callFn).not.toHaveBeenCalled();
    });

    it("allows public https URL through to upstream", async () => {
      const callFn: McpCallFn = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
      });
      const tool = createMcpTool(
        "playwright",
        { name: "browser_navigate" },
        callFn,
      );

      const result = await tool.execute({ url: "https://example.com/page" });
      expect(result).toBe("ok");
      expect(callFn).toHaveBeenCalledWith("browser_navigate", {
        url: "https://example.com/page",
      });
    });

    it("passes through non-URL-bearing args untouched", async () => {
      const callFn: McpCallFn = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "clicked" }],
      });
      const tool = createMcpTool(
        "playwright",
        { name: "browser_click" },
        callFn,
      );

      // `selector` is not a URL-convention key, so no validation runs.
      const result = await tool.execute({ selector: "button.submit" });
      expect(result).toBe("clicked");
      expect(callFn).toHaveBeenCalled();
    });

    it("does not false-positive on non-URL strings under url-named keys", async () => {
      const callFn: McpCallFn = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "done" }],
      });
      const tool = createMcpTool("search", { name: "query" }, callFn);

      // A search query that lives under `url` but has no scheme —
      // must be passed through, not blocked.
      const result = await tool.execute({ url: "my search query" });
      expect(result).toBe("done");
      expect(callFn).toHaveBeenCalled();
    });

    // v7.6.2 W5: audit log contract — future Pillar 6 validation item
    // will scan journalctl for these `[mcp] blocked URL-bearing arg`
    // lines to count attempted SSRF. The contract MUST be tested so a
    // future refactor doesn't silently drop the log.
    it("emits a [mcp] blocked audit warn on rejection", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const callFn: McpCallFn = vi.fn();
      const tool = createMcpTool(
        "playwright",
        { name: "browser_navigate" },
        callFn,
      );

      await tool.execute({ url: "http://127.0.0.1:9090/metrics" });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          /\[mcp\] blocked URL-bearing arg on playwright__browser_navigate: url: Blocked/,
        ),
      );
      warnSpy.mockRestore();
    });

    // v7.6.2 W5: no audit warn on the happy path.
    it("does NOT emit audit warn when the URL is safe", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const callFn: McpCallFn = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
      });
      const tool = createMcpTool(
        "playwright",
        { name: "browser_navigate" },
        callFn,
      );

      await tool.execute({ url: "https://example.com" });

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    // v7.6.2 W6: args shape resilience — undefined/null/empty.
    it("handles undefined args without throwing", async () => {
      const callFn: McpCallFn = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
      });
      const tool = createMcpTool("browser", { name: "close" }, callFn);

      // TypeScript says Record<string, unknown> but runtime can't enforce.
      // A tool with no args (like browser_close) might receive {} or
      // nothing at all from the upstream caller.
      const result = await tool.execute(
        undefined as unknown as Record<string, unknown>,
      );
      expect(result).toBe("ok");
      expect(callFn).toHaveBeenCalled();
    });

    it("handles null args without throwing", async () => {
      const callFn: McpCallFn = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
      });
      const tool = createMcpTool("browser", { name: "close" }, callFn);

      const result = await tool.execute(
        null as unknown as Record<string, unknown>,
      );
      expect(result).toBe("ok");
      expect(callFn).toHaveBeenCalled();
    });

    // v7.6.3 W6-followup (re-audit): primitive args (number/string) at
    // the runtime call site. TypeScript signature says
    // Record<string, unknown> but a misbehaving caller could pass
    // anything. validateArgsUrls returns null on non-objects, so the
    // upstream call proceeds with the raw value.
    it("handles primitive args (number) without throwing", async () => {
      const callFn: McpCallFn = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
      });
      const tool = createMcpTool("test", { name: "echo" }, callFn);

      const result = await tool.execute(
        42 as unknown as Record<string, unknown>,
      );
      expect(result).toBe("ok");
      expect(callFn).toHaveBeenCalled();
    });

    // v7.6.3 C1.5 (re-audit): MULTIPLE trailing dots also blocked.
    // The v7.6.2 fix used /\.$/ which only stripped one dot.
    it("blocks http://localhost../ (multi trailing dot) at bridge", async () => {
      const callFn: McpCallFn = vi.fn();
      const tool = createMcpTool(
        "playwright",
        { name: "browser_navigate" },
        callFn,
      );

      const result = await tool.execute({ url: "http://localhost../secret" });
      expect(JSON.parse(result).error).toMatch(/Blocked host: localhost/);
      expect(callFn).not.toHaveBeenCalled();
    });

    // v7.6.3 M3 (re-audit): plural URL keys (added to whitelist).
    it("blocks URL array under expanded plural key 'urls'", async () => {
      const callFn: McpCallFn = vi.fn();
      const tool = createMcpTool("scrape", { name: "batch_fetch" }, callFn);

      const result = await tool.execute({
        urls: ["https://ok.com", "http://localhost:9090/metrics"],
      });
      expect(JSON.parse(result).error).toMatch(/urls\[1\]:/);
      expect(JSON.parse(result).error).toMatch(/Blocked/);
      expect(callFn).not.toHaveBeenCalled();
    });

    // v7.6.2 C1 integration: trailing-dot bypass also blocked at bridge.
    it("blocks http://localhost./ (trailing dot FQDN) at bridge", async () => {
      const callFn: McpCallFn = vi.fn();
      const tool = createMcpTool(
        "playwright",
        { name: "browser_navigate" },
        callFn,
      );

      const result = await tool.execute({ url: "http://localhost./secret" });
      expect(JSON.parse(result).error).toMatch(/Blocked host: localhost/);
      expect(callFn).not.toHaveBeenCalled();
    });

    // v7.6.2 C2 integration: IPv6 [::] also blocked at bridge.
    it("blocks http://[::]/ (IPv6 unspecified) at bridge", async () => {
      const callFn: McpCallFn = vi.fn();
      const tool = createMcpTool(
        "playwright",
        { name: "browser_navigate" },
        callFn,
      );

      const result = await tool.execute({ url: "http://[::]/" });
      expect(JSON.parse(result).error).toMatch(/Blocked/);
      expect(callFn).not.toHaveBeenCalled();
    });

    // v7.6.2 R4 integration: javascript: URI blocked at bridge.
    it("blocks javascript: URI at bridge", async () => {
      const callFn: McpCallFn = vi.fn();
      const tool = createMcpTool(
        "playwright",
        { name: "browser_navigate" },
        callFn,
      );

      const result = await tool.execute({
        url: 'javascript:fetch("http://169.254.169.254")',
      });
      expect(JSON.parse(result).error).toMatch(/Blocked scheme: javascript:/);
      expect(callFn).not.toHaveBeenCalled();
    });

    // v7.6.2 W1 integration: expanded whitelist catches new key names.
    it("blocks URL under expanded whitelist key 'webhook_url'", async () => {
      const callFn: McpCallFn = vi.fn();
      const tool = createMcpTool("hooks", { name: "send" }, callFn);

      const result = await tool.execute({
        webhook_url: "http://10.0.0.5/hook",
      });
      expect(JSON.parse(result).error).toMatch(/webhook_url:/);
      expect(callFn).not.toHaveBeenCalled();
    });
  });
});
