/**
 * MCP bridge tests — schema conversion, namespacing, execute routing.
 */

import { describe, it, expect, vi , afterEach } from "vitest";
import {
  createMcpTool,
  extractText,
  type McpCallFn,
  type McpContentItem,
} from "./bridge.js";

describe("extractText", () => {
  afterEach(() => { vi.restoreAllMocks(); });
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
});
