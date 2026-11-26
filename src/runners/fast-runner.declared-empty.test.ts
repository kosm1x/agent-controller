/**
 * Fast runner — a run that declares an EMPTY tool list.
 *
 * A declared `[]` is no tools: no definitions on either model path, no
 * deferred catalog text, and no "No tools available" failure. An undeclared
 * run (no list) keeps every registered tool; a declared list that selects
 * nothing still fails.
 *
 * Faked for the whole file: the tool-loop calls, the SDK query, the config,
 * the tool registry, the dispatcher, trace, metrics, telemetry, checkpoint,
 * prompt dump, knowledge-base and shadow modules, the secret scrub, and the
 * database (every access throws and fails the test).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../inference/adapter.js";
import type { RunnerInput } from "./types.js";

const state = vi.hoisted(() => ({
  provider: "openai" as "openai" | "claude-sdk",
  toolSearch: false,
}));
const dbGuard = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("declared-empty test: database access");
  }),
);

vi.mock("../dispatch/dispatcher.js", () => ({ registerRunner: vi.fn() }));
vi.mock("../config.js", () => ({
  getConfig: vi.fn(() => ({
    inferencePrimaryProvider: state.provider,
    inferencePrimaryUrl: "http://127.0.0.1:1",
    inferencePrimaryKey: "test-key",
    inferencePrimaryModel: "test-model",
    inferenceContextLimit: 200_000,
    compressionThreshold: 0.85,
    inferenceTimeoutMs: 30_000,
    inferenceMaxTokens: 4096,
    inferenceMaxRetries: 1,
  })),
}));
vi.mock("../tools/registry.js", async (importOriginal) => ({
  writeTargetKeys: (
    await importOriginal<typeof import("../tools/registry.js")>()
  ).writeTargetKeys,
  toolRegistry: {
    getDefinitions: vi.fn(),
    getDeferredCatalog: vi.fn(),
    get: vi.fn(() => undefined),
    has: vi.fn(() => false),
    findClosest: vi.fn(() => null),
  },
}));
vi.mock("../inference/adapter.js", async (importOriginal) => ({
  inferWithTools: vi.fn(),
  sdkLastline: vi.fn(() => null),
  lastlineEligible: (
    await importOriginal<typeof import("../inference/adapter.js")>()
  ).lastlineEligible,
  inferWithToolsLastline: vi.fn(),
}));
vi.mock("../inference/claude-sdk.js", () => ({
  queryClaudeSdk: vi.fn(),
  toolSearchEnabled: () => state.toolSearch,
}));
vi.mock("../intelligence/scope-telemetry.js", () => ({
  recordToolExecution: vi.fn(),
  recordToolRepairs: vi.fn(),
}));
vi.mock("./checkpoint.js", () => ({ writeCheckpoint: vi.fn() }));
vi.mock("../observability/task-trace.js", () => ({ emitTraceEvent: vi.fn() }));
vi.mock("./prompt-dump.js", () => ({ dumpPrompt: vi.fn() }));
vi.mock("../observability/prometheus.js", () => ({
  recordFastRetryOutcome: vi.fn(),
  recordMemoryInjection: vi.fn(),
}));
vi.mock("../messaging/kb-injection.js", () => ({
  buildKnowledgeBaseSection: vi.fn(() => ""),
  buildKnowledgeBaseSections: vi.fn(() => ({ stable: null, variable: null })),
  conditionMatches: vi.fn(() => false),
}));
vi.mock("../messaging/precedent.js", () => ({
  buildPrecedentBlock: vi.fn(() => ""),
}));
vi.mock("../memory/jme.js", () => ({
  queryMemory: vi.fn(async () => []),
  orderForInjection: <T>(facts: T[]) => facts,
  jmeRecallQuery: vi.fn(() => null),
}));
vi.mock("../memory/essentials.js", () => ({
  getEssentialFacts: vi.fn(() => ""),
}));
vi.mock("../jev/shadow-kb.js", () => ({ shadowKbRows: vi.fn() }));
vi.mock("../jev/shadow.js", () => ({ shadowMemoryRecall: vi.fn() }));
vi.mock("../messaging/confirmation-verbs.js", () => ({
  buildConfirmRegex: vi.fn(() => /confirma/i),
}));
vi.mock("../lib/secret-refs.js", () => ({
  scrubSecrets: (t: string) => t,
  scrubJsonText: (t: string) => t,
  scrubStructured: (v: unknown) => v,
  SecretScrubUnavailableError: class extends Error {},
}));
vi.mock("../db/index.js", () => ({ getDatabase: dbGuard }));

import { fastRunner } from "./fast-runner.js";
import { inferWithTools } from "../inference/adapter.js";
import { queryClaudeSdk } from "../inference/claude-sdk.js";
import { toolRegistry } from "../tools/registry.js";
import { TOKEN_BUDGET_BROWSER, TOKEN_BUDGET_FAST } from "../config/constants.js";

const CATALOG = "[DEFERRED TOOLS] synthetic catalog";
const NO_TOOLS =
  "No tools available. Register tools before running fast tasks.";

const def = (name: string) => ({
  type: "function" as const,
  function: {
    name,
    description: `${name} (synthetic)`,
    parameters: { type: "object", properties: {}, required: [] },
  },
});
const defs = (n: number) =>
  Array.from({ length: n }, (_, i) => def(`tool_${i}`));

const mockInfer = vi.mocked(inferWithTools);
const mockSdk = vi.mocked(queryClaudeSdk);
const mockGetDefinitions = vi.mocked(toolRegistry.getDefinitions);
const mockGetCatalog = vi.mocked(toolRegistry.getDeferredCatalog);

const inferResult = () => ({
  content: "STATUS: DONE\nReady.",
  messages: [] as ChatMessage[],
  totalUsage: { prompt_tokens: 1000, completion_tokens: 100 },
  toolRepairs: [] as Array<{ original: string; repaired: string }>,
  exitReason: "done",
  roundsCompleted: 1,
  contextPressure: 0.1,
  compactionApplied: undefined,
  model: "test-model",
});
const sdkResult = () => ({
  text: "STATUS: DONE\nReady.",
  toolCalls: [] as string[],
  numTurns: 1,
  usage: {
    promptTokens: 1000,
    completionTokens: 100,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  },
  model: "test-model",
  costUsd: 0.01,
  costAuthoritative: true,
  durationMs: 5,
});

const run = (extra: Partial<RunnerInput> = {}) =>
  fastRunner.execute({
    taskId: "task-de",
    runId: "run-de",
    title: "Synthetic task",
    description: "Do the synthetic task.",
    interactive: false,
    ...extra,
  });

beforeEach(() => {
  vi.clearAllMocks();
  state.provider = "openai";
  state.toolSearch = false;
  mockGetDefinitions.mockImplementation(() => defs(7));
  mockGetCatalog.mockImplementation(() => CATALOG);
  mockInfer.mockImplementation(async () => inferResult());
  mockSdk.mockImplementation(async () => sdkResult() as never);
});

afterEach(() => {
  expect(dbGuard).not.toHaveBeenCalled();
});

describe("fast runner — a declared-empty tool list", () => {
  it("tool-loop path: a run that declares an empty list is sent no definitions and no deferred catalog text, and completes", async () => {
    const r = await run({ tools: [] });
    expect(mockInfer).toHaveBeenCalledTimes(1);
    const [messages, sent] = mockInfer.mock.calls[0]!;
    expect(sent).toEqual([]);
    expect(JSON.stringify(messages)).not.toContain(CATALOG);
    expect(mockGetCatalog).not.toHaveBeenCalled();
    expect(r.success).toBe(true);
  });

  it("other model path, tool search off: a declared-empty run's system text holds no deferred catalog and its tool name list is empty", async () => {
    state.provider = "claude-sdk";
    const r = await run({ tools: [] });
    expect(mockSdk).toHaveBeenCalledTimes(1);
    const call = mockSdk.mock.calls[0]![0];
    expect(call.systemPrompt).not.toContain(CATALOG);
    expect(JSON.stringify(call)).not.toContain(CATALOG);
    expect(call.toolNames).toEqual([]);
    expect(mockInfer).not.toHaveBeenCalled();
    expect(r.success).toBe(true);
  });

  it("a declared list of only unregistered names still fails with the no-tools failure", async () => {
    mockGetDefinitions.mockImplementation(() => []);
    const r = await run({ tools: ["tool_z"] });
    expect(r.success).toBe(false);
    expect(r.error).toBe(NO_TOOLS);
    expect(mockInfer).not.toHaveBeenCalled();
  });

  it("an undeclared run with an empty registry still fails with the no-tools failure", async () => {
    mockGetDefinitions.mockImplementation(() => []);
    const r = await run();
    expect(r.success).toBe(false);
    expect(r.error).toBe(NO_TOOLS);
    expect(mockInfer).not.toHaveBeenCalled();
  });

  it("an undeclared run with seven registered tools is still sent the catalog", async () => {
    const r = await run();
    expect(mockGetCatalog).toHaveBeenCalledWith(undefined);
    expect(mockInfer).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockInfer.mock.calls[0]![0])).toContain(CATALOG);
    expect(r.success).toBe(true);
  });

  it("with more than sixty registered definitions, a declared-empty run is handed the base budget and an undeclared run the larger one", async () => {
    expect(TOKEN_BUDGET_BROWSER).toBeGreaterThan(TOKEN_BUDGET_FAST);
    mockGetDefinitions.mockImplementation(() => defs(61));
    await run({ tools: [] });
    await run();
    expect(mockInfer).toHaveBeenCalledTimes(2);
    expect(mockInfer.mock.calls[0]![3]?.tokenBudget).toBe(TOKEN_BUDGET_FAST);
    expect(mockInfer.mock.calls[1]![3]?.tokenBudget).toBe(TOKEN_BUDGET_BROWSER);
  });
});
