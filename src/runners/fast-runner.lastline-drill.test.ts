/**
 * Drill of the SDK last line end to end.
 *
 * Real: the fast runner, the config read from the stubbed environment, the
 * last-line arming and scope, the OpenAI-compatible provider chain, circuit
 * breakers, tool loop and stream parser, the task executor, the
 * hallucination retry and the status parser.
 *
 * Faked: the SDK queries, global fetch (a scripted queue; two OpenAI-compatible
 * providers are configured, both on a closed local port), the tool registry,
 * compaction, the secret scrub, the dispatcher, metrics, the message router,
 * knowledge-base injection, the two shadow modules and every database-facing
 * module.
 *
 * Not covered here:
 * - tool schema validation, risk tiers, deferral expansion and tool-name
 *   repair (the registry fake accepts every call at low risk);
 * - the confirmation gate asking (every run is non-interactive);
 * - the first-round tool nudge and the chat path (no conversation history);
 * - a tool that itself calls inference;
 * - cost booking after the runner reports its usage.
 *
 * Each scenario asserts on what crosses a boundary: the wire request, the
 * executed tool calls and the runner's output.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import type { ChatMessage, ToolCall } from "../inference/adapter.js";
import type { RunnerInput, RunnerOutput } from "./types.js";

// config.ts reads the environment once, at the first getConfig() call, and
// caches it for this file's module registry: stubbed here before any import,
// and again before each test so an unstub in afterEach never reaches a read.
const drill = vi.hoisted(() => {
  const env = {
    MC_API_KEY: "drill-api-key",
    MC_DB_PATH: ":memory:",
    PROMPT_DUMP_DIR: "",
    INFERENCE_PRIMARY_PROVIDER: "claude-sdk",
    // A second OpenAI-compatible provider, ahead of the fallback in priority:
    // a last-line call that is not pinned would reach it first.
    INFERENCE_PRIMARY_URL: "http://127.0.0.1:1/primary",
    INFERENCE_PRIMARY_KEY: "drill-synthetic-primary-key",
    INFERENCE_PRIMARY_MODEL: "drill-primary-model",
    INFERENCE_SDK_LASTLINE_ENABLED: "true",
    INFERENCE_FALLBACK_URL: "http://127.0.0.1:1/v1",
    INFERENCE_FALLBACK_KEY: "drill-synthetic-key",
    INFERENCE_FALLBACK_MODEL: "drill-fallback-model",
    INFERENCE_TERTIARY_URL: "",
    INFERENCE_TERTIARY_MODEL: "",
    INFERENCE_MAX_RETRIES: "1",
    INFERENCE_TIMEOUT_MS: "5000",
    INFERENCE_MAX_TOKENS: "256",
    INFERENCE_CONTEXT_LIMIT: "128000",
    COMPRESSION_THRESHOLD: "0.85",
  };
  const stubEnv = () => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  };
  stubEnv();
  return { env, stubEnv };
});

// Tool execution: each call takes the next scripted result and is counted.
const tools = vi.hoisted(() => ({
  results: [] as Array<string | (() => string)>,
  execute: vi.fn(async (_name: string, _args: Record<string, unknown>) => {
    const next = tools.results.shift();
    if (next === undefined) throw new Error("drill: unscripted tool call");
    return typeof next === "function" ? next() : next;
  }),
  def: (name: string) => ({
    type: "function" as const,
    function: {
      name,
      description: `${name} (drill)`,
      parameters: { type: "object", properties: {}, required: [] },
    },
  }),
  hints: {
    file_read: { readOnlyHint: true },
    file_write: { readOnlyHint: false },
  } as Record<string, { readOnlyHint: boolean }>,
}));

const sdk = vi.hoisted(() => ({
  queryClaudeSdk: vi.fn(),
  // infer() on the SDK path: a call here from inside the last line is a leak.
  queryClaudeSdkAsInfer: vi.fn(async () => {
    throw new Error("drill: SDK infer unavailable");
  }),
}));
const traceMock = vi.hoisted(() => vi.fn());
const retryOutcome = vi.hoisted(() => vi.fn());
// Every database access throws; each call records its stack so a seal can
// name the one caller allowed to ask (the store rule's seen-set read).
const dbStacks = vi.hoisted(() => [] as string[]);
const dbGuard = vi.hoisted(() =>
  vi.fn(() => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 60;
    dbStacks.push(new Error().stack ?? "");
    Error.stackTraceLimit = limit;
    throw new Error("drill: database access");
  }),
);
const compaction = vi.hoisted(() => ({
  calls: [] as Array<{ messages: unknown[]; threshold: unknown }>,
}));

// registerRunner runs on import; the dispatcher singleton stays untouched.
vi.mock("../dispatch/dispatcher.js", () => ({ registerRunner: vi.fn() }));

// Two tools, so deferral is skipped; the real write-target derivation.
vi.mock("../tools/registry.js", async (importOriginal) => ({
  writeTargetKeys: (
    await importOriginal<typeof import("../tools/registry.js")>()
  ).writeTargetKeys,
  toolRegistry: {
    getDefinitions: () => [tools.def("file_read"), tools.def("file_write")],
    getDeferredCatalog: () => "",
    get: (name: string) => tools.hints[name],
    has: (name: string) => name in tools.hints,
    findClosest: () => null,
    validate: () => ({ success: true }),
    getEffectiveRiskTier: () => "low",
    execute: tools.execute,
  },
}));

// The SDK leg: scripted per test; tool search off; SDK infer always fails.
vi.mock("../inference/claude-sdk.js", () => ({
  queryClaudeSdk: sdk.queryClaudeSdk,
  queryClaudeSdkAsInfer: sdk.queryClaudeSdkAsInfer,
  SONNET_MODEL_ID: "drill-sdk-model",
  HAIKU_MODEL_ID: "drill-sdk-small-model",
  toolSearchEnabled: () => false,
}));

// Database-facing: telemetry, checkpoint, trace writer, file-mutation record.
vi.mock("../intelligence/scope-telemetry.js", () => ({
  recordToolExecution: vi.fn(),
  recordToolRepairs: vi.fn(),
}));
vi.mock("./checkpoint.js", () => ({ writeCheckpoint: vi.fn() }));
vi.mock("../observability/task-trace.js", () => ({ emitTraceEvent: traceMock }));
vi.mock("../db/task-mutations.js", () => ({
  recordMutationFromResult: vi.fn(),
}));
// Any other database access fails loudly and is checked after each test.
vi.mock("../db/index.js", () => ({ getDatabase: dbGuard }));

// Metrics registry: the retry outcome is read by the retry scenario.
vi.mock("../observability/prometheus.js", () => ({
  recordFastRetryOutcome: retryOutcome,
  recordMemoryInjection: vi.fn(),
}));

// Heavy messaging / shadow modules the runner imports statically; this
// drill runs the non-chat path, which never calls them.
vi.mock("../messaging/router.js", () => ({
  CACHE_BREAK_MARKER: "###CACHE_BREAK###",
}));
vi.mock("../messaging/kb-injection.js", () => ({
  buildKnowledgeBaseSection: vi.fn(() => ""),
  buildKnowledgeBaseSections: vi.fn(() => ({ stable: null, variable: null })),
  conditionMatches: vi.fn(() => false),
}));
vi.mock("../jev/shadow-kb.js", () => ({ shadowKbRows: vi.fn() }));
vi.mock("../jev/shadow.js", () => ({ shadowMemoryRecall: vi.fn() }));

// No stored secrets: the outbound scrub is the identity.
vi.mock("../lib/secret-refs.js", () => ({
  scrubSecrets: (t: string) => t,
  scrubJsonText: (t: string) => t,
  scrubStructured: (v: unknown) => v,
  SecretScrubUnavailableError: class extends Error {},
}));

// Compaction keeps only the last message and records each call.
vi.mock("../prometheus/compaction-pipeline.js", () => ({
  compactConversation: vi.fn(
    async (messages: unknown[], _limit: number, threshold: number) => {
      compaction.calls.push({ messages: [...messages], threshold });
      return {
        messages: messages.slice(-1),
        level: "L1",
        removedCount: messages.length - 1,
      };
    },
  ),
}));

import { fastRunner } from "./fast-runner.js";
import { circuitRegistry } from "../lib/circuit-breaker.js";

const FALLBACK_BASE = drill.env.INFERENCE_FALLBACK_URL;
const FALLBACK_MODEL = drill.env.INFERENCE_FALLBACK_MODEL;
const FALLBACK_KEY = drill.env.INFERENCE_FALLBACK_KEY;
const PRIMARY_BASE = drill.env.INFERENCE_PRIMARY_URL;

// ---------------------------------------------------------------------------
// The wire: a scripted fetch that records every request.
// ---------------------------------------------------------------------------

type WireCall = {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};
const wire = {
  queue: [] as Array<() => Response>,
  calls: [] as WireCall[],
};

function stubFetch(...responses: Array<() => Response>): void {
  wire.queue = [...responses];
  wire.calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      wire.calls.push({
        url: String(input),
        headers: { ...(init?.headers as Record<string, string>) },
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      const next = wire.queue.shift();
      if (!next) throw new Error("drill: unscripted fetch");
      return next();
    }),
  );
}

const usage = (prompt: number, completion: number) => ({
  prompt_tokens: prompt,
  completion_tokens: completion,
  total_tokens: prompt + completion,
});

const toolCall = (
  id: string,
  name: string,
  args: Record<string, unknown>,
): ToolCall => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

/** A non-streamed chat-completions answer. */
function jsonAnswer(
  message: { content: string | null; tool_calls?: ToolCall[] },
  u = usage(10, 2),
): () => Response {
  return () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            index: 0,
            message: { role: "assistant", ...message },
            finish_reason: message.tool_calls ? "tool_calls" : "stop",
          },
        ],
        usage: u,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
}

/** A body that delivers each string as its own network chunk. */
function chunkedBody(parts: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(enc.encode(p));
      controller.close();
    },
  });
}

/** One SSE event in the public chat-completions streaming framing. */
const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

/** A streamed answer: text deltas, or one tool call whose arguments arrive in
 *  two deltas, then the empty-choices usage chunk and the end marker. */
function streamedAnswer(
  parts: { text?: string[]; call?: ToolCall },
  u = usage(10, 2),
): () => Response {
  const events = [sse({ choices: [{ index: 0, delta: { role: "assistant" } }] })];
  for (const t of parts.text ?? []) {
    events.push(sse({ choices: [{ index: 0, delta: { content: t } }] }));
  }
  if (parts.call) {
    const { id, function: fn } = parts.call;
    const half = Math.floor(fn.arguments.length / 2);
    events.push(
      sse({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id,
                  type: "function",
                  function: { name: fn.name, arguments: fn.arguments.slice(0, half) },
                },
              ],
            },
          },
        ],
      }),
      sse({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: fn.arguments.slice(half) } }],
            },
          },
        ],
      }),
    );
  }
  events.push(
    sse({
      choices: [
        { index: 0, delta: {}, finish_reason: parts.call ? "tool_calls" : "stop" },
      ],
    }),
    sse({ choices: [], usage: u }),
    "data: [DONE]\n\n",
  );
  return () =>
    new Response(chunkedBody(events), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
}

// ---------------------------------------------------------------------------
// The SDK leg and the run.
// ---------------------------------------------------------------------------

/** Leg 1 of the SDK path ends on an eligible API error: no auth text, no
 *  tool call, non-zero usage. */
function sdkOverloaded() {
  return {
    text: "[error_api_response — overloaded, status 529: Overloaded] No content produced.\n\nSTATUS: BLOCKED — the SDK leg ended on an API error.",
    toolCalls: [] as string[],
    numTurns: 1,
    usage: {
      promptTokens: 300,
      completionTokens: 7,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    model: "drill-sdk-model",
    costUsd: 0,
    costAuthoritative: true,
    durationMs: 5,
    errorClass: "overloaded",
  };
}

/** Leg 1 ends on an error class the last line accepts, but its text is an
 *  authentication failure. */
function sdkAuthFailure() {
  return {
    ...sdkOverloaded(),
    text: "[error_api_response — authentication_failed, status 401: OAuth session expired] No content produced.\n\nSTATUS: BLOCKED — the SDK leg ended on an API error.",
    errorClass: "unknown",
  };
}

/** An SDK leg that answers. */
function sdkAnswer(text: string) {
  const { errorClass: _drop, ...rest } = sdkOverloaded();
  return { ...rest, text, usage: { ...rest.usage, promptTokens: 120, completionTokens: 9 } };
}

const lastlineTraces = () =>
  traceMock.mock.calls
    .map((c) => c[0] as { name: string; attrs?: Record<string, unknown> })
    .filter((e) => e.name === "inference.lastline")
    .map((e) => e.attrs);

function run(extra: Partial<RunnerInput> = {}): Promise<RunnerOutput> {
  return fastRunner.execute({
    taskId: "drill-task",
    runId: "drill-run",
    title: "Drill task",
    description: "Prepare the note for Example Corp.",
    interactive: false,
    ...extra,
  });
}

const outputOf = (r: RunnerOutput) =>
  (typeof r.output === "object" ? r.output : undefined) as
    | { text?: string; exitReason?: string; roundsCompleted?: number }
    | undefined;

const WRITE_ARGS = { path: "/drill/notes.txt", content: "Example Corp" };

/** Every request went to the fallback provider with the fallback model, none
 *  to the other configured provider or back to the SDK, and no database was
 *  touched — except, when `storeRuleReads` is given, exactly that many asks
 *  for the handle, each made by the mailbox-password store rule's seen-set
 *  read inside the persisted-error helper (it throws here, so the rule
 *  writes the text as before). */
function expectSealed(storeRuleReads = 0): void {
  for (const c of wire.calls) {
    expect(c.url.startsWith(`${FALLBACK_BASE}/`)).toBe(true);
    expect(c.url.startsWith(`${PRIMARY_BASE}/`)).toBe(false);
    expect(c.body.model).toBe(FALLBACK_MODEL);
  }
  expect(sdk.queryClaudeSdkAsInfer).not.toHaveBeenCalled();
  if (storeRuleReads === 0) {
    expect(dbGuard).not.toHaveBeenCalled();
    return;
  }
  expect(dbGuard).toHaveBeenCalledTimes(storeRuleReads);
  expect(dbStacks).toHaveLength(storeRuleReads);
  for (const stack of dbStacks) {
    expect(stack).toMatch(/\bstoreSeenSet\b/);
    expect(stack).toMatch(/\bwithholdForStore\b/);
    expect(stack).toMatch(/\bredactCredentialsForPersist\b/);
  }
  // The failed read is the no-database branch, not a loader failure.
  const warned = (console.warn as unknown as MockInstance).mock.calls.flat().join(" ");
  expect(warned).not.toContain("store-withhold");
}

let consoleSpies: MockInstance[] = [];

beforeEach(() => {
  drill.stubEnv();
  sdk.queryClaudeSdk.mockReset();
  sdk.queryClaudeSdk.mockResolvedValueOnce(sdkOverloaded());
  sdk.queryClaudeSdkAsInfer.mockClear();
  tools.results.length = 0;
  tools.execute.mockClear();
  compaction.calls.length = 0;
  traceMock.mockClear();
  retryOutcome.mockClear();
  dbGuard.mockClear();
  dbStacks.length = 0;
  wire.queue = [];
  wire.calls = [];
  consoleSpies = [
    vi.spyOn(console, "log").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation(() => {}),
  ];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  circuitRegistry.reset();
  for (const s of consoleSpies) s.mockRestore();
});

describe("SDK last line — end to end through the real runner and adapter", () => {
  it("an overloaded SDK leg hands over; one fallback round answers; usage is both legs summed and the model is the fallback's", async () => {
    stubFetch(
      jsonAnswer({ content: "Example Corp has three offices.\n\nSTATUS: DONE" }, usage(40, 5)),
    );

    const r = await run();

    expect(sdk.queryClaudeSdk).toHaveBeenCalledTimes(1);
    expect(r.success).toBe(true);
    expect(r.status).toBe("DONE");
    expect(outputOf(r)?.text).toBe("Example Corp has three offices.");
    expect(wire.calls).toHaveLength(1);
    const [call] = wire.calls;
    expect(call.url).toBe(`${FALLBACK_BASE}/chat/completions`);
    expect(call.body.model).toBe(FALLBACK_MODEL);
    expect(call.body.stream).toBe(false);
    expect(call.headers.Authorization).toBe(`Bearer ${FALLBACK_KEY}`);
    expect(r.tokenUsage).toEqual({
      promptTokens: 300 + 40,
      completionTokens: 7 + 5,
      actualModel: FALLBACK_MODEL,
    });
    expect(
      traceMock.mock.calls
        .map((c) => c[0] as { name: string; attrs?: Record<string, unknown> })
        .filter((e) => e.name === "inference.lastline")
        .map((e) => e.attrs),
    ).toEqual([
      {
        provider: "fallback",
        model: FALLBACK_MODEL,
        reason: "api_error",
        errorClass: "overloaded",
      },
    ]);
    expect(tools.execute).not.toHaveBeenCalled();
    expectSealed();
  });

  it("an authentication failure inside an accepted error class is not handed over: the auth retry runs on the SDK and its answer stands", async () => {
    sdk.queryClaudeSdk.mockReset();
    sdk.queryClaudeSdk
      .mockResolvedValueOnce(sdkAuthFailure())
      .mockResolvedValueOnce(sdkAnswer("Example Corp has three offices.\n\nSTATUS: DONE"));
    stubFetch();

    const r = await run();

    expect(sdk.queryClaudeSdk).toHaveBeenCalledTimes(2);
    expect(wire.calls).toHaveLength(0);
    expect(lastlineTraces()).toEqual([]);
    expect(r.success).toBe(true);
    expect(r.status).toBe("DONE");
    expect(outputOf(r)?.text).toBe("Example Corp has three offices.");
    expectSealed();
  });

  it("an authentication failure that the auth retry repeats is handed over once, as an auth hand-over", async () => {
    sdk.queryClaudeSdk.mockReset();
    sdk.queryClaudeSdk
      .mockResolvedValueOnce(sdkAuthFailure())
      .mockResolvedValueOnce(sdkAuthFailure());
    stubFetch(
      jsonAnswer({ content: "Example Corp has three offices.\n\nSTATUS: DONE" }, usage(40, 5)),
    );

    const r = await run();

    expect(sdk.queryClaudeSdk).toHaveBeenCalledTimes(2);
    expect(wire.calls).toHaveLength(1);
    expect(lastlineTraces()).toEqual([
      { provider: "fallback", model: FALLBACK_MODEL, reason: "auth" },
    ]);
    expect(r.success).toBe(true);
    expect(outputOf(r)?.text).toBe("Example Corp has three offices.");
    // Both SDK legs and the fallback round.
    expect(r.tokenUsage).toEqual({
      promptTokens: 300 + 300 + 40,
      completionTokens: 7 + 7 + 5,
      actualModel: FALLBACK_MODEL,
    });
    expectSealed();
  });

  it("a write that failed in the streamed main leg and succeeded in the non-streamed retry leg on the same target counts as done", async () => {
    const chunks: string[] = [];
    tools.results.push('{"error":"timeout after 30s"}', '{"ok":true}');
    stubFetch(
      streamedAnswer({ call: toolCall("c1", "file_write", WRITE_ARGS) }, usage(21, 3)),
      streamedAnswer({ text: ["✅ Note ", "written."] }, usage(34, 4)),
      jsonAnswer(
        { content: null, tool_calls: [toolCall("c2", "file_write", WRITE_ARGS)] },
        usage(55, 6),
      ),
      jsonAnswer(
        { content: "✅ Note written on the second try.\n\nSTATUS: DONE" },
        usage(89, 8),
      ),
    );

    const r = await run({ onTextChunk: (t) => chunks.push(t) });

    expect(tools.execute).toHaveBeenCalledTimes(2);
    expect(tools.execute.mock.calls).toEqual([
      ["file_write", WRITE_ARGS],
      ["file_write", WRITE_ARGS],
    ]);
    expect(r.success).toBe(true);
    expect(r.status).toBe("DONE");
    expect(outputOf(r)?.text).toBe("✅ Note written on the second try.");
    expect(retryOutcome).toHaveBeenCalledWith("success");
    // The abandoned SDK leg, both streamed main-leg calls (usage arrives in
    // the empty-choices chunk) and both retry-leg calls.
    expect(r.tokenUsage).toEqual({
      promptTokens: 300 + 21 + 34 + 55 + 89,
      completionTokens: 7 + 3 + 4 + 6 + 8,
      actualModel: FALLBACK_MODEL,
    });
    // Main leg streams every round; the retry leg streams none.
    expect(wire.calls.map((c) => c.body.stream)).toEqual([true, true, false, false]);
    expect(chunks).toEqual(["✅ Note ", "written."]);
    // The retry leg opens with the leg-1 failure and the correction prompt.
    const retryMessages = wire.calls[2].body.messages as ChatMessage[];
    const last = retryMessages[retryMessages.length - 1];
    expect(last.role).toBe("user");
    expect(String(last.content).startsWith("ALTO:")).toBe(true);
    expect(retryMessages.some((m) => m.role === "tool" && m.tool_call_id === "c1")).toBe(true);
    expectSealed();
  });

  it("a request-too-large answer is compacted once at the aggressive threshold and the compacted conversation is resent; the resend reuses the round index (a refused request is not a model turn)", async () => {
    stubFetch(
      () => new Response("request entity too large", { status: 413 }),
      jsonAnswer({ content: "Example Corp answer after compaction.\n\nSTATUS: DONE" }),
    );

    const r = await run();

    expect(wire.calls).toHaveLength(2);
    expect(compaction.calls).toHaveLength(1);
    expect(compaction.calls[0].threshold).toBe(0.5);
    const compacted = compaction.calls[0].messages.slice(-1);
    expect(wire.calls[1].body.messages).toEqual(JSON.parse(JSON.stringify(compacted)));
    expect(r.success).toBe(true);
    expect(outputOf(r)?.text).toBe("Example Corp answer after compaction.");
    expect(outputOf(r)?.exitReason).toBe("natural");
    expect(outputOf(r)?.roundsCompleted).toBe(1);
    // The refused request's error text goes through the persisted-error
    // helper, whose store rule asks once for the seen set.
    expectSealed(1);
  });

  it("a cancellation inside the first tool call stops the loop: no request after it, and no retry leg runs a tool", async () => {
    const controller = new AbortController();
    tools.results.push(() => {
      controller.abort();
      return '{"ok":true}';
    });
    stubFetch(
      jsonAnswer({ content: null, tool_calls: [toolCall("c1", "file_write", WRITE_ARGS)] }),
    );

    const r = await run({ signal: controller.signal });

    expect(wire.calls).toHaveLength(1);
    expect(tools.execute).toHaveBeenCalledTimes(1);
    expect(outputOf(r)?.exitReason).toBe("aborted");
    expect(r.terminationReason).toBe("aborted");
    expectSealed();
  });

  it("a last-line run cancelled inside a tool call does not report success", async () => {
    const controller = new AbortController();
    tools.results.push(() => {
      controller.abort();
      return '{"ok":true}';
    });
    stubFetch(
      jsonAnswer({ content: null, tool_calls: [toolCall("c1", "file_write", WRITE_ARGS)] }),
    );

    const r = await run({ signal: controller.signal });

    expect(r.success).toBe(false);
    expect(r.status).toBeUndefined();
    expect(r.terminationReason).toBe("aborted");
    expect(r.error).toBe("cancelled");
    // The spend is still reported, so the cost is booked.
    expect(r.tokenUsage).toMatchObject({ actualModel: FALLBACK_MODEL });
    expectSealed();
  });

  it("an SDK-path run cancelled mid-answer does not report success and is not handed over", async () => {
    const controller = new AbortController();
    sdk.queryClaudeSdk.mockReset();
    sdk.queryClaudeSdk.mockImplementationOnce(async () => {
      controller.abort();
      // The SDK hands back what streamed before the abort: no STATUS line.
      return sdkAnswer("Example Corp has three off");
    });
    stubFetch();

    const r = await run({ signal: controller.signal });

    expect(sdk.queryClaudeSdk).toHaveBeenCalledTimes(1);
    expect(wire.calls).toHaveLength(0);
    expect(lastlineTraces()).toEqual([]);
    expect(r.success).toBe(false);
    expect(r.status).toBeUndefined();
    expect(r.terminationReason).toBe("aborted");
    expect(r.error).toBe("cancelled");
    expect(r.tokenUsage).toMatchObject({ promptTokens: 120, completionTokens: 9 });
  });

  it("an open fallback breaker refuses the hand-over without a request; the failure names the breaker and the provider", async () => {
    circuitRegistry
      .get("fallback", { failureThreshold: 1, cooldownMs: 60_000 })
      .recordFailure();
    stubFetch();

    const r = await run();

    expect(wire.calls).toHaveLength(0);
    expect(tools.execute).not.toHaveBeenCalled();
    expect(r.success).toBe(false);
    expect(r.error).toContain("Circuit breaker OPEN for fallback");
    expect(r.error).not.toContain("undefined");
    expectSealed();
  });
});
