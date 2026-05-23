/**
 * Fast runner integration tests — Sprint 1 R-4.
 *
 * Drives `fastRunner.execute()` end-to-end through the OpenAI-compat branch
 * (where `writeCheckpoint`, the hallucination-retry protocol, and mechanical
 * replacement all live). The Claude SDK branch (production default) returns
 * before any of those paths fire, so it's out of scope here — see R-1 audit
 * W1 in `feedback_session_*.md` / commit 003e5e8 for the path-divergence
 * context.
 *
 * Mock surface is intentionally broad because the runner is a 1.7K-LOC
 * orchestrator with many dependencies. Each mock has a one-line rationale.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatMessage } from "../inference/adapter.js";

// `registerRunner` auto-fires on `fast-runner.ts` import — make it a no-op
// so import doesn't pollute the dispatcher singleton in unrelated tests.
vi.mock("../dispatch/dispatcher.js", () => ({
  registerRunner: vi.fn(),
}));

// Force the OpenAI-compat branch (SDK branch returns before any of the
// behaviors we want to test). Other config fields are mocked with
// realistic-but-not-load-bearing values.
vi.mock("../config.js", () => ({
  getConfig: vi.fn(() => ({
    inferencePrimaryProvider: "openai",
    inferencePrimaryUrl: "http://localhost:9999",
    inferencePrimaryKey: "test-key",
    inferencePrimaryModel: "test-model",
    inferenceContextLimit: 200_000,
    compressionThreshold: 0.85,
    inferenceTimeoutMs: 30_000,
    inferenceMaxTokens: 4096,
    inferenceMaxRetries: 3,
  })),
}));

// Tool registry: provide 4 fake tools (≤6 threshold → skipDeferral=true
// → all definitions loaded full, simplest test path). file_write is in
// `WRITE_TOOLS` so the hallucination guard can light up against it.
vi.mock("../tools/registry.js", () => ({
  toolRegistry: {
    getDefinitions: vi.fn(() => [
      {
        type: "function",
        function: {
          name: "file_read",
          description: "Read a file.",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
      {
        type: "function",
        function: {
          name: "file_write",
          description: "Write a file.",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
      {
        type: "function",
        function: {
          name: "shell_exec",
          description: "Shell.",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
      {
        type: "function",
        function: {
          name: "web_search",
          description: "Search.",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
    ]),
    getDeferredCatalog: vi.fn(() => ""),
    has: vi.fn((name: string) =>
      ["file_read", "file_write", "shell_exec", "web_search"].includes(name),
    ),
    findClosest: vi.fn(() => null),
  },
}));

// The actual inference layer. All three tests program this mock with
// predetermined results to drive the runner down specific paths.
vi.mock("../inference/adapter.js", () => ({
  inferWithTools: vi.fn(),
}));

// Telemetry: no-op for tests. R-1's UPSERT is unit-tested in
// scope-telemetry.test.ts; here we just don't want the DB calls.
vi.mock("../intelligence/scope-telemetry.js", () => ({
  recordToolExecution: vi.fn(),
  recordToolRepairs: vi.fn(),
}));

// Checkpoint: spied on by Test B.
vi.mock("./checkpoint.js", () => ({
  writeCheckpoint: vi.fn(),
}));

// Retry-outcome counter: spied on by Test C.
vi.mock("../observability/prometheus.js", () => ({
  recordFastRetryOutcome: vi.fn(),
}));

// KB / essentials / precedent: skip injection in non-chat path. The chat
// path is gated by `input.conversationHistory` — tests omit it, so the
// non-chat path (simpler system + user message) is taken regardless of
// what these return.
vi.mock("../messaging/kb-injection.js", () => ({
  buildKnowledgeBaseSection: vi.fn(() => ""),
  buildKnowledgeBaseSections: vi.fn(() => ""),
  conditionMatches: vi.fn(() => false),
}));

vi.mock("../memory/essentials.js", () => ({
  getEssentialFacts: vi.fn(() => ""),
}));

// router.ts is a heavy module — mock CACHE_BREAK_MARKER (the only thing
// fast-runner.ts imports from it) so we don't transitively load the
// messaging stack.
vi.mock("../messaging/router.js", () => ({
  CACHE_BREAK_MARKER: "###CACHE_BREAK###",
}));

vi.mock("../messaging/confirmation-verbs.js", () => ({
  buildConfirmRegex: vi.fn(() => /confirma/i),
}));

import { fastRunner } from "./fast-runner.js";
import { inferWithTools } from "../inference/adapter.js";
import { writeCheckpoint } from "./checkpoint.js";
import { recordFastRetryOutcome } from "../observability/prometheus.js";

const mockInferWithTools = vi.mocked(inferWithTools);
const mockWriteCheckpoint = vi.mocked(writeCheckpoint);
const mockRecordRetry = vi.mocked(recordFastRetryOutcome);

/** Default inferWithTools result shape — tests override fields they care about. */
function makeInferResult(
  overrides: Partial<{
    content: string;
    messages: ChatMessage[];
    totalUsage: { prompt_tokens: number; completion_tokens: number };
    toolRepairs: Array<{ original: string; repaired: string }>;
    exitReason: string;
    roundsCompleted: number;
    contextPressure: number;
    model: string;
  }> = {},
) {
  return {
    content: "STATUS: DONE\nReady.",
    messages: [] as ChatMessage[],
    totalUsage: { prompt_tokens: 1000, completion_tokens: 100 },
    toolRepairs: [] as Array<{ original: string; repaired: string }>,
    exitReason: "done",
    roundsCompleted: 1,
    contextPressure: 0.1,
    compactionApplied: undefined,
    model: "test-model",
    ...overrides,
  };
}

beforeEach(() => {
  // resetAllMocks (not just clearAllMocks) — also drops queued
  // `mockResolvedValueOnce` residuals so a test that forgets to queue its
  // own response can't consume leftover values from a prior test.
  vi.resetAllMocks();
});

describe("fastRunner.execute() — integration (R-4)", () => {
  // ────────────────────────────────────────────────────────────────────
  // Test A — happy path
  // ────────────────────────────────────────────────────────────────────
  describe("happy path", () => {
    it("returns DONE with output and toolCalls on a successful tool execution", async () => {
      const messagesA: ChatMessage[] = [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "file_read", arguments: "{}" },
            },
          ],
        },
        {
          role: "tool",
          content: '{"ok":true,"content":"hello"}',
          tool_call_id: "c1",
        },
      ];
      mockInferWithTools.mockResolvedValueOnce(
        makeInferResult({
          content: "STATUS: DONE\nLeído correctamente.",
          messages: messagesA,
        }),
      );

      const result = await fastRunner.execute({
        taskId: "task-A",
        runId: "run-A",
        title: "Lee el archivo",
        description: "Lee /tmp/x.txt",
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe("DONE");
      expect(result.toolCalls).toContain("file_read");
      expect(result.error).toBeUndefined();
      expect(mockInferWithTools).toHaveBeenCalledTimes(1);
      // No checkpoint when exit is clean
      expect(mockWriteCheckpoint).not.toHaveBeenCalled();
    });

    it("records actualModel from inferWithTools in tokenUsage", async () => {
      mockInferWithTools.mockResolvedValueOnce(
        makeInferResult({ model: "claude-sonnet-4-6" }),
      );

      const result = await fastRunner.execute({
        taskId: "task-A2",
        runId: "run-A2",
        title: "test",
        description: "test",
      });

      expect(result.tokenUsage?.actualModel).toBe("claude-sonnet-4-6");
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Test B — checkpoint on exhaustion
  // ────────────────────────────────────────────────────────────────────
  describe("checkpoint write on exhaustion", () => {
    it("calls writeCheckpoint when exitReason is max_rounds", async () => {
      mockInferWithTools.mockResolvedValueOnce(
        makeInferResult({
          content: "STATUS: BLOCKED\nNeed more rounds to finish.",
          exitReason: "max_rounds",
          roundsCompleted: 30,
          totalUsage: { prompt_tokens: 15_000, completion_tokens: 200 },
        }),
      );

      await fastRunner.execute({
        taskId: "task-B",
        runId: "run-B",
        title: "Long task",
        description: "Complex multi-step task",
      });

      expect(mockWriteCheckpoint).toHaveBeenCalledTimes(1);
      const checkpointArg = mockWriteCheckpoint.mock.calls[0][0];
      expect(checkpointArg.taskId).toBe("task-B");
      expect(checkpointArg.exitReason).toBe("max_rounds");
      expect(checkpointArg.roundsCompleted).toBe(30);
    });

    it("calls writeCheckpoint when exitReason is token_budget", async () => {
      mockInferWithTools.mockResolvedValueOnce(
        makeInferResult({
          content: "STATUS: BLOCKED\nBudget exhausted mid-task.",
          exitReason: "token_budget",
          roundsCompleted: 15,
          totalUsage: { prompt_tokens: 27_000, completion_tokens: 200 },
        }),
      );

      await fastRunner.execute({
        taskId: "task-B2",
        runId: "run-B2",
        title: "Heavy task",
        description: "Heavy task",
      });

      expect(mockWriteCheckpoint).toHaveBeenCalledTimes(1);
      expect(mockWriteCheckpoint.mock.calls[0][0].exitReason).toBe(
        "token_budget",
      );
    });

    it("does NOT call writeCheckpoint when exit is clean (done)", async () => {
      mockInferWithTools.mockResolvedValueOnce(
        makeInferResult({ exitReason: "done" }),
      );

      await fastRunner.execute({
        taskId: "task-B3",
        runId: "run-B3",
        title: "Quick task",
        description: "Quick task",
      });

      expect(mockWriteCheckpoint).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Test C — mechanical replacement when hallucination retry fails
  // ────────────────────────────────────────────────────────────────────
  describe("mechanical replacement honesty", () => {
    it("replaces LLM content with honest diagnostic when hallucination persists after retry, and records retry='fail'", async () => {
      // First call: hallucinated content (✅ + write claim with NO tools)
      // → triggers Layer 1 (full hallucination) in detectsHallucinatedExecution
      mockInferWithTools.mockResolvedValueOnce(
        makeInferResult({
          content: "✅ Escribí el archivo /tmp/x.txt exitosamente.",
          messages: [], // No tool_calls in messages → toolsCalled=[]
          totalUsage: { prompt_tokens: 1000, completion_tokens: 100 },
        }),
      );
      // Retry call: still hallucinates with no tools
      mockInferWithTools.mockResolvedValueOnce(
        makeInferResult({
          content: "✅ Hecho. Archivo escrito.",
          messages: [],
          totalUsage: { prompt_tokens: 1500, completion_tokens: 50 },
        }),
      );

      const result = await fastRunner.execute({
        taskId: "task-C",
        runId: "run-C",
        title: "Write a file",
        description: "Escribe 'hola' en /tmp/x.txt",
      });

      // DONE_WITH_CONCERNS still has success=true per the runner contract
      expect(result.status).toBe("DONE_WITH_CONCERNS");
      expect(result.concerns).toBeDefined();
      expect(result.concerns?.[0]).toMatch(
        /Hallucination detected|honest tool inventory/,
      );

      // Hallucinated content was REPLACED with honest diagnostic
      const text = (result.output as { text?: string }).text ?? "";
      expect(text).not.toContain("✅ Escribí el archivo");
      expect(text).not.toContain("✅ Hecho");
      expect(text).toMatch(/⚠️|No completé|herramientas/i);

      // Retry was attempted → counter incremented with "fail"
      expect(mockInferWithTools).toHaveBeenCalledTimes(2);
      expect(mockRecordRetry).toHaveBeenCalledWith("fail");
    });

    it("records retry='success' when retry produces a clean tool call", async () => {
      // First call: hallucinated content
      mockInferWithTools.mockResolvedValueOnce(
        makeInferResult({
          content: "✅ Escribí el archivo.",
          messages: [],
          totalUsage: { prompt_tokens: 1000, completion_tokens: 100 },
        }),
      );
      // Retry call: actually calls file_write
      const retryMessages: ChatMessage[] = [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c2",
              type: "function",
              function: { name: "file_write", arguments: "{}" },
            },
          ],
        },
        {
          role: "tool",
          content: '{"ok":true}',
          tool_call_id: "c2",
        },
      ];
      mockInferWithTools.mockResolvedValueOnce(
        makeInferResult({
          content: "STATUS: DONE\nWritten.",
          messages: retryMessages,
          totalUsage: { prompt_tokens: 1500, completion_tokens: 100 },
        }),
      );

      const result = await fastRunner.execute({
        taskId: "task-C2",
        runId: "run-C2",
        title: "Write a file",
        description: "Escribe 'hola' en /tmp/x.txt",
      });

      expect(mockInferWithTools).toHaveBeenCalledTimes(2);
      expect(mockRecordRetry).toHaveBeenCalledWith("success");
      // Audit W3: pin that mechanical replacement did NOT fire — DONE status
      // and no diagnostic markers in the output. Without this, the test would
      // pass even if the retry-succeeded branch and the mechanical-replacement
      // branch both fired (impossible today but a future refactor could).
      expect(result.status).toBe("DONE");
      const text = (result.output as { text?: string }).text ?? "";
      expect(text).not.toMatch(/⚠️|No completé/);
    });

    it("records retry='skipped' when no token headroom — retry is decided against, mechanical replacement fires without a retry attempt", async () => {
      // Hallucinated content + prompt_tokens above the HALLUCINATION_RETRY_HEADROOM
      // (0.85) threshold of the fast tokenBudget (28000) → 28000 * 0.85 = 23800.
      // Setting prompt_tokens = 25000 forces hasHeadroom=false → shouldRetry=false
      // → no retry attempted → mechanical replacement fires with "skipped" outcome.
      mockInferWithTools.mockResolvedValueOnce(
        makeInferResult({
          content: "✅ Escribí el archivo.",
          messages: [] as ChatMessage[],
          totalUsage: { prompt_tokens: 25000, completion_tokens: 100 },
        }),
      );

      const result = await fastRunner.execute({
        taskId: "task-C3",
        runId: "run-C3",
        title: "Write a file",
        description: "Escribe 'hola' en /tmp/x.txt",
      });

      // Retry NOT attempted — only the initial inferWithTools call
      expect(mockInferWithTools).toHaveBeenCalledTimes(1);
      // Mechanical replacement still fires (hallucinated content + no retry)
      expect(result.status).toBe("DONE_WITH_CONCERNS");
      expect(mockRecordRetry).toHaveBeenCalledWith("skipped");
    });
  });
});
