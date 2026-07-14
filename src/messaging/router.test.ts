/**
 * Router unit tests.
 * Mocks submitTask and event bus to test inbound/outbound message flow.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Shared subscribers array — cleared in beforeEach
const subscribers: Array<{
  pattern: string;
  handler: (event: any) => void;
}> = [];

// Mock dependencies before importing router
vi.mock("../dispatch/dispatcher.js", () => ({
  submitTask: vi.fn().mockResolvedValue({
    taskId: "test-task-123",
    agentType: "fast",
    classification: { score: 1, reason: "test", explicit: false },
  }),
}));

vi.mock("../lib/event-bus.js", () => ({
  getEventBus: () => ({
    subscribe: vi.fn((pattern: string, handler: (event: any) => void) => {
      subscribers.push({ pattern, handler });
      return { id: "sub-1", pattern, unsubscribe: vi.fn() };
    }),
  }),
}));

// Outcome-aware retain coverage (queue item #7 part 1):
// spy on memory.retain so failed/cancelled-task tests can verify the
// outcome:failed retain call lands.
// S2 audit fix (2026-05-07): no importActual — router only consumes
// getMemoryService(); other exports stay stubbed so a memory/index.ts
// refactor can't surface as a misleading router test failure.
const memoryRetainSpy = vi.fn().mockResolvedValue(undefined);
vi.mock("../memory/index.js", () => ({
  getMemoryService: () => ({
    retain: memoryRetainSpy,
    recall: vi.fn().mockResolvedValue({ memories: [] }),
  }),
  initMemoryService: vi.fn().mockResolvedValue(undefined),
  resetMemoryService: vi.fn(),
}));

vi.mock("../memory/outcome-tag.js", () => ({
  getOutcomeTag: vi.fn((_taskId: string) => "outcome:failed"),
  statusToOutcomeTag: vi.fn(() => "outcome:failed"),
}));

// Round-2 sweep audit: stub the DB-status read used by the cancel
// short-circuit in handleTaskCompleted/Failed. Default returns undefined
// (legacy path); tests can override to return {status:"cancelled"}.
const dbStatusGet = vi.fn().mockReturnValue(undefined);
vi.mock("./community-reply-gate.js", () => ({
  gateCommunityReply: vi.fn(),
  COMMUNITY_REPLY_FALLBACK: "FALLBACK_TEXT_FOR_TEST",
}));

vi.mock("../observability/prometheus.js", () => ({
  recordCommunityGateVerdict: vi.fn(),
}));

// 2026-07-11 briefing-verdict intercept: mock the resolver + pending-brief
// lookup so inbound specs can steer interception without real briefing rows.
// NOTE (qa-audit W3): specs queue with *Once, but a short-circuited check can
// leave a Once UNCONSUMED and clearAllMocks does not drain the queue — the
// intercept describe block mockReset()s both in beforeEach AND afterEach.
const briefingMocks = vi.hoisted(() => ({
  getResolvablePendingBriefing: vi.fn().mockReturnValue(null),
  resolveBriefingOnOperatorReply: vi.fn().mockResolvedValue(null),
}));
vi.mock("../briefing/storage.js", () => ({
  getResolvablePendingBriefing: briefingMocks.getResolvablePendingBriefing,
}));
vi.mock("../briefing/promote.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../briefing/promote.js")>();
  return {
    ...actual, // classifyOperatorVerdict stays REAL (pure; behavior owned by promote.test.ts)
    resolveBriefingOnOperatorReply:
      briefingMocks.resolveBriefingOnOperatorReply,
  };
});

const mockWriteEpisodic = vi.fn().mockResolvedValue(undefined);
vi.mock("../memory/jme.js", () => ({
  writeEpisodic: (...args: unknown[]) => mockWriteEpisodic(...args),
  queryMemory: vi.fn().mockResolvedValue([]),
}));

vi.mock("../db/index.js", () => ({
  getDatabase: () => ({
    prepare: () => ({ get: dbStatusGet }),
  }),
}));

import {
  MessageRouter,
  threadKey,
  isOwnerChannel,
  isPoisonedExchange,
} from "./router.js";
import { submitTask } from "../dispatch/dispatcher.js";
import type {
  ChannelAdapter,
  IncomingMessage,
  OutgoingMessage,
} from "./types.js";

function createMockAdapter(name: "whatsapp" | "telegram"): ChannelAdapter & {
  sentMessages: OutgoingMessage[];
  messageHandler: ((msg: IncomingMessage) => void) | null;
} {
  const adapter = {
    name,
    sentMessages: [] as OutgoingMessage[],
    messageHandler: null as ((msg: IncomingMessage) => void) | null,
    start: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockImplementation(async (msg: OutgoingMessage) => {
      adapter.sentMessages.push(msg);
      return "msg-id-1";
    }),
    onMessage: vi
      .fn()
      .mockImplementation((handler: (msg: IncomingMessage) => void) => {
        adapter.messageHandler = handler;
      }),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  return adapter;
}

/** Get the last subscriber matching a pattern (most recent startEventListeners call). */
function findHandler(pattern: string) {
  // Iterate backwards to find the most recent handler for this pattern
  for (let i = subscribers.length - 1; i >= 0; i--) {
    if (subscribers[i].pattern === pattern) return subscribers[i].handler;
  }
  return undefined;
}

describe("MessageRouter", () => {
  let router: MessageRouter;
  let waAdapter: ReturnType<typeof createMockAdapter>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    subscribers.length = 0;

    // Set env vars for owner addresses
    process.env.WHATSAPP_OWNER_JID = "owner@s.whatsapp.net";
    process.env.TELEGRAM_OWNER_CHAT_ID = "12345";

    router = new MessageRouter();
    waAdapter = createMockAdapter("whatsapp");
    router.registerChannel(waAdapter);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.WHATSAPP_OWNER_JID;
    delete process.env.TELEGRAM_OWNER_CHAT_ID;
  });

  describe("inbound", () => {
    it("should call submitTask with correct shape", async () => {
      const msg: IncomingMessage = {
        channel: "whatsapp",
        from: "owner@s.whatsapp.net",
        text: "Cómo van mis tareas?",
        timestamp: new Date(),
      };

      await router.handleInbound(msg);

      expect(submitTask).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Chat: Cómo van mis tareas?",
          tags: ["messaging", "whatsapp"],
          agentType: "auto",
        }),
      );
    });

    it("should truncate long message titles at 60 chars", async () => {
      const longText = "A".repeat(100);
      const msg: IncomingMessage = {
        channel: "whatsapp",
        from: "owner@s.whatsapp.net",
        text: longText,
        timestamp: new Date(),
      };

      await router.handleInbound(msg);

      expect(submitTask).toHaveBeenCalledWith(
        expect.objectContaining({
          title: `Chat: ${"A".repeat(60)}...`,
        }),
      );
    });

    it("should include core tools for a generic message (dynamic scoping)", async () => {
      const msg: IncomingMessage = {
        channel: "whatsapp",
        from: "owner@s.whatsapp.net",
        text: "hola, qué tal",
        timestamp: new Date(),
      };

      await router.handleInbound(msg);

      const call = (submitTask as any).mock.calls[0][0];
      // Core tools always present
      expect(call.tools).toContain("user_fact_set");
      expect(call.tools).toContain("user_fact_list");
      expect(call.tools).toContain("web_search");
      expect(call.tools).toContain("web_read");
      expect(call.tools).toContain("skill_list");
      // Jarvis file READ tools always-on (NorthStar visions live here)
      expect(call.tools).toContain("jarvis_file_read");
      expect(call.tools).toContain("jarvis_file_list");
      // 2026-04-14 → 2026-05-07: Write tools were scope-gated (jarvis_write
      // group) to prevent memory-recalled SOPs from driving silent tool calls
      // (task 2378). After 3+ weeks of recurring friction on KB writes, the
      // gate was reverted per operator directive — write tools are now in
      // MISC_TOOLS (always-on). Rumi-class mitigation moved to tool-
      // description, confirmation-gate, and system-prompt layers. See
      // feedback_jarvis_writes_always_on.md.
      expect(call.tools).toContain("jarvis_file_write");
      expect(call.tools).toContain("jarvis_file_update");
      // Misc core still always present
      expect(call.tools).toContain("list_schedules");
      // Niche tools no longer always-on
      expect(call.tools).not.toContain("http_fetch");
      // Specialty tools keyword-gated
      expect(call.tools).not.toContain("chart_generate");
      // Lightpanda: only goto + markdown always present
      expect(call.tools).toContain("browser__goto");
      expect(call.tools).toContain("browser__markdown");
      expect(call.tools).not.toContain("browser__click");
      // Playwright NOT present for generic greetings (scope-gated)
      expect(call.tools).not.toContain("playwright__browser_navigate");
      // exa_search always present
      expect(call.tools).toContain("exa_search");
      // Should NOT include heavy groups for a simple greeting
      expect(call.tools).not.toContain("shell_exec");
      expect(call.tools).not.toContain("gmail_send");
    });

    it("should activate coding tools when keywords present", async () => {
      const msg: IncomingMessage = {
        channel: "whatsapp",
        from: "owner@s.whatsapp.net",
        text: "crea una tarea para hacer deploy del servidor",
        timestamp: new Date(),
      };

      await router.handleInbound(msg);

      const call = (submitTask as any).mock.calls[0][0];
      // Coding tools activated by "deploy" and "servidor"
      expect(call.tools).toContain("shell_exec");
      expect(call.tools).toContain("file_read");
      expect(call.tools).toContain("grep");
    });

    it("should include Jarvis persona in description and user message in conversationHistory", async () => {
      const msg: IncomingMessage = {
        channel: "whatsapp",
        from: "owner@s.whatsapp.net",
        text: "Hola",
        timestamp: new Date(),
      };

      await router.handleInbound(msg);

      const call = (submitTask as any).mock.calls[0][0];
      expect(call.description).toContain("Jarvis");
      // User message is now the last turn in conversationHistory, not in description
      expect(call.conversationHistory).toBeDefined();
      const lastTurn =
        call.conversationHistory[call.conversationHistory.length - 1];
      // Efficiency audit: a time-context preamble is prepended to the final
      // user turn so the system prompt stays static and Anthropic prompt
      // caching can hit. The original user text is preserved after the
      // preamble line.
      expect(lastTurn.role).toBe("user");
      expect(lastTurn.content).toMatch(/^\[Hoy: /);
      expect(lastTurn.content).toContain("CDMX]");
      expect(lastTurn.content).toContain("Hola");
    });
  });

  describe("briefing verdict intercept (2026-07-11)", () => {
    const owner = (text: string): IncomingMessage => ({
      channel: "whatsapp",
      from: "owner@s.whatsapp.net",
      text,
      timestamp: new Date(),
    });

    // qa-audit W3: a short-circuited check (e.g. interrogative text never
    // reaches getResolvablePendingBriefing) leaves queued *Once values
    // unconsumed, and clearAllMocks does NOT drain them — reset around every
    // spec so nothing leaks in either direction.
    const resetBriefingMocks = () => {
      briefingMocks.getResolvablePendingBriefing.mockReset();
      briefingMocks.getResolvablePendingBriefing.mockReturnValue(null);
      briefingMocks.resolveBriefingOnOperatorReply.mockReset();
      briefingMocks.resolveBriefingOnOperatorReply.mockResolvedValue(null);
    };
    beforeEach(resetBriefingMocks);
    afterEach(resetBriefingMocks);

    it("a bare verdict with a pending brief is acked deterministically and NEVER dispatched as a chat task", async () => {
      briefingMocks.getResolvablePendingBriefing.mockReturnValueOnce({
        briefingId: "b1",
      });
      briefingMocks.resolveBriefingOnOperatorReply.mockResolvedValueOnce({
        briefingId: "b1",
        surface: "morning",
        resolution: "promoted",
        reply: "✓ Brief conservado.",
      });

      await router.handleInbound(owner("Sirve"));

      expect(waAdapter.sentMessages).toHaveLength(1);
      expect(waAdapter.sentMessages[0].text).toBe("✓ Brief conservado.");
      expect(submitTask).not.toHaveBeenCalled();
    });

    it("an expired brief gets an explicit too-late note, not silence", async () => {
      briefingMocks.getResolvablePendingBriefing.mockReturnValueOnce({
        briefingId: "b1",
      });
      briefingMocks.resolveBriefingOnOperatorReply.mockResolvedValueOnce({
        briefingId: "b1",
        surface: "morning",
        resolution: "expired",
      });

      await router.handleInbound(owner("sirve"));

      expect(waAdapter.sentMessages).toHaveLength(1);
      expect(waAdapter.sentMessages[0].text).toContain("expirado");
      expect(submitTask).not.toHaveBeenCalled();
    });

    it("a bare verdict with NO pending brief flows to the normal chat pipeline", async () => {
      await router.handleInbound(owner("sirve"));

      expect(submitTask).toHaveBeenCalled();
      // fire-and-forget resolver still ran (expiry sweep / pushback path)
      expect(briefingMocks.resolveBriefingOnOperatorReply).toHaveBeenCalledWith(
        "sirve",
        expect.anything(),
      );
    });

    it("an IMPERATIVE verdict ('descártalo') resolves fire-and-forget but is NOT swallowed (qa-audit W1)", async () => {
      // "archívalo"/"descártalo" can be instructions about prior context
      // ("archive that email"), not rulings on the brief — the instruction
      // must still reach the chat pipeline.
      briefingMocks.getResolvablePendingBriefing.mockReturnValueOnce({
        briefingId: "b1",
      });
      briefingMocks.resolveBriefingOnOperatorReply.mockResolvedValueOnce({
        briefingId: "b1",
        surface: "morning",
        resolution: "discarded",
        reply: "🗑️ Brief descartado.",
      });

      await router.handleInbound(owner("descártalo"));

      expect(submitTask).toHaveBeenCalled();
      expect(briefingMocks.resolveBriefingOnOperatorReply).toHaveBeenCalledWith(
        "descártalo",
        expect.anything(),
      );
    });

    it("a non-verdict message with a pending brief is NOT intercepted", async () => {
      briefingMocks.getResolvablePendingBriefing.mockReturnValueOnce({
        briefingId: "b1",
      });

      await router.handleInbound(owner("Cómo van mis tareas?"));

      expect(submitTask).toHaveBeenCalled();
    });

    it("a resolver race (null result despite pending brief) falls through to dispatch", async () => {
      briefingMocks.getResolvablePendingBriefing.mockReturnValueOnce({
        briefingId: "b1",
      });
      briefingMocks.resolveBriefingOnOperatorReply.mockResolvedValueOnce(null);

      await router.handleInbound(owner("sirve"));

      // The normal pipeline sends its own inbound ack; the point is that NO
      // verdict ack was fabricated for a brief we didn't actually resolve.
      for (const m of waAdapter.sentMessages) {
        expect(m.text).not.toContain("Brief");
      }
      expect(submitTask).toHaveBeenCalled();
    });
  });

  describe("outbound", () => {
    it("should send result on task.completed event", async () => {
      const msg: IncomingMessage = {
        channel: "whatsapp",
        from: "owner@s.whatsapp.net",
        text: "test",
        timestamp: new Date(),
      };
      await router.handleInbound(msg);

      router.startEventListeners();

      const completedHandler = findHandler("task.completed");
      expect(completedHandler).toBeDefined();

      completedHandler!({
        data: {
          task_id: "test-task-123",
          agent_id: "fast",
          result: "Aquí están tus tareas...",
          duration_ms: 500,
        },
      });

      // [0] = ack, [1] = result
      expect(waAdapter.sentMessages).toHaveLength(2);
      expect(waAdapter.sentMessages[0].text).toContain("Recibido");
      expect(waAdapter.sentMessages[1].text).toBe("Aquí están tus tareas...");
      expect(waAdapter.sentMessages[1].to).toBe("owner@s.whatsapp.net");
    });

    it("sends a fallback ack when a chat task completes with EMPTY text (2026-07-11)", async () => {
      // The model can answer a contentless ack ("sirve") with a bare
      // "STATUS: DONE" → parseRunnerStatus strips it → output.text === "".
      // extractResultText returns null and the old code dropped the reply
      // entirely — timers already cleared, operator got total silence.
      const msg: IncomingMessage = {
        channel: "whatsapp",
        from: "owner@s.whatsapp.net",
        text: "test",
        timestamp: new Date(),
      };
      await router.handleInbound(msg);
      router.startEventListeners();

      const completedHandler = findHandler("task.completed");
      completedHandler!({
        data: {
          task_id: "test-task-123",
          agent_id: "fast",
          result: { text: "", toolCalls: [] },
          duration_ms: 500,
        },
      });

      // [0] = inbound ack, [1] = fallback
      expect(waAdapter.sentMessages).toHaveLength(2);
      expect(waAdapter.sentMessages[1].text).toBe("✓");
      expect(waAdapter.sentMessages[1].to).toBe("owner@s.whatsapp.net");
    });

    it("delivers a swarm {content} object result as prose, not raw JSON (2026-06-20)", async () => {
      // task.completed carries result.output as an OBJECT (the event bus is
      // in-process, by reference — dispatcher.ts:639). swarm aggregates to
      // { content, score, learnings, goalSummary } with NO `.text`, so the object
      // branch of extractResultText must surface `.content` — else the chat user
      // gets raw JSON. Guards the production delivery path for fan-out → swarm.
      const msg: IncomingMessage = {
        channel: "whatsapp",
        from: "owner@s.whatsapp.net",
        text: "crea un archivo por cada prospecto",
        timestamp: new Date(),
      };
      await router.handleInbound(msg);
      router.startEventListeners();

      const completedHandler = findHandler("task.completed");
      completedHandler!({
        data: {
          task_id: "test-task-123",
          agent_id: "swarm",
          result: {
            content: "Listo — creé 3 archivos, uno por prospecto.",
            score: 1,
            learnings: ["fan-out mapped cleanly"],
            goalSummary: { completed: 3 },
          },
          duration_ms: 1200,
        },
      });

      expect(waAdapter.sentMessages[1].text).toBe(
        "Listo — creé 3 archivos, uno por prospecto.",
      );
      expect(waAdapter.sentMessages[1].text).not.toContain("goalSummary");
    });

    it("delivers heavy finalAnswer, not the reflector meta-summary (2026-07-11)", async () => {
      // heavy-runner output carries BOTH `content` (reflector's meta-summary
      // ABOUT the work) and `finalAnswer` (the agent's actual report). The
      // Azteca chat sent the operator "Single-goal chat task completed
      // successfully: ..." while the real commentary sat in finalAnswer.
      const msg: IncomingMessage = {
        channel: "whatsapp",
        from: "owner@s.whatsapp.net",
        text: "Comentario sobre el concurso mercantil",
        timestamp: new Date(),
      };
      await router.handleInbound(msg);
      router.startEventListeners();

      const completedHandler = findHandler("task.completed");
      completedHandler!({
        data: {
          task_id: "test-task-123",
          agent_id: "heavy",
          result: {
            content:
              "Single-goal chat task completed successfully: delivered commentary.",
            score: 0.95,
            learnings: ["chat-only tasks need no tools"],
            finalAnswer: "Fede, tu lectura del concurso es la correcta.",
          },
          duration_ms: 1200,
        },
      });

      expect(waAdapter.sentMessages[1].text).toBe(
        "Fede, tu lectura del concurso es la correcta.",
      );
    });

    it("falls back to content when heavy finalAnswer is null/empty", async () => {
      const msg: IncomingMessage = {
        channel: "whatsapp",
        from: "owner@s.whatsapp.net",
        text: "test",
        timestamp: new Date(),
      };
      await router.handleInbound(msg);
      router.startEventListeners();

      const completedHandler = findHandler("task.completed");
      completedHandler!({
        data: {
          task_id: "test-task-123",
          agent_id: "heavy",
          result: {
            content: "Reflector summary as last resort.",
            score: 0.8,
            learnings: [],
            finalAnswer: null,
          },
          duration_ms: 800,
        },
      });

      expect(waAdapter.sentMessages[1].text).toBe(
        "Reflector summary as last resort.",
      );
    });

    it("delivers the runner's clarifying question on needs_context, not the generic failure (2026-07-11)", async () => {
      // "?" → model answered "No hay pregunta en tu mensaje. ¿Qué necesitas?"
      // (47 chars, under the >100 promotion threshold) → NEEDS_CONTEXT →
      // task.failed. The old handler dropped the question and sent
      // "No pude completar eso".
      memoryRetainSpy.mockClear();
      dbStatusGet.mockReturnValue({
        spawn_type: "root",
        title: "Chat: ?",
        status: "needs_context",
      });
      try {
        const msg: IncomingMessage = {
          channel: "whatsapp",
          from: "owner@s.whatsapp.net",
          text: "?",
          timestamp: new Date(),
        };
        await router.handleInbound(msg);
        router.startEventListeners();

        const failedHandler = findHandler("task.failed");
        failedHandler!({
          data: {
            task_id: "test-task-123",
            agent_id: "fast",
            error: "Unknown error",
            recoverable: false,
            attempts: 1,
            result: {
              text: "No hay pregunta en tu mensaje. ¿Qué necesitas?",
              toolCalls: [],
            },
          },
        });

        expect(waAdapter.sentMessages[1].text).toBe(
          "No hay pregunta en tu mensaje. ¿Qué necesitas?",
        );
        // The retained exchange records what the operator SAW, not
        // "[Task failed] Unknown error".
        const [exchange] = memoryRetainSpy.mock.calls[0];
        expect(exchange).toContain(
          "Jarvis: No hay pregunta en tu mensaje. ¿Qué necesitas?",
        );
        expect(exchange).not.toContain("[Task failed]");
      } finally {
        dbStatusGet.mockReturnValue(undefined);
      }
    });

    it("keeps the generic failure message on needs_context when the runner produced NO text", async () => {
      dbStatusGet.mockReturnValue({
        spawn_type: "root",
        title: "Chat: x",
        status: "needs_context",
      });
      try {
        const msg: IncomingMessage = {
          channel: "whatsapp",
          from: "owner@s.whatsapp.net",
          text: "x",
          timestamp: new Date(),
        };
        await router.handleInbound(msg);
        router.startEventListeners();

        const failedHandler = findHandler("task.failed");
        failedHandler!({
          data: {
            task_id: "test-task-123",
            agent_id: "fast",
            error: "Unknown error",
            recoverable: false,
            attempts: 1,
            result: { text: "", toolCalls: [] },
          },
        });

        expect(waAdapter.sentMessages[1].text).toContain(
          "No pude completar eso",
        );
      } finally {
        dbStatusGet.mockReturnValue(undefined);
      }
    });

    it("never sends raw JSON on needs_context when the result has no text field (qa-audit W1)", async () => {
      dbStatusGet.mockReturnValue({
        spawn_type: "root",
        title: "Chat: x",
        status: "blocked",
      });
      try {
        const msg: IncomingMessage = {
          channel: "whatsapp",
          from: "owner@s.whatsapp.net",
          text: "x",
          timestamp: new Date(),
        };
        await router.handleInbound(msg);
        router.startEventListeners();

        const failedHandler = findHandler("task.failed");
        failedHandler!({
          data: {
            task_id: "test-task-123",
            agent_id: "fast",
            error: "Unknown error",
            recoverable: false,
            attempts: 1,
            // No text-bearing key — extractResultText would JSON.stringify this
            result: { toolCalls: ["shell"], score: 0 },
          },
        });

        expect(waAdapter.sentMessages[1].text).toContain(
          "No pude completar eso",
        );
        expect(waAdapter.sentMessages[1].text).not.toContain("toolCalls");
      } finally {
        dbStatusGet.mockReturnValue(undefined);
      }
    });

    it("should send error message on task.failed event", async () => {
      const msg: IncomingMessage = {
        channel: "whatsapp",
        from: "owner@s.whatsapp.net",
        text: "test",
        timestamp: new Date(),
      };
      await router.handleInbound(msg);

      router.startEventListeners();

      const failedHandler = findHandler("task.failed");
      expect(failedHandler).toBeDefined();

      failedHandler!({
        data: {
          task_id: "test-task-123",
          agent_id: "fast",
          error: "Something went wrong",
          recoverable: false,
          attempts: 1,
        },
      });

      // [0] = ack, [1] = failure notice
      expect(waAdapter.sentMessages).toHaveLength(2);
      expect(waAdapter.sentMessages[1].text).toContain("No pude completar eso");
    });

    it("should retain conversation with outcome:failed tag on task.failed", async () => {
      memoryRetainSpy.mockClear();

      const msg: IncomingMessage = {
        channel: "whatsapp",
        from: "owner@s.whatsapp.net",
        text: "what went wrong yesterday",
        timestamp: new Date(),
      };
      await router.handleInbound(msg);
      router.startEventListeners();

      const failedHandler = findHandler("task.failed");
      failedHandler!({
        data: {
          task_id: "test-task-123",
          agent_id: "fast",
          error: "DB connection lost",
          recoverable: false,
          attempts: 1,
        },
      });

      expect(memoryRetainSpy).toHaveBeenCalledOnce();
      const [exchange, opts] = memoryRetainSpy.mock.calls[0];
      expect(exchange).toContain("User: what went wrong yesterday");
      expect(exchange).toContain("[Task failed] DB connection lost");
      expect(opts.bank).toBe("mc-jarvis");
      expect(opts.tags).toContain("outcome:failed");
      expect(opts.tags).toContain("whatsapp");
      expect(opts.async).toBe(true);
    });

    it("handleTaskCompleted short-circuits when status is cancelled (round-2 audit C1)", async () => {
      memoryRetainSpy.mockClear();

      const msg: IncomingMessage = {
        channel: "whatsapp",
        from: "owner@s.whatsapp.net",
        text: "long-running query",
        timestamp: new Date(),
      };
      await router.handleInbound(msg);
      router.startEventListeners();

      // Set the DB stub AFTER inbound handling so unrelated DB lookups during
      // submitTask classification don't consume the mock. The short-circuit
      // is the next `.get()` call after this point.
      dbStatusGet.mockReturnValue({ status: "cancelled" });

      const completedHandler = findHandler("task.completed");
      completedHandler!({
        data: {
          task_id: "test-task-123",
          agent_id: "fast",
          result: "Aquí está el resultado tardío...",
          duration_ms: 60000,
        },
      });

      // Only the inbound ack should have been sent — no result message
      // (the short-circuit returns before sendToChannel).
      expect(waAdapter.sentMessages).toHaveLength(1);
      expect(waAdapter.sentMessages[0].text).toContain("Recibido");
      // No retain on the short-circuit path (handleTaskCancelled handles it).
      expect(memoryRetainSpy).not.toHaveBeenCalled();
      // Reset for subsequent tests
      dbStatusGet.mockReturnValue(undefined);
    });

    it("should retain conversation with outcome:failed tag on task.cancelled", async () => {
      memoryRetainSpy.mockClear();

      const msg: IncomingMessage = {
        channel: "whatsapp",
        from: "owner@s.whatsapp.net",
        text: "run the long task",
        timestamp: new Date(),
      };
      await router.handleInbound(msg);
      router.startEventListeners();

      const cancelledHandler = findHandler("task.cancelled");
      expect(cancelledHandler).toBeDefined();

      cancelledHandler!({
        data: {
          task_id: "test-task-123",
          cancelled_by: "operator",
          reason: "user-requested",
        },
      });

      expect(memoryRetainSpy).toHaveBeenCalledOnce();
      const [exchange, opts] = memoryRetainSpy.mock.calls[0];
      expect(exchange).toContain("User: run the long task");
      expect(exchange).toContain("[Task cancelled by operator] user-requested");
      expect(opts.bank).toBe("mc-jarvis");
      expect(opts.tags).toContain("outcome:failed");
    });

    describe("JME operator filter (writeEpisodic)", () => {
      const OWNER_ID = "12345";

      beforeEach(() => {
        mockWriteEpisodic.mockClear();
        process.env.TELEGRAM_OWNER_CHAT_ID = OWNER_ID;
      });

      afterEach(() => {
        delete process.env.TELEGRAM_OWNER_CHAT_ID;
      });

      it("calls writeEpisodic when channel=telegram and to=OWNER_ID", async () => {
        const msg: IncomingMessage = {
          channel: "telegram",
          from: OWNER_ID,
          text: "hola",
          timestamp: new Date(),
        };
        await router.handleInbound(msg);
        router.startEventListeners();

        const completedHandler = findHandler("task.completed");
        completedHandler!({
          data: {
            task_id: "test-jme-1",
            agent_id: "fast",
            result: "Respuesta",
            duration_ms: 100,
          },
        });

        // Fire-and-forget — flush microtasks
        await new Promise((r) => setTimeout(r, 0));

        expect(mockWriteEpisodic).toHaveBeenCalled();
        const calls = mockWriteEpisodic.mock.calls;
        const roles = calls.map((c: unknown[]) => (c[0] as { role: string }).role);
        expect(roles).toContain("user");
        expect(roles).toContain("jarvis");
      });

      it("does NOT call writeEpisodic for non-operator channels (whatsapp)", async () => {
        const msg: IncomingMessage = {
          channel: "whatsapp",
          from: "someone@s.whatsapp.net",
          text: "hola",
          timestamp: new Date(),
        };
        await router.handleInbound(msg);
        router.startEventListeners();

        const completedHandler = findHandler("task.completed");
        completedHandler!({
          data: {
            task_id: "test-jme-2",
            agent_id: "fast",
            result: "Respuesta",
            duration_ms: 100,
          },
        });

        await new Promise((r) => setTimeout(r, 0));

        expect(mockWriteEpisodic).not.toHaveBeenCalled();
      });

      it("does NOT call writeEpisodic for telegram from a different chat (not owner)", async () => {
        const msg: IncomingMessage = {
          channel: "telegram",
          from: "99999", // different from OWNER_ID
          text: "hola",
          timestamp: new Date(),
        };
        await router.handleInbound(msg);
        router.startEventListeners();

        const completedHandler = findHandler("task.completed");
        completedHandler!({
          data: {
            task_id: "test-jme-3",
            agent_id: "fast",
            result: "Respuesta",
            duration_ms: 100,
          },
        });

        await new Promise((r) => setTimeout(r, 0));

        expect(mockWriteEpisodic).not.toHaveBeenCalled();
      });
    });
  });

  describe("timeout", () => {
    it("should send interim message after 120s", async () => {
      const msg: IncomingMessage = {
        channel: "whatsapp",
        from: "owner@s.whatsapp.net",
        text: "test",
        timestamp: new Date(),
      };
      await router.handleInbound(msg);

      vi.advanceTimersByTime(120_001);

      // [0] = ack, [1] = interim
      expect(waAdapter.sentMessages).toHaveLength(2);
      expect(waAdapter.sentMessages[1].text).toContain(
        "Sigo trabajando en eso",
      );
    });

    it("should send extended warning after 300s (keeps pending entry)", async () => {
      const msg: IncomingMessage = {
        channel: "whatsapp",
        from: "owner@s.whatsapp.net",
        text: "test",
        timestamp: new Date(),
      };
      await router.handleInbound(msg);

      vi.advanceTimersByTime(300_001);

      // [0] = ack, [1] = interim (120s), [2] = warning (300s, no longer abandons)
      expect(waAdapter.sentMessages).toHaveLength(3);
      expect(waAdapter.sentMessages[2].text).toContain(
        "tomando más de lo esperado",
      );
    });
  });

  describe("broadcast", () => {
    it("should send to all registered channels", async () => {
      const tgAdapter = createMockAdapter("telegram");
      router.registerChannel(tgAdapter);

      await router.broadcastToAll("Ritual result text");

      expect(waAdapter.sentMessages).toHaveLength(1);
      expect(waAdapter.sentMessages[0].text).toBe("Ritual result text");
      expect(tgAdapter.sentMessages).toHaveLength(1);
      expect(tgAdapter.sentMessages[0].text).toBe("Ritual result text");
    });
  });

  describe("ritual watch", () => {
    it("should broadcast on ritual task completion", () => {
      router.watchRitualTask("ritual-task-1", "morning-briefing");
      router.startEventListeners();

      const completedHandler = findHandler("task.completed");
      expect(completedHandler).toBeDefined();

      completedHandler!({
        data: {
          task_id: "ritual-task-1",
          agent_id: "heavy",
          result: "Buenos días, Fede...",
          duration_ms: 5000,
        },
      });

      expect(waAdapter.sentMessages).toHaveLength(1);
      expect(waAdapter.sentMessages[0].text).toBe("Buenos días, Fede...");
    });

    // 2026-07-13 operator request: skill-evolution's full report arrived as
    // 5 Telegram chunks — digest rituals broadcast the reflector summary +
    // a mc-ctl pointer instead of the multi-chunk artifact.
    it("broadcasts a digest (not the full report) for digest rituals", () => {
      router.watchRitualTask("evo-task-1", "skill-evolution");
      router.startEventListeners();

      const completedHandler = findHandler("task.completed");
      completedHandler!({
        data: {
          task_id: "evo-task-1",
          agent_id: "heavy",
          result: {
            content: "Resumen corto de la corrida de evolución.",
            finalAnswer: "# EVOLUTION REPORT\n" + "x".repeat(15000),
          },
          duration_ms: 5000,
        },
      });

      expect(waAdapter.sentMessages).toHaveLength(1);
      const text = waAdapter.sentMessages[0].text;
      expect(text).toContain("Resumen corto de la corrida de evolución.");
      expect(text).toContain("mc-ctl task evo-task-1");
      expect(text).not.toContain("xxxx");
    });

    it("non-digest rituals still broadcast the full deliverable", () => {
      router.watchRitualTask("brief-task-1", "morning-briefing");
      router.startEventListeners();

      const completedHandler = findHandler("task.completed");
      const full = {
        content: "meta-resumen",
        finalAnswer: "Buenos días — informe completo del briefing.",
      };
      completedHandler!({
        data: {
          task_id: "brief-task-1",
          agent_id: "heavy",
          result: full,
          duration_ms: 5000,
        },
      });

      expect(waAdapter.sentMessages).toHaveLength(1);
      expect(waAdapter.sentMessages[0].text).toBe(
        "Buenos días — informe completo del briefing.",
      );
    });
  });

  describe("buildRitualDigest", () => {
    it("prefers result.content and appends the task pointer", async () => {
      const { buildRitualDigest } = await import("./router.js");
      const out = buildRitualDigest(
        "abc-123",
        { content: "Resumen.", finalAnswer: "reporte largo" },
        "reporte largo",
      );
      expect(out).toBe("Resumen.\n\n📄 Reporte completo: mc-ctl task abc-123");
    });

    it("falls back to the full text when content is absent or empty", async () => {
      const { buildRitualDigest } = await import("./router.js");
      expect(buildRitualDigest("t1", { content: "  " }, "cuerpo")).toContain(
        "cuerpo",
      );
      expect(buildRitualDigest("t1", "string result", "cuerpo")).toContain(
        "cuerpo",
      );
    });

    it("truncates bodies longer than the digest cap", async () => {
      const { buildRitualDigest } = await import("./router.js");
      const out = buildRitualDigest("t1", { content: "y".repeat(5000) }, "z");
      expect(out.length).toBeLessThan(1400);
      expect(out).toContain("…");
      expect(out).toContain("mc-ctl task t1");
    });
  });

  describe("no reply for unknown task", () => {
    it("should not send anything for untracked task_id", () => {
      router.startEventListeners();

      const completedHandler = findHandler("task.completed");
      expect(completedHandler).toBeDefined();

      completedHandler!({
        data: {
          task_id: "unknown-task-999",
          agent_id: "fast",
          result: "Some result",
          duration_ms: 100,
        },
      });

      expect(waAdapter.sentMessages).toHaveLength(0);
    });
  });

  // v8 S1 — cache-break marker handling
  describe("stripCacheMarker", () => {
    it("replaces marker with single newline when present", async () => {
      const { stripCacheMarker, CACHE_BREAK_MARKER } =
        await import("./router.js");
      const input = `STABLE${CACHE_BREAK_MARKER}VARIABLE`;
      expect(stripCacheMarker(input)).toBe("STABLE\nVARIABLE");
    });

    it("returns input unchanged when marker absent (fast path)", async () => {
      const { stripCacheMarker } = await import("./router.js");
      const input = "no marker here";
      // Same reference when no marker (no allocation)
      expect(stripCacheMarker(input)).toBe(input);
    });

    it("strips only the first occurrence (defensive)", async () => {
      const { stripCacheMarker, CACHE_BREAK_MARKER } =
        await import("./router.js");
      const input = `A${CACHE_BREAK_MARKER}B${CACHE_BREAK_MARKER}C`;
      // String.replace with literal arg replaces first match only.
      // Second marker survives — guards against malformed inputs without
      // silently coalescing them into one giant blob.
      const result = stripCacheMarker(input);
      expect(result).toContain("A\nB");
      expect(result).toContain(CACHE_BREAK_MARKER);
    });
  });

  // v8 2026-04-26 — three-way scope decision (semantic / inherited / regex).
  // Source: vlcms-continuation incident where "Continúa" follow-ups landed in
  // `google` scope (regex FP) instead of inheriting prior `coding`. Bug class:
  // empty-Set from semantic classifier was collapsed with null/undefined.
  describe("decideActiveGroups", () => {
    it("uses semantic groups when classifier returned non-empty", async () => {
      const { decideActiveGroups } = await import("./router.js");
      const semantic = new Set(["coding"]);
      const prior = new Set(["google"]);
      const fallback = vi.fn(() => new Set(["wordpress"]));
      const result = decideActiveGroups(semantic, prior, fallback);
      expect(result.source).toBe("semantic");
      expect([...result.groups]).toEqual(["coding"]);
      expect(fallback).not.toHaveBeenCalled();
    });

    it("inherits prior scope when classifier returned explicit empty Set", async () => {
      const { decideActiveGroups } = await import("./router.js");
      // The "Continúa" case: classifier returns [] per its short-follow-up rule
      const semantic = new Set<string>();
      const prior = new Set(["coding"]);
      const fallback = vi.fn(() => new Set(["google"])); // wrong-scope FP, must NOT fire
      const result = decideActiveGroups(semantic, prior, fallback);
      expect(result.source).toBe("inherited");
      expect([...result.groups]).toEqual(["coding"]);
      expect(fallback).not.toHaveBeenCalled();
      // Defensive: returned set is a copy (mutating it must not affect caller's prior)
      result.groups.add("destructive");
      expect([...prior]).toEqual(["coding"]);
    });

    it("falls back to regex when classifier returned null (failure/timeout)", async () => {
      const { decideActiveGroups } = await import("./router.js");
      const prior = new Set(["coding"]);
      const fallback = vi.fn(() => new Set(["google"]));
      const result = decideActiveGroups(null, prior, fallback);
      expect(result.source).toBe("regex");
      expect([...result.groups]).toEqual(["google"]);
      expect(fallback).toHaveBeenCalledOnce();
    });

    it("falls back to regex when classifier returned empty AND no prior (cold start)", async () => {
      const { decideActiveGroups } = await import("./router.js");
      const semantic = new Set<string>();
      const fallback = vi.fn(() => new Set(["google"]));
      const result = decideActiveGroups(semantic, undefined, fallback);
      // Distinct source ("regex_empty") preserves the diagnostic signal that the
      // classifier was reachable and explicit, vs an outright failure.
      expect(result.source).toBe("regex_empty");
      expect([...result.groups]).toEqual(["google"]);
      expect(fallback).toHaveBeenCalledOnce();
    });

    it("falls back to regex when classifier returned empty AND prior is empty Set", async () => {
      // Edge: prior exists but is itself empty (e.g., prior turn was a greeting
      // that resolved to no scope). Don't inherit nothing — re-derive via regex.
      const { decideActiveGroups } = await import("./router.js");
      const semantic = new Set<string>();
      const prior = new Set<string>();
      const fallback = vi.fn(() => new Set(["northstar_read"]));
      const result = decideActiveGroups(semantic, prior, fallback);
      expect(result.source).toBe("regex_empty");
      expect([...result.groups]).toEqual(["northstar_read"]);
    });

    it("treats undefined classifier result as null (not empty)", async () => {
      const { decideActiveGroups } = await import("./router.js");
      const fallback = vi.fn(() => new Set(["coding"]));
      const result = decideActiveGroups(
        undefined,
        new Set(["google"]),
        fallback,
      );
      // undefined is "didn't classify" → regex fallback (NOT inheritance);
      // inheritance only fires on the explicit-empty signal.
      expect(result.source).toBe("regex");
      expect(fallback).toHaveBeenCalledOnce();
    });

    it("does NOT inherit on conversational topic-closers (gracias, ok, listo)", async () => {
      // qa-audit W2: prior turn was coding, current message is a pure
      // greeting/ack. Inheriting coding scope would load CODING_TOOLS for a
      // reply that should stay core-only. CONVERSATIONAL_PATTERN protects.
      const { decideActiveGroups } = await import("./router.js");
      const fallback = vi.fn(() => new Set<string>());
      for (const greeting of ["gracias", "ok", "listo", "perfecto"]) {
        const result = decideActiveGroups(
          new Set<string>(),
          new Set(["coding"]),
          fallback,
          greeting,
        );
        expect(result.source).toBe("regex_empty");
        expect([...result.groups]).toEqual([]);
      }
      // Sanity: a non-conversational short follow-up DOES inherit.
      const fallback2 = vi.fn(() => new Set(["google"]));
      const result = decideActiveGroups(
        new Set<string>(),
        new Set(["coding"]),
        fallback2,
        "Continúa",
      );
      expect(result.source).toBe("inherited");
      expect([...result.groups]).toEqual(["coding"]);
    });
  });

  describe("threadKey", () => {
    // Pinned because the audit caught this as a Critical: collapsing every
    // sender to one community-manager mailbox into a single thread key
    // bleeds Sender A's conversationHistory + scope-inheritance bag + DB
    // hydration query results into Sender B's next turn.

    it("keeps channel-only key for owner-only email (backward-compat)", () => {
      expect(
        threadKey(
          "email:comunidades",
          "alice@example.com",
          undefined,
          "owner-only",
        ),
      ).toBe("email:comunidades");
    });

    it("isolates per sender for community-manager email", () => {
      const a = threadKey(
        "email:comunidades",
        "alice@example.com",
        undefined,
        "community-manager",
      );
      const b = threadKey(
        "email:comunidades",
        "bob@example.com",
        undefined,
        "community-manager",
      );
      expect(a).toBe("email:comunidades:alice@example.com");
      expect(b).toBe("email:comunidades:bob@example.com");
      expect(a).not.toBe(b);
    });

    it("lowercases the sender so case variants share one key", () => {
      const a = threadKey(
        "email:comunidades",
        "Alice@Example.COM",
        undefined,
        "community-manager",
      );
      const b = threadKey(
        "email:comunidades",
        "alice@example.com",
        undefined,
        "community-manager",
      );
      expect(a).toBe("email:comunidades:alice@example.com");
      expect(a).toBe(b);
    });

    it("falls back to channel-only when community-manager mode lacks a from", () => {
      // Defensive — should not happen in practice (every IncomingMessage from
      // the email adapter carries `from`), but if it did we collapse to one
      // mailbox-wide thread rather than crashing.
      expect(
        threadKey(
          "email:comunidades",
          undefined,
          undefined,
          "community-manager",
        ),
      ).toBe("email:comunidades");
    });

    it("WhatsApp group keying is unchanged by the email mode parameter", () => {
      expect(threadKey("whatsapp", "group@g.us", "sender@s.whatsapp.net")).toBe(
        "whatsapp:group@g.us:sender@s.whatsapp.net",
      );
    });

    it("Telegram channel-only key is unchanged", () => {
      expect(threadKey("telegram", "12345")).toBe("telegram");
    });
  });

  describe("isOwnerChannel", () => {
    // Gate for operator-private prompt content (the self-defining cohort).
    // Fail-safe: owner status must be POSITIVELY established — an ambiguous
    // email channel must NOT count as owner, or private data leaks publicly.

    it("treats non-email channels as owner (WhatsApp, Telegram)", () => {
      expect(isOwnerChannel("whatsapp", undefined)).toBe(true);
      expect(isOwnerChannel("telegram", undefined)).toBe(true);
    });

    it("treats owner-only email as owner", () => {
      expect(isOwnerChannel("email:comunidades", "owner-only")).toBe(true);
    });

    it("treats community-manager email as NOT owner (public)", () => {
      expect(isOwnerChannel("email:comunidades", "community-manager")).toBe(
        false,
      );
    });

    it("treats email with undefined mode as NOT owner (default-deny)", () => {
      expect(isOwnerChannel("email:comunidades", undefined)).toBe(false);
      expect(isOwnerChannel("email", undefined)).toBe(false);
    });
  });

  describe("isPoisonedExchange — confabulated permission-block refusals", () => {
    // 2026-06-16: gmail_send / mcp__supabase__query are in scope AND
    // auto-approved under permissionMode:"dontAsk", but the LLM sometimes
    // invents a "blocked by don't-ask policy" gate and refuses. These must be
    // stripped from the thread buffer so the excuse can't reinforce/recur.
    it("flags the 'gmail bloqueado en modo don't ask' confabulation", () => {
      expect(
        isPoisonedExchange(
          "El tool de Gmail está bloqueado en esta sesión (modo 'don't ask').",
        ),
      ).toBe(true);
    });

    it("flags the supabase 'bloqueado por la política don't ask mode' variant", () => {
      expect(
        isPoisonedExchange(
          "El tool mcp__supabase__query fue bloqueado por la política 'don't ask mode' en esta sesión.",
        ),
      ).toBe(true);
    });

    it("flags the 'correo bloqueado en esta sesión' refusal", () => {
      expect(
        isPoisonedExchange(
          "Lo siento, el correo está bloqueado en esta sesión y no puedo enviarlo.",
        ),
      ).toBe(true);
    });

    it("flags 'requiere confirmación del sistema' framing", () => {
      expect(
        isPoisonedExchange(
          "No puedo mandarlo porque gmail_send requiere confirmación del sistema.",
        ),
      ).toBe(true);
    });

    // Negative cases — the patterns are anchored on the FALSE permission-gate
    // framing, NOT on bare "X está bloqueado", which legitimately reports a real
    // external block we must keep in context (qa-auditor 2026-06-16 FP classes).
    it("does NOT flag a legitimate 'el número está bloqueado' status", () => {
      expect(
        isPoisonedExchange(
          "El número del cliente está bloqueado en WhatsApp, no podemos contactarlo.",
        ),
      ).toBe(false);
    });

    it("does NOT flag a real external-block report (rate-limit / Cloudflare / provider)", () => {
      expect(
        isPoisonedExchange(
          "La herramienta de WhatsApp está bloqueada por rate-limit; reintento en 1h.",
        ),
      ).toBe(false);
      expect(
        isPoisonedExchange(
          "El tool fue bloqueado por Cloudflare al hacer el scrape.",
        ),
      ).toBe(false);
      expect(
        isPoisonedExchange(
          "Gmail tiene la cuenta bloqueada por actividad sospechosa del proveedor.",
        ),
      ).toBe(false);
    });

    it("does NOT flag generic 'modo' / 'permiso' prose (not a permission gate)", () => {
      expect(
        isPoisonedExchange("Cambié el modo de contacto del cliente a correo."),
      ).toBe(false);
      expect(
        isPoisonedExchange(
          "Necesitas permiso del dueño del CRM para ese cambio.",
        ),
      ).toBe(false);
    });

    it("does NOT flag a normal successful-send report", () => {
      expect(
        isPoisonedExchange(
          "Enviado ✅ a javier@eurekamd.net con el análisis completo de 3B.",
        ),
      ).toBe(false);
    });

    // 2026-06-17 FP fix — unanchored self-error patterns stripped legitimate
    // answers, which read to the operator as Jarvis "forgetting" its own reply.
    it("does NOT flag an external 'por error de configuración' description", () => {
      // Real stripped answer (06-17): Jarvis describing the USER's broker mix-up.
      expect(
        isPoisonedExchange(
          "El enredo de las 8:59 fue el broker ejecutando el stop adjunto como buy stop por error de configuración — ya lo corregiste colocando la orden independiente.",
        ),
      ).toBe(false);
    });

    it("does NOT flag a mid-sentence 'problema técnico grave' description", () => {
      expect(
        isPoisonedExchange(
          "El cliente reportó que el sistema del banco tuvo un problema técnico grave durante la transferencia.",
        ),
      ).toBe(false);
    });

    it("still flags a sentence-initial self-reported 'Error de configuración'", () => {
      // Anchoring keeps the true positive: a self-excuse at sentence start.
      expect(
        isPoisonedExchange(
          "Error de configuración: el sistema no arranca y no completé la tarea.",
        ),
      ).toBe(true);
    });

    it("does NOT flag a bare incidental English 'don't ask'", () => {
      expect(
        isPoisonedExchange(
          "Listo, lo hice directo — you said don't ask, so I didn't bug you about it.",
        ),
      ).toBe(false);
    });

    it("still flags a '(don't ask mode activo)' confabulation without 'bloqueado'", () => {
      // Real stripped answer (06-17): the gate signature with no `bloqueado`.
      expect(
        isPoisonedExchange(
          "Preparé el correo, pero hay un don't ask mode activo, así que necesito que lo envíes tú.",
        ),
      ).toBe(true);
    });
  });
});

// ===========================================================================
// v7.7 Spine 1 Phase 2b — sendLLMReplyToChannel write-gate integration
// ===========================================================================

describe("MessageRouter — community-reply write-gate (v7.7 Phase 2b)", () => {
  let router: MessageRouter;

  // Minimal email adapter mock — typed as ChannelAdapter & extras. The
  // production EmailChannel sets `mode: "owner-only" | "community-manager"`
  // per-account; we control it directly here to exercise each branch.
  function createEmailAdapter(
    name: string,
    mode: "owner-only" | "community-manager" | undefined,
  ) {
    const sent: OutgoingMessage[] = [];
    return {
      name,
      mode,
      sentMessages: sent,
      start: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockImplementation(async (msg: OutgoingMessage) => {
        sent.push(msg);
        return "id";
      }),
      onMessage: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
      isConnected: () => true,
    };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    subscribers.length = 0;
    router = new MessageRouter();

    // Reset the gate mock to default-pass before each test
    const { gateCommunityReply } = await import("./community-reply-gate.js");
    vi.mocked(gateCommunityReply).mockResolvedValue({
      verdict: "pass",
      critique: "",
      latencyMs: 5,
      error: false,
    });
  });

  it("community-manager email: pass verdict → original text shipped", async () => {
    const adapter = createEmailAdapter(
      "email:comunidades",
      "community-manager",
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    router.registerChannel(adapter as any);
    const { gateCommunityReply } = await import("./community-reply-gate.js");
    vi.mocked(gateCommunityReply).mockResolvedValueOnce({
      verdict: "pass",
      critique: "",
      latencyMs: 5,
      error: false,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (router as any).sendLLMReplyToChannel(
      "email:comunidades",
      "alice@example.com",
      "Hola, gracias por escribirnos.",
    );
    // Drain microtasks AND any in-flight gate IIFEs
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await Promise.allSettled([...(router as any).gateInflight]);

    expect(adapter.sentMessages.length).toBe(1);
    expect(adapter.sentMessages[0].text).toBe("Hola, gracias por escribirnos.");
    expect(vi.mocked(gateCommunityReply)).toHaveBeenCalledOnce();
  });

  it("community-manager email: fail verdict → FALLBACK shipped, NOT the original", async () => {
    const adapter = createEmailAdapter(
      "email:comunidades",
      "community-manager",
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    router.registerChannel(adapter as any);
    const { gateCommunityReply } = await import("./community-reply-gate.js");
    vi.mocked(gateCommunityReply).mockResolvedValueOnce({
      verdict: "fail",
      critique: "cites specific date without source",
      latencyMs: 10,
      error: false,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (router as any).sendLLMReplyToChannel(
      "email:comunidades",
      "alice@example.com",
      "Nuestro próximo evento es el 15 de junio.",
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await Promise.allSettled([...(router as any).gateInflight]);

    expect(adapter.sentMessages.length).toBe(1);
    expect(adapter.sentMessages[0].text).toBe("FALLBACK_TEXT_FOR_TEST");
    expect(adapter.sentMessages[0].text).not.toContain("15 de junio");
  });

  it("community-manager email: infra error → FALLBACK shipped (fail-safe)", async () => {
    const adapter = createEmailAdapter(
      "email:comunidades",
      "community-manager",
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    router.registerChannel(adapter as any);
    const { gateCommunityReply } = await import("./community-reply-gate.js");
    vi.mocked(gateCommunityReply).mockResolvedValueOnce({
      verdict: "fail",
      critique: "critic call failed: upstream 503",
      latencyMs: 100,
      error: true,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (router as any).sendLLMReplyToChannel(
      "email:comunidades",
      "alice@example.com",
      "anything",
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await Promise.allSettled([...(router as any).gateInflight]);

    expect(adapter.sentMessages[0].text).toBe("FALLBACK_TEXT_FOR_TEST");
  });

  it("owner-only email: gate NOT called → original shipped", async () => {
    const adapter = createEmailAdapter("email:fede", "owner-only");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    router.registerChannel(adapter as any);
    const { gateCommunityReply } = await import("./community-reply-gate.js");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (router as any).sendLLMReplyToChannel(
      "email:fede",
      "fede@example.com",
      "private reply to operator with sensitive data",
    );
    // Owner-only path is sync direct send; await one microtask
    await Promise.resolve();

    expect(adapter.sentMessages[0].text).toBe(
      "private reply to operator with sensitive data",
    );
    expect(vi.mocked(gateCommunityReply)).not.toHaveBeenCalled();
  });

  it("undefined mode on email channel: gate FIRES (fail-safe default-deny)", async () => {
    // Future regression: if a new email adapter is added without setting
    // mode, it must still get the gate. R1-W2 from Phase 2b audit.
    const adapter = createEmailAdapter("email:new", undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    router.registerChannel(adapter as any);
    const { gateCommunityReply } = await import("./community-reply-gate.js");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (router as any).sendLLMReplyToChannel("email:new", "x@example.com", "text");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await Promise.allSettled([...(router as any).gateInflight]);

    expect(vi.mocked(gateCommunityReply)).toHaveBeenCalledOnce();
  });

  it("non-email channel (whatsapp): gate NOT called", async () => {
    const wa = createMockAdapter("whatsapp");
    router.registerChannel(wa);
    const { gateCommunityReply } = await import("./community-reply-gate.js");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (router as any).sendLLMReplyToChannel(
      "whatsapp",
      "x@s.whatsapp.net",
      "hola",
    );
    await Promise.resolve();

    expect(wa.sentMessages[0].text).toBe("hola");
    expect(vi.mocked(gateCommunityReply)).not.toHaveBeenCalled();
  });

  it("stopAll() awaits in-flight gate IIFEs (R1-C1 regression guard)", async () => {
    const adapter = createEmailAdapter(
      "email:comunidades",
      "community-manager",
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    router.registerChannel(adapter as any);
    const { gateCommunityReply } = await import("./community-reply-gate.js");

    // Make the gate hang briefly so we can race shutdown against it
    let resolveGate: (v: {
      verdict: "pass";
      critique: string;
      latencyMs: number;
      error: false;
    }) => void = () => {};
    vi.mocked(gateCommunityReply).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveGate = resolve as never;
      }),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (router as any).sendLLMReplyToChannel(
      "email:comunidades",
      "x@example.com",
      "hola",
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((router as any).gateInflight.size).toBe(1);

    // Kick off stopAll WITHOUT awaiting the gate first
    const stopPromise = router.stopAll();
    // Now release the gate
    resolveGate({ verdict: "pass", critique: "", latencyMs: 5, error: false });
    await stopPromise;

    // Adapter MUST have received the send before stop completed
    expect(adapter.send).toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((router as any).gateInflight.size).toBe(0);
  });
});
