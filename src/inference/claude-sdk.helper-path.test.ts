/**
 * The options handed to the SDK's `query()` carry the resolved helper path,
 * and leave the key out when the resolver gives undefined. The SDK module
 * and the resolver are replaced for the whole file: no child process starts.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

const lastQueryOptions = vi.hoisted(() => ({ value: null as unknown }));
const helper = vi.hoisted(() => ({
  path: undefined as string | undefined,
  excludeCalls: 0,
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (name: string, desc: string, shape: unknown, handler: unknown) => ({
    name,
    desc,
    shape,
    handler,
  }),
  createSdkMcpServer: (config: unknown) => ({ type: "mcp", config }),
  query: (args: { prompt: unknown; options: unknown }) => {
    lastQueryOptions.value = args.options;
    return (async function* () {
      yield {
        type: "result",
        subtype: "success",
        result: "ok",
        num_turns: 1,
        usage: { input_tokens: 5, output_tokens: 2 },
      };
    })();
  },
}));
vi.mock("./sdk-helper-path.js", () => ({
  sdkHelperPath: () => helper.path,
  excludeNetworkFromReports: () => {
    helper.excludeCalls++;
  },
}));
vi.mock("../tools/registry.js", () => ({
  toolRegistry: { get: () => undefined, execute: async () => "" },
}));
vi.mock("../observability/task-trace.js", () => ({ emitTraceEvent: vi.fn() }));
vi.mock("../config.js", () => ({
  getConfig: () => ({ budgetEnabled: false, budgetEnforce: false }),
}));

import { queryClaudeSdk } from "./claude-sdk.js";

const call = () =>
  queryClaudeSdk({
    prompt: "hola",
    systemPrompt: "sys",
    toolNames: [],
    costLedger: false,
  });
const sent = () => lastQueryOptions.value as Record<string, unknown>;

afterEach(() => {
  helper.path = undefined;
  lastQueryOptions.value = null;
});

describe("pathToClaudeCodeExecutable", () => {
  it("resolver gives a path: the options carry it", async () => {
    helper.path = "/synthetic/node_modules/helper/claude";
    await call();
    expect(sent().pathToClaudeCodeExecutable).toBe(
      "/synthetic/node_modules/helper/claude",
    );
  });

  it("resolver gives undefined: the key is absent", async () => {
    await call();
    expect(sent()).not.toBeNull();
    expect("pathToClaudeCodeExecutable" in sent()).toBe(false);
  });

  it("the report network switch is set once, when the module loads", () => {
    expect(helper.excludeCalls).toBe(1);
  });
});
