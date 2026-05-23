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

// Precedent: mock for the bytes-stable test (R-3) which exercises the
// chat path with conversationHistory.length > 1. Returns deterministic ""
// so any non-determinism elsewhere is the failure surface.
vi.mock("../messaging/precedent.js", () => ({
  buildPrecedentBlock: vi.fn(() => ""),
}));

// KB / essentials / precedent: skip injection in non-chat path. The chat
// path is gated by `input.conversationHistory` — tests omit it, so the
// non-chat path (simpler system + user message) is taken regardless of
// what these return.
vi.mock("../messaging/kb-injection.js", () => ({
  buildKnowledgeBaseSection: vi.fn(() => ""),
  // Audit W2: return the documented contract shape `{stable, variable}` rather
  // than a bare string. The R-3 discriminated union spreads this — empty
  // string would silently degrade to `{kind:"split"}` with no fields, bypassing
  // the stable/variable code paths the test should exercise.
  buildKnowledgeBaseSections: vi.fn(() => ({ stable: null, variable: null })),
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

  // ────────────────────────────────────────────────────────────────────
  // R-3 — bytes-stable prefix lint
  // ────────────────────────────────────────────────────────────────────
  describe("bytes-stable system prefix (R-3 lint)", () => {
    it("entire message array is byte-identical across N=5 runs with identical inputs, AND taskId does NOT leak into any message content", async () => {
      // Drives the CHAT path (conversationHistory.length=2 to exercise the
      // precedent path too — audit W4) and asserts:
      //
      //   (a) Every message in the array is byte-identical across runs.
      //       Audit W1: previously only checked messages[0] (effectively
      //       tautological given identical input.description). Now scans
      //       the full array — covers stable prefix + essentials + KB +
      //       precedent + deferred catalog + history. Surfaces any
      //       non-determinism in those builders (Date.now() / Map / Set
      //       iteration / hidden side-effects).
      //
      //   (b) taskId does NOT appear in any message content. Audit W5:
      //       taskId varies across runs (`task-stable-${i}`); it goes into
      //       logs and telemetry, NOT messages. Pins that boundary.

      const N = 5;
      const messageArrays: ChatMessage[][] = [];

      for (let i = 0; i < N; i++) {
        mockInferWithTools.mockResolvedValueOnce(
          makeInferResult({
            content: "STATUS: DONE\nready",
          }),
        );

        await fastRunner.execute({
          taskId: `task-stable-${i}`, // varies — must not leak into prompt
          runId: `run-stable-${i}`,
          title: "Test task",
          description: "Identity preamble###CACHE_BREAK###variable suffix",
          // length=2 → triggers `needsPrecedent` at fast-runner.ts:739
          // and exercises the precedent leg of the Promise.all
          conversationHistory: [
            { role: "user", content: "first turn" },
            { role: "user", content: "second turn" },
          ],
        });

        const messagesArg = mockInferWithTools.mock.calls[i]?.[0];
        if (!messagesArg) {
          throw new Error(`run ${i}: no messages captured`);
        }
        messageArrays.push(messagesArg);
      }

      // (a) Full-array byte equality
      const serialize = (arr: ChatMessage[]): string =>
        JSON.stringify(arr.map((m) => ({ role: m.role, content: m.content })));
      const serialized = messageArrays.map(serialize);
      const allEqual = serialized.every((s) => s === serialized[0]);

      if (!allEqual) {
        // Diagnostic: show which run diverges and at which message index
        const lengths = serialized.map((s) => s.length);
        const baseline = messageArrays[0];
        const drift = messageArrays
          .map((arr, runIdx) => {
            for (let msgIdx = 0; msgIdx < baseline.length; msgIdx++) {
              const baseContent = JSON.stringify(baseline[msgIdx]?.content);
              const thisContent = JSON.stringify(arr[msgIdx]?.content);
              if (baseContent !== thisContent) {
                return {
                  run: runIdx,
                  msgIdx,
                  baseRole: baseline[msgIdx]?.role,
                };
              }
            }
            return null;
          })
          .filter(Boolean);
        throw new Error(
          `Bytes-stable lint failed. Lengths per run: ${JSON.stringify(lengths)}. First drift per run: ${JSON.stringify(drift)}`,
        );
      }

      expect(allEqual).toBe(true);

      // (b) taskId leak check — substring scan of every string content
      for (let i = 0; i < N; i++) {
        const taskIdMarker = `task-stable-${i}`;
        for (const msg of messageArrays[i]) {
          if (typeof msg.content === "string") {
            expect(msg.content).not.toContain(taskIdMarker);
          }
        }
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // R-5 — pre-classified hallucination retry message
  // ────────────────────────────────────────────────────────────────────
  describe("hallucination retry message — per-class structure (R-5)", () => {
    // R-5 improvement: previously the retry message asked the LLM to classify
    // each error itself ("if the error is permanent, ..."). Now the runner
    // pre-classifies via classifyToolError() and tells the LLM EXACTLY which
    // tool to retry vs which to skip. Removes one source of LLM variance on
    // the retry. SCOPE: openai-compat path only (SDK path doesn't run retry
    // protocol — see R-1 audit W1).

    /** Build the assistant + tool messages that drive a hallucinated retry. */
    function buildHallucMessages(
      toolCalls: Array<{ id: string; name: string; errorMsg: string }>,
    ): ChatMessage[] {
      const msgs: ChatMessage[] = [
        {
          role: "assistant",
          content: null,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: "{}" },
          })),
        },
      ];
      for (const tc of toolCalls) {
        msgs.push({
          role: "tool",
          content: `{"error":"${tc.errorMsg}"}`,
          tool_call_id: tc.id,
        });
      }
      return msgs;
    }

    /** Capture the retry user message that was pushed for inferWithTools call #2. */
    function getRetryMessage(): string {
      const retryMessagesArg = mockInferWithTools.mock.calls[1]?.[0];
      if (!retryMessagesArg) {
        throw new Error("no retry call captured");
      }
      // Retry message is the LAST user message in the array (pushed after
      // filtering out trailing narration assistant).
      const last = retryMessagesArg[retryMessagesArg.length - 1];
      if (last.role !== "user" || typeof last.content !== "string") {
        throw new Error("last message is not a user-role string");
      }
      return last.content;
    }

    it("transient-only errors → retry message has ERRORES TRANSITORIOS section, NO PERMANENTES section", async () => {
      // First call: file_write fails with a transient error (timeout)
      mockInferWithTools.mockResolvedValueOnce(
        makeInferResult({
          content: "✅ Escribí el archivo.",
          messages: buildHallucMessages([
            { id: "c1", name: "file_write", errorMsg: "timeout after 30s" },
          ]),
        }),
      );
      // Retry: still claims success without calling tools — terminates path
      mockInferWithTools.mockResolvedValueOnce(
        makeInferResult({
          content: "✅ Hecho.",
          messages: [],
        }),
      );

      await fastRunner.execute({
        taskId: "task-R5-transient",
        runId: "run-R5-transient",
        title: "Write a file",
        description: "Escribe el archivo",
      });

      const retryMsg = getRetryMessage();
      expect(retryMsg).toContain("ERRORES TRANSITORIOS");
      expect(retryMsg).toContain("file_write");
      expect(retryMsg).toContain("timeout"); // error text propagated
      expect(retryMsg).toContain("TRANSITORIO");
      // Crucial: no PERMANENTES section when all errors are transient
      expect(retryMsg).not.toContain("ERRORES PERMANENTES");
      // Crucial: no "if the error is permanent ..." prose — pre-classification means
      // the runner asserts, doesn't ask
      expect(retryMsg).not.toContain("Si el error es permanente");
    });

    it("mixed errors (transient + permanent) → retry message has BOTH sections", async () => {
      // The runner only enters the retry block when shouldRetry=true, which
      // requires NOT all-permanent. Mixed (1 permanent + 1 transient) hits
      // the !allPermanent gate and triggers the retry.
      mockInferWithTools.mockResolvedValueOnce(
        makeInferResult({
          content: "✅ Escribí ambos archivos.",
          messages: buildHallucMessages([
            { id: "c1", name: "file_write", errorMsg: "timeout after 30s" },
            // "401 Unauthorized" → classifyToolError() → "permanent"
            {
              id: "c2",
              name: "shell_exec",
              errorMsg: "401 Unauthorized: token expired",
            },
          ]),
        }),
      );
      mockInferWithTools.mockResolvedValueOnce(
        makeInferResult({ content: "✅ Hecho.", messages: [] }),
      );

      await fastRunner.execute({
        taskId: "task-R5-mixed",
        runId: "run-R5-mixed",
        title: "Two ops",
        description: "Haz dos operaciones",
      });

      const retryMsg = getRetryMessage();
      // Both sections present
      expect(retryMsg).toContain("ERRORES PERMANENTES");
      expect(retryMsg).toContain("ERRORES TRANSITORIOS");
      // Each tool tagged with its classification
      expect(retryMsg).toMatch(/file_write.*TRANSITORIO/s);
      expect(retryMsg).toMatch(/shell_exec.*PERMANENTE/s);
      // No "you classify" prose
      expect(retryMsg).not.toContain("Si el error es permanente");
    });

    it("error text is truncated to 150 chars to prevent unbounded retry-message bloat", async () => {
      const longError = "TIMEOUT: " + "x".repeat(500);
      mockInferWithTools.mockResolvedValueOnce(
        makeInferResult({
          content: "✅ Escribí.",
          messages: buildHallucMessages([
            { id: "c1", name: "file_write", errorMsg: longError },
          ]),
        }),
      );
      mockInferWithTools.mockResolvedValueOnce(
        makeInferResult({ content: "✅ Hecho.", messages: [] }),
      );

      await fastRunner.execute({
        taskId: "task-R5-long",
        runId: "run-R5-long",
        title: "Write",
        description: "Escribe",
      });

      const retryMsg = getRetryMessage();
      // The truncation is at .slice(0, 150) per fast-runner.ts:1462. The
      // retry message should contain at most 150 chars of the error text
      // plus the classification suffix.
      expect(retryMsg).toContain("TIMEOUT");
      // Audit W1 fix: tight bind to the 150-char contract. The surviving
      // x-run after both truncations (200 at line 1302 → 150 at line 1469)
      // is ≤141 chars. Any cut looser than slice(0, 160) would have ≥151
      // x's and fail this assertion.
      expect(retryMsg).not.toContain("x".repeat(151));
    });
  });
});
