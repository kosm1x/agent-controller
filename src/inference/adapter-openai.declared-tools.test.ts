/**
 * Audit S2 (rulings 1–2): on the openai path, a run that declared a tool list
 * (a schedule's saved `tools`, a chat turn's scoped set) reaches only those
 * tools — deferred expansion stays inside the list, and an explicit `[]`
 * means no tools. A run with no declared list keeps the full registry
 * (deferred expansion over any registered deferred tool). The per-round
 * `infer` is mocked — never a real provider.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  getConfig: () => ({
    inferencePrimaryProvider: "openai",
    inferencePrimaryUrl: "http://127.0.0.1:9/v1",
    inferencePrimaryKey: "test",
    inferencePrimaryModel: "test-model",
    inferenceTimeoutMs: 5000,
    inferenceMaxTokens: 256,
    inferenceMaxRetries: 1,
    inferenceContextLimit: 128000,
    compressionThreshold: 0.85,
    budgetEnabled: false,
  }),
}));

const { def, registered } = vi.hoisted(() => ({
  def: (name: string) => ({
    type: "function" as const,
    function: {
      name,
      description: name,
      parameters: { type: "object", properties: {} },
    },
  }),
  registered: {
    web_search: { deferred: false },
    file_read: { deferred: false },
    tweet_post: { deferred: true },
    gdrive_delete: { deferred: true },
  } as Record<string, { deferred: boolean }>,
}));

// No stored secrets in this test: the outbound scrub is the identity (keeps
// the test independent of the secret index).
vi.mock("../lib/secret-refs.js", () => ({
  scrubSecrets: (t: string) => t,
  scrubJsonText: (t: string) => t,
  scrubStructured: (v: unknown) => v,
  SecretScrubUnavailableError: class extends Error {},
}));

vi.mock("../tools/registry.js", () => ({
  toolRegistry: {
    has: (n: string) => n in registered,
    findClosest: () => null,
    get: (n: string) =>
      n in registered ? { ...registered[n], definition: def(n) } : undefined,
    validate: () => ({ success: true }),
  },
}));

const inferMock = vi.hoisted(() => vi.fn());
vi.mock("./adapter.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./adapter.js")>()),
  infer: inferMock,
}));

import { inferWithToolsViaOpenAi, declaredToolSetForRun } from "./adapter-openai.js";
import {
  runWithExecutionContext,
  TaskExecutionContext,
} from "./execution-context.js";
import type { ToolDefinition } from "./adapter.js";

const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
const callTool = (name: string) => ({
  content: null,
  tool_calls: [
    { id: `c-${name}`, type: "function", function: { name, arguments: "{}" } },
  ],
  usage,
});
const finalText = { content: "listo", usage };

function inContext<T>(declared: string[] | undefined, fn: () => Promise<T>) {
  const ctx = new TaskExecutionContext("t-s2", false, {
    ...(declared !== undefined && { declaredTools: declared }),
  });
  return runWithExecutionContext(ctx, fn);
}

async function run(
  declared: string[] | undefined,
  tools: ToolDefinition[],
  calls: string[],
) {
  inferMock.mockReset();
  for (const c of calls) inferMock.mockResolvedValueOnce(callTool(c));
  inferMock.mockResolvedValue(finalText);
  const executor = vi.fn(async () => JSON.stringify({ ok: true }));
  const result = await inContext(declared, () =>
    inferWithToolsViaOpenAi(
      [{ role: "user", content: "haz algo" }],
      tools,
      executor,
      { maxRounds: 4, skipToolNudge: true, exemptAnalysisParalysis: true },
    ),
  );
  const toolResults = result.messages
    .filter((m) => m.role === "tool")
    .map((m) => JSON.parse(String(m.content)) as Record<string, unknown>);
  const sentTools = inferMock.mock.calls.map((c) =>
    ((c[0] as { tools?: ToolDefinition[] }).tools ?? []).map(
      (t) => t.function.name,
    ),
  );
  return { executor, toolResults, sentTools };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("audit S2: declared tool list bounds the openai path", () => {
  it("declaredToolSetForRun: undefined outside a run / with no list; a Set (possibly empty) when declared", async () => {
    expect(declaredToolSetForRun()).toBeUndefined();
    await inContext(undefined, async () =>
      expect(declaredToolSetForRun()).toBeUndefined(),
    );
    await inContext([], async () =>
      expect([...declaredToolSetForRun()!]).toEqual([]),
    );
    await inContext(["web_search"], async () =>
      expect([...declaredToolSetForRun()!]).toEqual(["web_search"]),
    );
  });

  it("a deferred tool OUTSIDE the declared list is not expanded and never executes", async () => {
    const { executor, toolResults, sentTools } = await run(
      ["web_search"],
      [def("web_search")],
      ["tweet_post", "tweet_post"],
    );
    expect(toolResults).toHaveLength(2);
    for (const r of toolResults) {
      expect(r.deferred_expansion).toBeUndefined();
      expect(String(r.error)).toContain('Tool "tweet_post" is not available');
    }
    expect(executor).not.toHaveBeenCalled();
    for (const names of sentTools) expect(names).toEqual(["web_search"]);
  });

  it("a deferred tool INSIDE the declared list is expanded, then executes", async () => {
    const { executor, toolResults, sentTools } = await run(
      ["web_search", "tweet_post"],
      [def("web_search")],
      ["tweet_post", "tweet_post"],
    );
    expect(toolResults[0]).toEqual(
      expect.objectContaining({ deferred_expansion: true }),
    );
    expect(executor).toHaveBeenCalledWith("tweet_post", {});
    expect(sentTools.at(-1)).toEqual(["web_search", "tweet_post"]);
  });

  it("no declared list (chat/interactive without one): any registered deferred tool still expands", async () => {
    const { executor, toolResults } = await run(
      undefined,
      [def("web_search")],
      ["gdrive_delete", "gdrive_delete"],
    );
    expect(toolResults[0]).toEqual(
      expect.objectContaining({ deferred_expansion: true }),
    );
    expect(executor).toHaveBeenCalledWith("gdrive_delete", {});
  });

  it("an explicit EMPTY list means no tools — the full-registry definitions handed in are dropped", async () => {
    // getDefinitions([]) upstream returns the whole registry.
    const all = Object.keys(registered).map(def);
    const { executor, toolResults, sentTools } = await run(
      [],
      all,
      ["web_search", "tweet_post"],
    );
    expect(sentTools[0]).toEqual([]);
    expect(executor).not.toHaveBeenCalled();
    expect(toolResults.map((r) => r.deferred_expansion)).toEqual([
      undefined,
      undefined,
    ]);
    for (const r of toolResults) expect(String(r.error)).toContain("is not available");
  });

  it("definitions outside a non-empty declared list are dropped before the first request", async () => {
    const { sentTools } = await run(
      ["file_read"],
      [def("web_search"), def("file_read")],
      [],
    );
    expect(sentTools[0]).toEqual(["file_read"]);
  });
});
