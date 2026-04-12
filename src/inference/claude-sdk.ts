/**
 * Claude Agent SDK integration — uses Max Plan + Extra Usage billing.
 *
 * Wraps our toolRegistry as an in-process MCP server and routes inference
 * through the Agent SDK's query() function. Claude Code subprocess handles
 * auth automatically from ~/.claude/.credentials.json.
 *
 * Switchback: set INFERENCE_PRIMARY_PROVIDER=openai to revert to DashScope.
 */

import {
  tool as sdkTool,
  createSdkMcpServer,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  Options as SdkOptions,
  SDKResultSuccess,
  SDKResultError,
} from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodType } from "zod";
import { toolRegistry } from "../tools/registry.js";
import type { Tool } from "../tools/types.js";

// ---------------------------------------------------------------------------
// JSON Schema → Zod raw shape (for SDK tool() definitions)
// ---------------------------------------------------------------------------

function jsonPropToZod(prop: Record<string, unknown>): ZodType {
  const desc = String(prop.description ?? "");

  if (prop.enum && Array.isArray(prop.enum) && prop.enum.length > 0) {
    return z.enum(prop.enum as [string, ...string[]]).describe(desc);
  }

  switch (prop.type) {
    case "string":
      return z.string().describe(desc);
    case "number":
    case "integer":
      return z.number().describe(desc);
    case "boolean":
      return z.boolean().describe(desc);
    case "array":
      return z.array(z.unknown()).describe(desc);
    case "object":
      return z.record(z.string(), z.unknown()).describe(desc);
    default:
      return z.unknown();
  }
}

function jsonSchemaToZodShape(
  params: Record<string, unknown>,
): Record<string, ZodType> {
  const properties = params.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!properties) return {};

  const required = new Set((params.required as string[]) ?? []);
  const shape: Record<string, ZodType> = {};

  for (const [key, prop] of Object.entries(properties)) {
    const field = jsonPropToZod(prop);
    shape[key] = required.has(key) ? field : field.optional();
  }
  return shape;
}

// ---------------------------------------------------------------------------
// Tool wrapping: our Tool → SDK MCP tool
// ---------------------------------------------------------------------------

function wrapTool(t: Tool) {
  const params = t.definition.function.parameters as Record<string, unknown>;
  const shape = jsonSchemaToZodShape(params);

  return sdkTool(
    t.name,
    t.definition.function.description,
    shape,
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      try {
        const result = await toolRegistry.execute(
          t.name,
          args as Record<string, unknown>,
        );
        return { content: [{ type: "text", text: result }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}

// ---------------------------------------------------------------------------
// MCP server builder
// ---------------------------------------------------------------------------

export function buildMcpServer(toolNames: string[]) {
  const tools = toolNames
    .map((n) => toolRegistry.get(n))
    .filter((t): t is Tool => t !== undefined)
    .map(wrapTool);

  return createSdkMcpServer({
    name: "jarvis",
    version: "1.0.0",
    tools,
  });
}

// ---------------------------------------------------------------------------
// Query interface
// ---------------------------------------------------------------------------

export interface ClaudeSdkResult {
  text: string;
  /** Bare tool names called during the run (mcp__jarvis__ prefix stripped). */
  toolCalls: string[];
  numTurns: number;
  usage: { promptTokens: number; completionTokens: number };
  costUsd: number;
  durationMs: number;
}

export async function queryClaudeSdk(opts: {
  prompt: string;
  systemPrompt: string;
  toolNames: string[];
  maxTurns?: number;
  model?: string;
  abortSignal?: AbortSignal;
}): Promise<ClaudeSdkResult> {
  const mcpServer = buildMcpServer(opts.toolNames);

  const allowedTools = opts.toolNames.map((n) => `mcp__jarvis__${n}`);

  const abortController = new AbortController();
  if (opts.abortSignal) {
    opts.abortSignal.addEventListener("abort", () => abortController.abort());
  }

  // Hard timeout: kill the subprocess if it hangs. SDK has no built-in timeout
  // for the full query — maxTurns only caps turns, not wall-clock time.
  // 10 minutes is generous for any single task.
  const SDK_TIMEOUT_MS = 10 * 60_000;
  const timeoutTimer = setTimeout(() => {
    console.warn(
      `[claude-sdk] Query timed out after ${SDK_TIMEOUT_MS / 1000}s — aborting`,
    );
    abortController.abort();
  }, SDK_TIMEOUT_MS);

  const options: SdkOptions = {
    model: opts.model ?? "claude-sonnet-4-6",
    systemPrompt: opts.systemPrompt,
    mcpServers: { jarvis: mcpServer },
    allowedTools,
    tools: [], // Disable all Claude Code built-in tools
    // dontAsk + allowedTools: auto-approve listed tools, deny unlisted.
    // bypassPermissions crashes with MCP servers (exit code 1).
    permissionMode: "dontAsk",
    maxTurns: opts.maxTurns ?? 20,
    abortController,
    persistSession: false, // Ephemeral — Jarvis manages its own sessions
    cwd: process.cwd(),
    thinking: { type: "disabled" },
    env: {
      ...process.env,
      CLAUDE_AGENT_SDK_CLIENT_APP: "mission-control/1.0.0",
    },
  };

  let resultText = "";
  const toolCallNames: string[] = [];
  let numTurns = 0;
  let usage = { promptTokens: 0, completionTokens: 0 };
  let costUsd = 0;
  let durationMs = 0;

  const q = query({ prompt: opts.prompt, options });

  for await (const message of q) {
    if (message.type === "assistant") {
      // Capture tool names from assistant messages. MCP tools arrive with the
      // `mcp__jarvis__` prefix — strip it so downstream code (requiredTools
      // validation, hallucination guard) sees bare tool names that match the
      // registry.
      if (message.message?.content) {
        for (const block of message.message.content) {
          if (
            typeof block === "object" &&
            "type" in block &&
            block.type === "tool_use" &&
            "name" in block &&
            typeof block.name === "string"
          ) {
            const bareName = block.name.replace(/^mcp__jarvis__/, "");
            toolCallNames.push(bareName);
          }
        }
      }
    } else if (message.type === "result") {
      if (message.subtype === "success") {
        const success = message as SDKResultSuccess;
        resultText = success.result;
        numTurns = success.num_turns;
        usage = {
          promptTokens: success.usage?.input_tokens ?? 0,
          completionTokens: success.usage?.output_tokens ?? 0,
        };
        costUsd = success.total_cost_usd ?? 0;
        durationMs = success.duration_ms ?? 0;
      } else {
        const error = message as SDKResultError;
        const errorMsgs = error.errors?.join("; ") ?? "unknown";
        resultText = `Error: ${error.subtype} — ${errorMsgs}`;
      }
    }
  }

  clearTimeout(timeoutTimer);

  console.log(
    `[claude-sdk] Completed: ${numTurns} turns, ${toolCallNames.length} tool calls, ` +
      `$${costUsd.toFixed(4)}, ${durationMs}ms, ` +
      `tokens=${usage.promptTokens + usage.completionTokens}`,
  );

  return {
    text: resultText,
    toolCalls: toolCallNames,
    numTurns,
    usage,
    costUsd,
    durationMs,
  };
}
