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
vi.mock("../inference/claude-sdk.js", () => ({
  queryClaudeSdk: vi.fn(),
}));

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
import { queryClaudeSdk } from "../inference/claude-sdk.js";
import { getConfig } from "../config.js";
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

// ────────────────────────────────────────────────────────────────────
// Phase 4.3 — auto-recovery before delivery (usability plan)
// ────────────────────────────────────────────────────────────────────
describe("Phase 4.3 auto-resume on max_rounds/token_budget", () => {
  it("resumes ONCE and delivers the completed second leg (no checkpoint)", async () => {
    mockInferWithTools.mockResolvedValueOnce(
      makeInferResult({
        content: "Voy a la mitad…",
        exitReason: "max_rounds",
        roundsCompleted: 12,
        totalUsage: { prompt_tokens: 10_000, completion_tokens: 500 },
      }),
    );
    mockInferWithTools.mockResolvedValueOnce(
      makeInferResult({
        content: "STATUS: DONE\nTerminado.",
        exitReason: "done",
        roundsCompleted: 3,
        totalUsage: { prompt_tokens: 4_000, completion_tokens: 200 },
      }),
    );

    const result = await fastRunner.execute({
      taskId: "task-resume",
      runId: "run-resume",
      title: "Tarea larga",
      description: "Haz una tarea larga con varios pasos",
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe("DONE");
    expect(mockInferWithTools).toHaveBeenCalledTimes(2);
    // The resume leg carries the continuation nudge as its last message.
    const resumeMessages = mockInferWithTools.mock.calls[1][0];
    const lastMsg = resumeMessages[resumeMessages.length - 1];
    expect(lastMsg.role).toBe("user");
    expect(String(lastMsg.content)).toContain("CONTINÚA AUTOMÁTICO");
    // Usage sums both legs.
    expect(result.tokenUsage?.promptTokens).toBe(14_000);
    expect(result.tokenUsage?.completionTokens).toBe(700);
    // Completed second leg → no checkpoint, no ¿Sigo?
    expect(mockWriteCheckpoint).not.toHaveBeenCalled();
    expect(result.output?.text).not.toContain("¿Sigo?");
  });

  it("double cap: delivers partial + ¿Sigo? and writes ONE checkpoint with summed rounds", async () => {
    mockInferWithTools.mockResolvedValueOnce(
      makeInferResult({
        content: "Parte 1…",
        exitReason: "max_rounds",
        roundsCompleted: 12,
      }),
    );
    mockInferWithTools.mockResolvedValueOnce(
      makeInferResult({
        content: "Parte 2, sigo sin terminar…",
        exitReason: "max_rounds",
        roundsCompleted: 12,
      }),
    );

    const result = await fastRunner.execute({
      taskId: "task-double-cap",
      runId: "run-double-cap",
      title: "Tarea interminable",
      description: "Haz una tarea muy larga",
    });

    expect(mockInferWithTools).toHaveBeenCalledTimes(2);
    expect(result.output?.text).toContain("¿Sigo?");
    expect(mockWriteCheckpoint).toHaveBeenCalledTimes(1);
    const cp = mockWriteCheckpoint.mock.calls[0][0];
    expect(cp.exitReason).toBe("max_rounds");
    expect(cp.roundsCompleted).toBe(24);
  });

  it("a failed resume leg still delivers the first-leg partial", async () => {
    mockInferWithTools.mockResolvedValueOnce(
      makeInferResult({
        content: "Avance parcial real.",
        exitReason: "token_budget",
        roundsCompleted: 8,
      }),
    );
    mockInferWithTools.mockRejectedValueOnce(new Error("provider down"));

    const result = await fastRunner.execute({
      taskId: "task-resume-fail",
      runId: "run-resume-fail",
      title: "Tarea",
      description: "Haz algo largo",
    });

    expect(result.output?.text).toContain("Avance parcial real.");
    expect(mockWriteCheckpoint).toHaveBeenCalledTimes(1);
  });
});

describe("Phase 4.3 auth-failure retry", () => {
  it("retries once on a 401-class failure and delivers the clean second leg", async () => {
    mockInferWithTools.mockResolvedValueOnce(
      makeInferResult({
        content:
          "[error_during_execution — API Error: 401 authentication_error: OAuth token has expired]",
        exitReason: "provider_failure",
      }),
    );
    mockInferWithTools.mockResolvedValueOnce(
      makeInferResult({ content: "STATUS: DONE\nListo." }),
    );

    const result = await fastRunner.execute({
      taskId: "task-auth",
      runId: "run-auth",
      title: "Tarea",
      description: "Haz algo",
    });

    expect(mockInferWithTools).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    expect(result.output?.text).not.toContain("401");
  });

  it("still-failing auth escalates in Spanish — never delivers the raw 401", async () => {
    const authFail = makeInferResult({
      content:
        "[error_during_execution — API Error: 401 authentication_error: OAuth token has been revoked]",
      exitReason: "provider_failure",
    });
    mockInferWithTools.mockResolvedValueOnce(authFail);
    mockInferWithTools.mockResolvedValueOnce(authFail);

    const result = await fastRunner.execute({
      taskId: "task-auth-2",
      runId: "run-auth-2",
      title: "Tarea",
      description: "Haz algo",
    });

    expect(mockInferWithTools).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("DONE_WITH_CONCERNS");
    expect(result.output?.text).toContain("rotar el token");
    expect(result.output?.text).not.toContain("authentication_error");
  });
});

// ────────────────────────────────────────────────────────────────────
// Phase 4.3 on the PRODUCTION (claude-sdk) path — R1 audit C1: the first
// cut only existed on the openai branch. These tests run the real SDK
// branch (getConfig → claude-sdk) with only queryClaudeSdk itself mocked.
// ────────────────────────────────────────────────────────────────────
const mockQuerySdk = vi.mocked(queryClaudeSdk);
const mockGetConfig = vi.mocked(getConfig);

const SDK_CONFIG = {
  inferencePrimaryProvider: "claude-sdk",
  inferencePrimaryUrl: "http://localhost:9999",
  inferencePrimaryKey: "test-key",
  inferencePrimaryModel: "test-model",
  inferenceContextLimit: 200_000,
  compressionThreshold: 0.85,
  inferenceTimeoutMs: 30_000,
  inferenceMaxTokens: 4096,
  inferenceMaxRetries: 3,
} as ReturnType<typeof getConfig>;

function makeSdkResult(
  overrides: Partial<{
    text: string;
    toolCalls: string[];
    numTurns: number;
    usage: {
      promptTokens: number;
      completionTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
    };
    costUsd: number;
  }> = {},
) {
  return {
    text: "STATUS: DONE\nListo.",
    toolCalls: [] as string[],
    numTurns: 3,
    usage: {
      promptTokens: 1000,
      completionTokens: 100,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    model: "claude-sonnet-4-6",
    costUsd: 0.01,
    costAuthoritative: true,
    durationMs: 500,
    ...overrides,
  };
}

describe("Phase 4.3 recovery on the claude-sdk path (R1 C1)", () => {
  beforeEach(() => {
    mockGetConfig.mockReturnValue(SDK_CONFIG);
  });

  it("auto-resumes ONCE after a cap marker and delivers the finished second leg", async () => {
    mockQuerySdk.mockResolvedValueOnce(
      makeSdkResult({
        text: "[error_max_turns — max turns reached] Parte 1 del análisis…\n\nSTATUS: DONE_WITH_CONCERNS — SDK reported error_max_turns; content above is partial and the task did not formally complete.",
        toolCalls: ["shell_exec"],
        numTurns: 24,
        usage: {
          promptTokens: 10_000,
          completionTokens: 400,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      }),
    );
    mockQuerySdk.mockResolvedValueOnce(
      makeSdkResult({
        text: "STATUS: DONE\nAnálisis terminado.",
        toolCalls: ["jarvis_file_write"],
        numTurns: 5,
        usage: {
          promptTokens: 4_000,
          completionTokens: 150,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      }),
    );

    const result = await fastRunner.execute({
      taskId: "sdk-resume",
      runId: "run-sdk-resume",
      title: "Analiza el corpus",
      description: "Analiza el corpus completo y guarda el reporte",
    });

    expect(mockQuerySdk).toHaveBeenCalledTimes(2);
    const resumeArgs = mockQuerySdk.mock.calls[1][0];
    expect(resumeArgs.prompt).toContain("CONTINÚA AUTOMÁTICO");
    expect(resumeArgs.prompt).toContain("Parte 1 del análisis");
    // R2 audit C2: the resume prompt NAMES the tools that already ran.
    expect(resumeArgs.prompt).toContain("Herramientas YA ejecutadas");
    expect(resumeArgs.prompt).toContain("shell_exec");
    // W4: the resume leg is bounded to half the rounds.
    expect(resumeArgs.maxTurns).toBeLessThan(24);
    expect(result.success).toBe(true);
    expect(result.status).toBe("DONE");
    // Usage sums both legs; tool calls union both legs.
    expect(result.tokenUsage?.promptTokens).toBe(14_000);
    expect(result.toolCalls).toEqual(
      expect.arrayContaining(["shell_exec", "jarvis_file_write"]),
    );
    expect(mockWriteCheckpoint).not.toHaveBeenCalled();
  });

  it("double cap → partial + ¿Sigo? + a checkpoint on the SDK path", async () => {
    const capped = (part: string) =>
      makeSdkResult({
        text: `[error_max_turns — max turns reached] ${part}\n\nSTATUS: DONE_WITH_CONCERNS — partial.`,
        numTurns: 24,
      });
    mockQuerySdk.mockResolvedValueOnce(capped("Parte 1…"));
    mockQuerySdk.mockResolvedValueOnce(capped("Parte 2…"));

    const result = await fastRunner.execute({
      taskId: "sdk-double-cap",
      runId: "run-sdk-double-cap",
      title: "Tarea interminable",
      description: "Haz la tarea interminable",
    });

    expect(mockQuerySdk).toHaveBeenCalledTimes(2);
    expect(result.output?.text).toContain("¿Sigo?");
    expect(mockWriteCheckpoint).toHaveBeenCalledTimes(1);
    expect(mockWriteCheckpoint.mock.calls[0][0].roundsCompleted).toBe(48);
  });

  it("a BLOCKED confirmation prompt WITHOUT a cap marker never triggers a resume", async () => {
    mockQuerySdk.mockResolvedValueOnce(
      makeSdkResult({
        text: "STATUS: BLOCKED\n¿Confirmas que borre los 3 archivos del KB? Esta acción es destructiva y necesito tu confirmación explícita antes de proceder con la eliminación.",
      }),
    );
    await fastRunner.execute({
      taskId: "sdk-blocked",
      runId: "run-sdk-blocked",
      title: "Borra archivos",
      description: "Borra los archivos viejos",
    });
    expect(mockQuerySdk).toHaveBeenCalledTimes(1);
  });

  it("auth-class failure retries once and delivers the clean second leg", async () => {
    mockQuerySdk.mockResolvedValueOnce(
      makeSdkResult({
        text: "[error_during_execution — API Error: 401 authentication_error: OAuth token has expired]\n\nSTATUS: BLOCKED — provider error.",
      }),
    );
    mockQuerySdk.mockResolvedValueOnce(
      makeSdkResult({ text: "STATUS: DONE\nListo." }),
    );
    const result = await fastRunner.execute({
      taskId: "sdk-auth",
      runId: "run-sdk-auth",
      title: "Tarea",
      description: "Haz algo",
    });
    expect(mockQuerySdk).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    expect(result.output?.text).not.toContain("401");
  });

  it("still-failing auth escalates in Spanish, never the raw 401", async () => {
    const authFail = () =>
      makeSdkResult({
        text: "[error_during_execution — API Error: 401 authentication_error: OAuth token has been revoked]\n\nSTATUS: BLOCKED — provider error.",
      });
    mockQuerySdk.mockResolvedValueOnce(authFail());
    mockQuerySdk.mockResolvedValueOnce(authFail());
    const result = await fastRunner.execute({
      taskId: "sdk-auth-2",
      runId: "run-sdk-auth-2",
      title: "Tarea",
      description: "Haz algo",
    });
    expect(mockQuerySdk).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("DONE_WITH_CONCERNS");
    expect(result.output?.text).toContain("rotar el token");
    expect(result.output?.text).not.toContain("authentication_error");
  });

  it("R2 C2: leg-1's streamed work survives when leg-2 returns only a thin closer", async () => {
    const longBody = "Análisis del corpus: " + "hallazgo relevante. ".repeat(20);
    mockQuerySdk.mockResolvedValueOnce(
      makeSdkResult({
        text: `[error_max_turns — max turns reached] Partial response below — turn/budget limit hit before completion.\n\n${longBody}\n\nSTATUS: DONE_WITH_CONCERNS — SDK reported error_max_turns; content above is partial and the task did not formally complete.`,
        numTurns: 24,
      }),
    );
    mockQuerySdk.mockResolvedValueOnce(
      makeSdkResult({ text: "Listo.\n\nSTATUS: DONE" }),
    );
    const result = await fastRunner.execute({
      taskId: "sdk-thin-closer",
      runId: "run-sdk-thin-closer",
      title: "Analiza",
      description: "Analiza el corpus",
    });
    expect(result.output?.text).toContain("hallazgo relevante");
  });

  it("R2 W4: a [timeout leg does NOT auto-resume (router already abandoned the reply)", async () => {
    mockQuerySdk.mockResolvedValueOnce(
      makeSdkResult({
        text: "[timeout after 900000ms — partial output preserved]\nAvance…",
      }),
    );
    await fastRunner.execute({
      taskId: "sdk-timeout",
      runId: "run-sdk-timeout",
      title: "Tarea",
      description: "Haz algo largo",
    });
    expect(mockQuerySdk).toHaveBeenCalledTimes(1);
  });

  it("a task ABOUT a 401 (no SDK error marker) keeps its content — no retry, no escalation", async () => {
    mockQuerySdk.mockResolvedValueOnce(
      makeSdkResult({
        text: "Tu API devuelve 401 porque el header Authorization va vacío — revisa el token del cliente.\n\nSTATUS: DONE",
      }),
    );
    const result = await fastRunner.execute({
      taskId: "sdk-about-401",
      runId: "run-sdk-about-401",
      title: "Debug API",
      description: "Explica por qué mi API devuelve 401",
    });
    expect(mockQuerySdk).toHaveBeenCalledTimes(1);
    expect(result.output?.text).toContain("Authorization");
  });
});

describe("R4 audit W1 — a thrown resume still counts as THE recovery leg", () => {
  beforeEach(() => {
    mockGetConfig.mockReturnValue(SDK_CONFIG);
  });

  it("cap + resume-throw + 401-in-partial fires exactly 2 legs, never 3", async () => {
    mockQuerySdk.mockResolvedValueOnce(
      makeSdkResult({
        text: "[error_max_turns — API Error: 401 authentication_error mid-run] Parte 1…\n\nSTATUS: DONE_WITH_CONCERNS — partial.",
        numTurns: 24,
      }),
    );
    mockQuerySdk.mockRejectedValueOnce(new Error("provider down"));
    // If the auth gate re-fired, a third queued value would be consumed:
    mockQuerySdk.mockResolvedValueOnce(
      makeSdkResult({ text: "STATUS: DONE\nno debería ejecutarse" }),
    );

    const result = await fastRunner.execute({
      taskId: "sdk-three-leg",
      runId: "run-sdk-three-leg",
      title: "Tarea",
      description: "Haz algo largo",
    });

    expect(mockQuerySdk).toHaveBeenCalledTimes(2);
    expect(result.output?.text).toContain("Parte 1");
  });
});
