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
  cancelTask: vi.fn(() => true),
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
// Phase 4 / R5-W3: checkpoint module mocked so continuation tests control
// what findRecentCheckpoint returns without a live DB.
vi.mock("../runners/checkpoint.js", () => ({
  findRecentCheckpoint: vi.fn(() => ({
    taskId: "cp-task-1",
    title: "Chat: tarea previa",
    userMessage: "termina el reporte de señales",
    toolsCalled: ["shell_exec"],
    scopeGroups: [],
    exitReason: "max_rounds",
    roundsCompleted: 24,
    maxRounds: 24,
    summary: "parcial",
    createdAt: new Date().toISOString(),
  })),
  clearCheckpoint: vi.fn(),
  writeCheckpoint: vi.fn(),
  pruneExpiredCheckpoints: vi.fn(() => 0),
}));

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

// Usability Phase 5.5: the `/rituales` intercept is router plumbing; the
// command itself (config + DB) is unit-tested in rituals/rituales-command.test.ts.
const ritualesMocks = vi.hoisted(() => ({
  handleRitualesCommand: vi.fn((text: string) =>
    text.includes("pausa")
      ? "Pausado: Signal intelligence."
      : "🗓 Rituales (hora MX)\n1. Signal intelligence — diario 06:00",
  ),
}));
vi.mock("../rituals/rituales-command.js", () => ({
  RITUALES_RE: /^\/?rituales\b/i,
  handleRitualesCommand: ritualesMocks.handleRitualesCommand,
}));

vi.mock("../db/index.js", () => ({
  getDatabase: () => ({
    prepare: () => ({
      get: dbStatusGet,
      run: () => ({ changes: 1 }),
      all: () => [],
    }),
    // ritual delivery-policy ledger (ensure table / insert) — no-op in tests
    exec: () => undefined,
  }),
}));

import {
  MessageRouter,
  threadKey,
  isOwnerChannel,
  isPoisonedExchange,
  threadImageLive,
  _testSeedThread,
} from "./router.js";
import {
  pinFromExchange,
  getPins,
  getTaskConfirmedFigures,
  _resetThreadPins,
} from "./thread-pins.js";
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
    // Drain any `mockResolvedValueOnce` a failed test left queued (R3 audit
    // W5): clearAllMocks keeps once-queues, so one RED cascaded into the next.
    vi.mocked(submitTask)
      .mockReset()
      .mockResolvedValue({
        taskId: "test-task-123",
        agentType: "fast",
        classification: { score: 1, reason: "test", explicit: false },
      });
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

    // V8.3 seam origin (qa W1/W2 2026-08-17): the operator's turn carries its
    // thread key so gated tools inside the run ledger as `operator`; a group
    // member's turn must NOT (it would show operator exercise no operator
    // performed on §14's by-source line). Delete `threadId:` at the submit
    // site and the first assertion goes red.
    it("passes threadId (= the thread key) for the OWNER's turn, and omits it for a non-owner group sender", async () => {
      process.env.WHATSAPP_OWNER_JID = "owner@s.whatsapp.net";
      await router.handleInbound({
        channel: "whatsapp",
        from: "owner@s.whatsapp.net",
        text: "agenda algo",
        timestamp: new Date(),
      });
      expect(submitTask).toHaveBeenLastCalledWith(
        expect.objectContaining({ threadId: "whatsapp" }),
      );

      await router.handleInbound({
        channel: "whatsapp",
        from: "grp@g.us",
        text: "@jarvis agenda algo",
        timestamp: new Date(),
        metadata: {
          isGroup: true,
          groupJid: "grp@g.us",
          senderJid: "member@s.whatsapp.net",
        },
      });
      const last = (submitTask as any).mock.calls.at(-1)[0];
      expect(last.tags).toEqual(["messaging", "whatsapp"]);
      expect(last.threadId).toBeUndefined();

      // The owner speaking INSIDE the group is still the operator.
      await router.handleInbound({
        channel: "whatsapp",
        from: "grp@g.us",
        text: "@jarvis agenda algo",
        timestamp: new Date(),
        metadata: {
          isGroup: true,
          groupJid: "grp@g.us",
          senderJid: "owner@s.whatsapp.net",
        },
      });
      expect(submitTask).toHaveBeenLastCalledWith(
        expect.objectContaining({
          threadId: "whatsapp:grp@g.us:owner@s.whatsapp.net",
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
      // Usability Phase 3: the always-on provenance rule is WIRED into the
      // prompt (R1 audit W7 — the section test alone cannot catch an
      // unhooked p2.push).
      expect(call.description).toContain(
        "REGLA CRÍTICA: Cifras con procedencia",
      );
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

    it("a bare verdict with NO pending brief gets a deterministic 'nothing pending' reply, NEVER the chat LLM (2026-07-14 incident)", async () => {
      // Verdict floor: a bare "Sirve" with no brief to rule on used to fall
      // through to the chat pipeline, where the LLM read it against prior
      // conversation context as a project go-ahead (Jarvis started
      // implementing JME Phase 2 from a verdict word).
      await router.handleInbound(owner("sirve"));

      expect(submitTask).not.toHaveBeenCalled();
      expect(waAdapter.sentMessages).toHaveLength(1);
      expect(waAdapter.sentMessages[0].text).toContain(
        "No hay brief pendiente",
      );
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

    it("a resolver race (null result despite pending brief) still hits the verdict floor, not dispatch", async () => {
      briefingMocks.getResolvablePendingBriefing.mockReturnValueOnce({
        briefingId: "b1",
      });
      briefingMocks.resolveBriefingOnOperatorReply.mockResolvedValueOnce(null);

      await router.handleInbound(owner("sirve"));

      // No verdict ack is fabricated for a brief we didn't resolve — but the
      // pure verdict token must still never reach the chat LLM: the floor
      // reply says nothing is pending (the other path's ack already landed).
      expect(waAdapter.sentMessages).toHaveLength(1);
      expect(waAdapter.sentMessages[0].text).toContain(
        "No hay brief pendiente",
      );
      expect(submitTask).not.toHaveBeenCalled();
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

    it("delivers a sanitized reply when the runner output carries harness markers (usability plan Phase 0.1)", async () => {
      const msg: IncomingMessage = {
        channel: "whatsapp",
        from: "owner@s.whatsapp.net",
        text: "test markers",
        timestamp: new Date(),
      };
      await router.handleInbound(msg);
      router.startEventListeners();

      const completedHandler = findHandler("task.completed");
      completedHandler!({
        data: {
          task_id: "test-task-123",
          agent_id: "fast",
          result:
            "[error_max_turns — Reached maximum number of turns (55)] Partial response below — turn/budget limit hit before completion.\n\n" +
            "I'll verify the push first.\n\n" +
            "Commit 8a49b05 listo. Falta el push y verificar en producción (thewilliamsradar.com/w34 debe responder 200).\n\n" +
            "STATUS: DONE_WITH_CONCERNS — SDK reported error_max_turns; content above is partial",
          duration_ms: 500,
        },
      });

      expect(waAdapter.sentMessages).toHaveLength(2);
      const delivered = waAdapter.sentMessages[1].text;
      expect(delivered).not.toContain("[error_max_turns");
      expect(delivered).not.toContain("STATUS:");
      expect(delivered).not.toContain("I'll verify");
      expect(delivered.startsWith("Commit 8a49b05 listo.")).toBe(true);
      expect(delivered).toContain("Dime «sigue» para continuar.");
    });

    it("usability Phase 2 (R3 audit C1): a background-agent notice keeps EVERY ledger line past the 500-char cap — including the ones appended last", async () => {
      dbStatusGet.mockReturnValue({
        spawn_type: "user-background",
        title: "🤖 Agente: sync KB",
        status: "completed",
        agent_type: "fast",
      });
      try {
        await router.handleInbound({
          channel: "whatsapp",
          from: "owner@s.whatsapp.net",
          text: "lanza el agente",
          timestamp: new Date(),
        });
        router.startEventListeners();
        const body = "Resumen del agente. " + "x".repeat(700);
        const ledger =
          "⚠️ No quedó: KB projects/x.md escrito — KB projects/x.md: no existe tras la escritura\n" +
          "⏳ Sin releer (no alcancé a verificar): KB projects/y.md escrito\n\n" +
          "Gates: 1/1 met";
        findHandler("task.completed")!({
          data: {
            task_id: "test-task-123",
            agent_id: "fast",
            result: `${body}\n\n${ledger}`,
            duration_ms: 1,
          },
        });
        const text = waAdapter.sentMessages.at(-1)!.text;
        expect(text).toContain("Agente terminó");
        expect(text).toContain("⚠️ No quedó: KB projects/x.md escrito");
        expect(text).toContain("⏳ Sin releer");
        expect(text).toContain("Gates: 1/1 met");
        expect(text).toContain("..."); // the body WAS capped
      } finally {
        dbStatusGet.mockReturnValue(undefined);
      }
    });

    it("usability Phase 3 (R2 W-7): when the harness tail exceeds 800 chars the END is kept — the ledger lines appended last survive, the numbers footer is what gets cut", async () => {
      dbStatusGet.mockReturnValue({
        spawn_type: "user-background",
        title: "🤖 Agente: sync KB",
        status: "completed",
        agent_type: "fast",
      });
      try {
        await router.handleInbound({
          channel: "whatsapp",
          from: "owner@s.whatsapp.net",
          text: "lanza el agente",
          timestamp: new Date(),
        });
        router.startEventListeners();
        const footer =
          "⚠️ Cifras sin respaldo en las herramientas de esta corrida (no verificadas): " +
          Array.from({ length: 120 }, (_, i) => `$${i},000`).join(", ");
        const ledger =
          "⚠️ No quedó: KB projects/x.md escrito — no existe tras la escritura\n\nGates: 1/1 met";
        findHandler("task.completed")!({
          data: {
            task_id: "test-task-123",
            agent_id: "fast",
            result: `Resumen.\n\n${footer}\n\n${ledger}`,
            duration_ms: 1,
          },
        });
        const text = waAdapter.sentMessages.at(-1)!.text;
        expect(footer.length + ledger.length).toBeGreaterThan(800);
        expect(text).toContain("⚠️ No quedó: KB projects/x.md escrito");
        expect(text).toContain("Gates: 1/1 met");
        expect(text).toContain("…⚠️ Cifras sin respaldo".slice(0, 1)); // ellipsis marks the cut at the START of the tail
        expect(text).not.toContain("$0,000, $1,000"); // the head of the footer was cut, not the ledger
      } finally {
        dbStatusGet.mockReturnValue(undefined);
      }
    });

    it("usability Phase 3 (R1 C3): the user's message joins the numbers-evidence corpus of the submitted task", async () => {
      const numbers = await import("../lib/v8-4/numbers.js");
      numbers._resetToolEvidence();
      vi.mocked(submitTask).mockResolvedValueOnce({
        taskId: "task-evidence-1",
        agentType: "fast",
        classification: { score: 1, reason: "test", explicit: false },
      });
      await router.handleInbound({
        channel: "whatsapp",
        from: "owner@s.whatsapp.net",
        text: "Estoy viendo 975 M de impresiones en el sheet y no 776 M",
        timestamp: new Date(),
      });
      const corpus = numbers.takeToolEvidence("task-evidence-1");
      expect(corpus[0]).toBe(
        "Estoy viendo 975 M de impresiones en el sheet y no 776 M",
      );
    });

    it("usability Phase 1.2: a scope-ask reply is NOT delivered — the turn is re-run with the widened tool list", async () => {
      const mocked = vi.mocked(submitTask);
      mocked.mockResolvedValueOnce({
        taskId: "test-task-123",
        agentType: "fast",
        classification: { score: 1, reason: "test", explicit: false },
      });
      await router.handleInbound({
        channel: "whatsapp",
        from: "owner@s.whatsapp.net",
        // A research-class message: shell_exec is NOT in its scope, so the
        // model's ask is a genuine miss (a "publica…" message would already
        // carry the coding group via regex and the ask would be hallucinated).
        text: "háblame de beeshake.com y su modelo de negocio",
        timestamp: new Date(),
      });
      router.startEventListeners();
      // (No assertion on the first call's tools: the regex fallback also reads
      // the thread buffer's recent user messages, which earlier tests fill.
      // If shell_exec were already in scope the re-run below would not happen
      // and the `scope-rerun` assertions would fail — so the contract holds.)
      const firstCall = mocked.mock.calls.at(-1)![0] as { title: string };

      mocked.mockResolvedValueOnce({
        taskId: "test-task-rerun",
        agentType: "fast",
        classification: { score: 1, reason: "test", explicit: false },
      });
      findHandler("task.completed")!({
        data: {
          task_id: "test-task-123",
          agent_id: "fast",
          result:
            '`tweet_post` no está en el scope activo. Necesito que me lo actives con "usa tweet_post" para publicar.',
          duration_ms: 500,
        },
      });
      await Promise.resolve();
      await Promise.resolve();

      // Only the ack reached the channel — never the ask.
      expect(waAdapter.sentMessages).toHaveLength(1);
      expect(waAdapter.sentMessages[0].text).toContain("Recibido");
      // The same turn was resubmitted with tweet_post (social group) in scope.
      const rerun = mocked.mock.calls.at(-1)![0] as {
        tools: string[];
        tags: string[];
        title: string;
      };
      expect(rerun.tags).toContain("scope-rerun");
      expect(rerun.tools).toContain("tweet_post");
      expect(rerun.title).toBe(firstCall.title);

      // The re-run's real answer is delivered normally.
      findHandler("task.completed")!({
        data: {
          task_id: "test-task-rerun",
          agent_id: "fast",
          result:
            "Publicado: thewilliamsradar.com/w34 responde 200 OK. Commit 8a49b05 en origin/main.",
          duration_ms: 500,
        },
      });
      expect(waAdapter.sentMessages).toHaveLength(2);
      expect(waAdapter.sentMessages[1].text).toContain("Publicado");
    });

    it("usability Phase 1.2 on Telegram (R1 audit C1): the streamed ask is wiped and the re-run answers IN the same placeholder", async () => {
      // A telegram adapter whose getBot() returns a fake grammy api — this is
      // what makes the router create a TelegramStreamController.
      const edits: { messageId: number; text: string }[] = [];
      const fakeBot = {
        api: {
          sendMessage: vi.fn().mockResolvedValue({ message_id: 777 }),
          editMessageText: vi
            .fn()
            .mockImplementation(
              async (_chat: string, messageId: number, text: string) => {
                edits.push({ messageId, text });
                return true;
              },
            ),
        },
      };
      const tgAdapter = Object.assign(createMockAdapter("telegram"), {
        getBot: () => fakeBot,
      });
      router.registerChannel(tgAdapter as unknown as ChannelAdapter);
      const mocked = vi.mocked(submitTask);
      mocked.mockResolvedValueOnce({
        taskId: "tg-task-1",
        agentType: "fast",
        classification: { score: 1, reason: "test", explicit: false },
      });
      await router.handleInbound({
        channel: "telegram",
        from: "12345",
        text: "háblame de beeshake.com y su modelo de negocio",
        timestamp: new Date(),
      });
      router.startEventListeners();
      // The first run streamed the ask live (what the operator saw on screen).
      const firstCall = mocked.mock.calls.at(-1)![0] as {
        onTextChunk?: (c: string) => void;
      };
      firstCall.onTextChunk?.(
        '`tweet_post` no está en el scope activo. Pídeme con "usa tweet_post".',
      );
      vi.advanceTimersByTime(2000);
      expect(edits.at(-1)?.text).toContain("tweet_post");

      mocked.mockResolvedValueOnce({
        taskId: "tg-task-rerun",
        agentType: "fast",
        classification: { score: 1, reason: "test", explicit: false },
      });
      findHandler("task.completed")!({
        data: {
          task_id: "tg-task-1",
          agent_id: "fast",
          result:
            '`tweet_post` no está en el scope activo. Pídeme con "usa tweet_post".',
          duration_ms: 500,
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      // The placeholder was reset — the ask is no longer what the screen shows.
      expect(edits.at(-1)?.text).toBe("⏳");
      // The re-run streams into the SAME message and finalizes it there.
      const rerunCall = mocked.mock.calls.at(-1)![0] as {
        onTextChunk?: (c: string) => void;
        tags: string[];
      };
      expect(rerunCall.tags).toContain("scope-rerun");
      expect(rerunCall.onTextChunk).toBeTypeOf("function");
      rerunCall.onTextChunk!("Publicado.");
      vi.advanceTimersByTime(2000);
      expect(edits.at(-1)?.messageId).toBe(777);
      expect(edits.at(-1)?.text).toContain("Publicado");
      findHandler("task.completed")!({
        data: {
          task_id: "tg-task-rerun",
          agent_id: "fast",
          result: "Publicado: thewilliamsradar.com/w34 responde 200 OK.",
          duration_ms: 500,
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      // No separate second message: every delivery went through the placeholder edits.
      expect(tgAdapter.sentMessages).toHaveLength(0);
      router.unregisterChannel("telegram");
      expect(edits.at(-1)?.messageId).toBe(777);
      expect(edits.at(-1)?.text).toContain("Publicado");
      // The ask WAS on screen before the reset (that is the C1 defect)…
      const resetIdx = edits.findIndex((e) => e.text === "⏳");
      expect(resetIdx).toBeGreaterThan(0);
      expect(
        edits.slice(0, resetIdx).some((e) => e.text.includes("usa tweet_post")),
      ).toBe(true);
      // …and never again after it.
      expect(
        edits.slice(resetIdx).some((e) => e.text.includes("usa tweet_post")),
      ).toBe(false);
    });

    it("usability Phase 1.2 (R2 audit C2): a hallucinated ask — tool already in scope — is re-run with a correction note, never delivered (corpus 12465)", async () => {
      const mocked = vi.mocked(submitTask);
      await router.handleInbound({
        channel: "whatsapp",
        from: "owner@s.whatsapp.net",
        text: "lee el pdf",
        timestamp: new Date(),
      });
      router.startEventListeners();
      const first = mocked.mock.calls.at(-1)![0] as { tools: string[] };
      expect(first.tools).toContain("jarvis_file_read");
      mocked.mockResolvedValueOnce({
        taskId: "test-task-halluc",
        agentType: "fast",
        classification: { score: 1, reason: "test", explicit: false },
      });
      findHandler("task.completed")!({
        data: {
          task_id: "test-task-123",
          agent_id: "fast",
          result:
            '`jarvis_file_read` no está en el scope activo. Necesito que me lo actives con "usa jarvis_file_read".',
          duration_ms: 1,
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      // Not delivered; re-run with the SAME tool list + a system correction.
      expect(waAdapter.sentMessages).toHaveLength(1);
      const rerun = mocked.mock.calls.at(-1)![0] as {
        tools: string[];
        tags: string[];
        description: string;
      };
      expect(rerun.tags).toContain("scope-rerun");
      expect(rerun.tools.sort()).toEqual([...first.tools].sort());
      expect(rerun.description).toContain("NOTA DEL SISTEMA");
      expect(rerun.description).toContain("`jarvis_file_read`");
    });

    it("usability Phase 1.2: a weak scope MENTION beside a tool it has is delivered as-is (corpus 11723)", async () => {
      const mocked = vi.mocked(submitTask);
      await router.handleInbound({
        channel: "whatsapp",
        from: "owner@s.whatsapp.net",
        text: "lee el pdf",
        timestamp: new Date(),
      });
      router.startEventListeners();
      const calls = mocked.mock.calls.length;
      const reply =
        "El PDF es imagen-only y no tengo OCR ni visión directa en este scope.\n\nLo que sí puedo hacer: leer el Slides original con `jarvis_file_read`. ¿Prefieres eso?";
      findHandler("task.completed")!({
        data: {
          task_id: "test-task-123",
          agent_id: "fast",
          result: reply,
          duration_ms: 1,
        },
      });
      expect(mocked.mock.calls.length).toBe(calls);
      expect(waAdapter.sentMessages).toHaveLength(2);
      expect(waAdapter.sentMessages[1].text).toContain("Lo que sí puedo hacer");
    });

    it("usability Phase 1.2 (R2 audit W5): the widening uses the NARROWEST group — a shell_exec ask adds coding, not meta", async () => {
      const mocked = vi.mocked(submitTask);
      await router.handleInbound({
        channel: "whatsapp",
        from: "owner@s.whatsapp.net",
        text: "qué opinas de la propuesta de Emilio",
        timestamp: new Date(),
      });
      router.startEventListeners();
      const first = mocked.mock.calls.at(-1)![0] as { tools: string[] };
      if (first.tools.includes("shell_exec")) return; // thread history already coding — contract covered by the tweet_post test
      mocked.mockResolvedValueOnce({
        taskId: "test-task-narrow",
        agentType: "fast",
        classification: { score: 1, reason: "test", explicit: false },
      });
      findHandler("task.completed")!({
        data: {
          task_id: "test-task-123",
          agent_id: "fast",
          result: "Necesito `shell_exec` para esto.",
          duration_ms: 1,
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      const rerun = mocked.mock.calls.at(-1)![0] as {
        tools: string[];
        tags: string[];
      };
      expect(rerun.tags).toContain("scope-rerun");
      expect(rerun.tools).toContain("shell_exec");
      // `chart_generate` / `rss_read` live in meta (160 tools) but not in
      // coding (50) — the widening must not reach them.
      expect(rerun.tools).not.toContain("chart_generate");
      expect(rerun.tools).not.toContain("rss_read");
      expect(rerun.tools.length).toBeLessThan(100);
    });

    it("usability Phase 1.2 (R3 audit W1): a weak scope mention inside the re-run's real answer is delivered, not replaced", async () => {
      const mocked = vi.mocked(submitTask);
      await router.handleInbound({
        channel: "whatsapp",
        from: "owner@s.whatsapp.net",
        text: "háblame de beeshake.com",
        timestamp: new Date(),
      });
      router.startEventListeners();
      mocked.mockResolvedValueOnce({
        taskId: "test-task-rerun-weak",
        agentType: "fast",
        classification: { score: 1, reason: "test", explicit: false },
      });
      findHandler("task.completed")!({
        data: {
          task_id: "test-task-123",
          agent_id: "fast",
          result: "Necesito `tweet_post` para publicar.",
          duration_ms: 1,
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      findHandler("task.completed")!({
        data: {
          task_id: "test-task-rerun-weak",
          agent_id: "fast",
          result:
            "Publicado el tweet. Nota: el PDF adjunto es imagen-only y no tengo OCR en este scope, así que lo leí con `jarvis_file_read` del texto que ya tenías en el KB.",
          duration_ms: 1,
        },
      });
      expect(waAdapter.sentMessages).toHaveLength(2);
      expect(waAdapter.sentMessages[1].text).toContain("Publicado el tweet");
    });

    it("usability Phase 1.2: a scope-ask on the re-run itself delivers the honest fallback line, never a keyword to retype", async () => {
      const mocked = vi.mocked(submitTask);
      await router.handleInbound({
        channel: "whatsapp",
        from: "owner@s.whatsapp.net",
        text: "háblame de beeshake.com",
        timestamp: new Date(),
      });
      router.startEventListeners();
      mocked.mockResolvedValueOnce({
        taskId: "test-task-rerun2",
        agentType: "fast",
        classification: { score: 1, reason: "test", explicit: false },
      });
      findHandler("task.completed")!({
        data: {
          task_id: "test-task-123",
          agent_id: "fast",
          result:
            "Las herramientas gemini_image no aparecen en mi lista de herramientas actual — pídeme con «usa gemini».",
          duration_ms: 500,
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      findHandler("task.completed")!({
        data: {
          task_id: "test-task-rerun2",
          agent_id: "fast",
          result:
            "gemini_image sigue sin aparecer en mi lista de herramientas — pídeme con «usa gemini».",
          duration_ms: 500,
        },
      });
      expect(waAdapter.sentMessages).toHaveLength(2);
      const text = waAdapter.sentMessages[1].text;
      expect(text).not.toContain("usa gemini");
      expect(text).not.toContain("gemini_image");
      expect(text).toContain("ni al reintentar");
    });

    it("a markers-only result delivers one Spanish failure line, never the raw marker (mutation guard for the filter wiring)", async () => {
      const msg: IncomingMessage = {
        channel: "whatsapp",
        from: "owner@s.whatsapp.net",
        text: "test markers only",
        timestamp: new Date(),
      };
      await router.handleInbound(msg);
      router.startEventListeners();

      const completedHandler = findHandler("task.completed");
      completedHandler!({
        data: {
          task_id: "test-task-123",
          agent_id: "fast",
          result:
            "[timeout after 900s — partial response below]\n\nSTATUS: DONE_WITH_CONCERNS — query hit the 900s hard timeout",
          duration_ms: 500,
        },
      });

      expect(waAdapter.sentMessages).toHaveLength(2);
      expect(waAdapter.sentMessages[1].text).toBe(
        "La tarea se cortó por tiempo antes de producir resultado. ¿La reintento?",
      );
    });

    it("prefixes a caveat when a promoted heavy task completes with concerns (qa-audit W1)", async () => {
      // Heavy graded-down completions (all goals done, reflection below the
      // gate) are delivered via the completed path as completed_with_concerns
      // — the operator must see the unverified-content caveat, not a clean
      // answer indistinguishable from a fully verified one.
      dbStatusGet.mockReturnValue({
        spawn_type: "root",
        title: "Chat: verifica el PDF",
        status: "completed_with_concerns",
        agent_type: "heavy",
      });
      try {
        const msg: IncomingMessage = {
          channel: "whatsapp",
          from: "owner@s.whatsapp.net",
          text: "verifica el PDF",
          timestamp: new Date(),
        };
        await router.handleInbound(msg);
        router.startEventListeners();

        const completedHandler = findHandler("task.completed");
        completedHandler!({
          data: {
            task_id: "test-task-123",
            agent_id: "heavy",
            result: { finalAnswer: "Reporte de cifras verificadas." },
            duration_ms: 500,
          },
        });

        expect(waAdapter.sentMessages[1].text).toContain(
          "Completado con reservas",
        );
        expect(waAdapter.sentMessages[1].text).toContain(
          "Reporte de cifras verificadas.",
        );
      } finally {
        dbStatusGet.mockReturnValue(undefined);
      }
    });

    it("does NOT prefix the caveat for fast completed_with_concerns tasks (routine status)", async () => {
      // Fast tasks land completed_with_concerns routinely (a missing STATUS
      // line defaults there) — a caveat on those would be noise.
      dbStatusGet.mockReturnValue({
        spawn_type: "root",
        title: "Chat: normal",
        status: "completed_with_concerns",
        agent_type: "fast",
      });
      try {
        const msg: IncomingMessage = {
          channel: "whatsapp",
          from: "owner@s.whatsapp.net",
          text: "normal",
          timestamp: new Date(),
        };
        await router.handleInbound(msg);
        router.startEventListeners();

        const completedHandler = findHandler("task.completed");
        completedHandler!({
          data: {
            task_id: "test-task-123",
            agent_id: "fast",
            result: { text: "Respuesta normal." },
            duration_ms: 500,
          },
        });

        expect(waAdapter.sentMessages[1].text).toBe("Respuesta normal.");
      } finally {
        dbStatusGet.mockReturnValue(undefined);
      }
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

    it("usability Phase 0.1: runner text delivered on the needs_context path passes the sendLLMReplyToChannel filter", async () => {
      dbStatusGet.mockReturnValue({
        spawn_type: "root",
        title: "Chat: poema",
        status: "needs_context",
      });
      try {
        await router.handleInbound({
          channel: "whatsapp",
          from: "owner@s.whatsapp.net",
          text: "poema",
          timestamp: new Date(),
        });
        router.startEventListeners();
        findHandler("task.failed")!({
          data: {
            task_id: "test-task-123",
            agent_id: "fast",
            error: "blocked",
            result: {
              text: 'Aquí va el poema:API Error: 400 {"type":"error","error":{"message":"Output blocked by content filtering policy"}}',
            },
          },
        });
        expect(waAdapter.sentMessages).toHaveLength(2);
        const text = waAdapter.sentMessages[1].text;
        expect(text).not.toContain("content filtering");
        expect(text).toContain("La API devolvió un error 400. ¿Reintento?");
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

    it("delivers a produced deliverable on plain `failed` with an honest caveat (task e6f3dfa0)", async () => {
      // A reflection-graded heavy failure still carried the full report in
      // result.finalAnswer; the old handler discarded it and sent the
      // generic line ("[Task failed] Unknown error" in memory).
      memoryRetainSpy.mockClear();
      dbStatusGet.mockReturnValue({
        spawn_type: "root",
        title: "Chat: verifica el PDF",
        status: "failed",
      });
      try {
        const msg: IncomingMessage = {
          channel: "whatsapp",
          from: "owner@s.whatsapp.net",
          text: "verifica el PDF",
          timestamp: new Date(),
        };
        await router.handleInbound(msg);
        router.startEventListeners();

        const failedHandler = findHandler("task.failed");
        failedHandler!({
          data: {
            task_id: "test-task-123",
            agent_id: "heavy",
            error: "Unknown error",
            recoverable: false,
            attempts: 1,
            result: {
              content: "Reflector meta-summary",
              finalAnswer: "Cifra $7,200 MDP en conflicto con KB ($6,175).",
              score: 0.63,
            },
          },
        });

        expect(waAdapter.sentMessages[1].text).toContain(
          "no se completó al 100%",
        );
        expect(waAdapter.sentMessages[1].text).toContain(
          "Cifra $7,200 MDP en conflicto con KB ($6,175).",
        );
        // Memory records what the operator saw, not "[Task failed]".
        const [exchange] = memoryRetainSpy.mock.calls[0];
        expect(exchange).toContain("$7,200 MDP");
        expect(exchange).not.toContain("[Task failed]");
      } finally {
        dbStatusGet.mockReturnValue(undefined);
      }
    });

    it("delivers a failed SWARM root's joined answer with the same caveat (task 0b8c7576, 2026-09-03)", async () => {
      // 3/4 goals completed — three full phase analyses in finalAnswer — and
      // the operator received "No pude completar eso". Swarm's finalAnswer is
      // the joined output of heavy children: same trust class as heavy.
      dbStatusGet.mockReturnValue({
        spawn_type: "root",
        title: "Chat: analiza el flujo",
        status: "failed",
      });
      try {
        const msg: IncomingMessage = {
          channel: "whatsapp",
          from: "owner@s.whatsapp.net",
          text: "analiza el flujo",
          timestamp: new Date(),
        };
        await router.handleInbound(msg);
        router.startEventListeners();

        const failedHandler = findHandler("task.failed");
        failedHandler!({
          data: {
            task_id: "test-task-123",
            agent_id: "swarm",
            error: "Unknown error",
            recoverable: false,
            attempts: 1,
            result: {
              content: "The swarm analyzed Fases 1-11 but the Doc failed",
              finalAnswer:
                "Fase 1 — Captación: riesgo alto en el primer contacto…",
              score: 0.6,
              goalSummary: { completed: 3, failed: 1, total: 4 },
            },
          },
        });

        expect(waAdapter.sentMessages[1].text).toContain(
          "no se completó al 100%",
        );
        expect(waAdapter.sentMessages[1].text).toContain("Fase 1 — Captación");
        expect(waAdapter.sentMessages[1].text).not.toContain(
          "The swarm analyzed Fases 1-11",
        );
      } finally {
        dbStatusGet.mockReturnValue(undefined);
      }
    });

    it("keeps the generic line on plain `failed` for non-heavy agents (qa-audit W3)", async () => {
      // nanoclaw failures can carry structural sentinels or guard-suppressed
      // substitute work — never deliver those as a partial answer.
      dbStatusGet.mockReturnValue({
        spawn_type: "root",
        title: "Chat: code task",
        status: "failed",
      });
      try {
        const msg: IncomingMessage = {
          channel: "whatsapp",
          from: "owner@s.whatsapp.net",
          text: "code task",
          timestamp: new Date(),
        };
        await router.handleInbound(msg);
        router.startEventListeners();

        const failedHandler = findHandler("task.failed");
        failedHandler!({
          data: {
            task_id: "test-task-123",
            agent_id: "nanoclaw",
            error: "Unknown error",
            recoverable: false,
            attempts: 1,
            result: { finalAnswer: "TARGET_NOT_IN_SANDBOX — cannot proceed" },
          },
        });

        expect(waAdapter.sentMessages[1].text).toContain(
          "No pude completar eso",
        );
      } finally {
        dbStatusGet.mockReturnValue(undefined);
      }
    });

    it("does not deliver the reflector meta-summary as a partial answer (qa-audit W2)", async () => {
      // A heavy run where every goal failed has finalAnswer=null and only
      // `content` (the reflector's meta-summary, e.g. "Heuristic score:
      // 0.00") — that is commentary about the work, not the work.
      dbStatusGet.mockReturnValue({
        spawn_type: "root",
        title: "Chat: hard task",
        status: "failed",
      });
      try {
        const msg: IncomingMessage = {
          channel: "whatsapp",
          from: "owner@s.whatsapp.net",
          text: "hard task",
          timestamp: new Date(),
        };
        await router.handleInbound(msg);
        router.startEventListeners();

        const failedHandler = findHandler("task.failed");
        failedHandler!({
          data: {
            task_id: "test-task-123",
            agent_id: "heavy",
            error: "Unknown error",
            recoverable: false,
            attempts: 1,
            result: {
              content: "Heuristic score: 0.00. 0/3 goals completed.",
              finalAnswer: null,
            },
          },
        });

        expect(waAdapter.sentMessages[1].text).toContain(
          "No pude completar eso",
        );
        expect(waAdapter.sentMessages[1].text).not.toContain("Heuristic score");
      } finally {
        dbStatusGet.mockReturnValue(undefined);
      }
    });

    it("keeps the generic line on plain `failed` when nothing was produced", async () => {
      dbStatusGet.mockReturnValue({
        spawn_type: "root",
        title: "Chat: x",
        status: "failed",
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
            agent_id: "heavy",
            error: "Provider exploded",
            recoverable: false,
            attempts: 1,
            // Deliverable fields exist but are empty → stays generic (the
            // 2026-07-11 empty-completion class).
            result: { content: "", finalAnswer: null },
          },
        });

        expect(waAdapter.sentMessages[1].text).toContain(
          "No pude completar eso",
        );
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
            task_id: "test-task-123",
            agent_id: "fast",
            result: "Respuesta",
            duration_ms: 100,
          },
        });

        // Fire-and-forget — flush microtasks
        await vi.advanceTimersByTimeAsync(0); // suite runs fake timers — a real setTimeout flush never fires

        expect(mockWriteEpisodic).toHaveBeenCalled();
        const calls = mockWriteEpisodic.mock.calls;
        const roles = calls.map(
          (c: unknown[]) => (c[0] as { role: string }).role,
        );
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
            task_id: "test-task-123",
            agent_id: "fast",
            result: "Respuesta",
            duration_ms: 100,
          },
        });

        await vi.advanceTimersByTimeAsync(0); // suite runs fake timers — a real setTimeout flush never fires

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
            task_id: "test-task-123",
            agent_id: "fast",
            result: "Respuesta",
            duration_ms: 100,
          },
        });

        await vi.advanceTimersByTimeAsync(0); // suite runs fake timers — a real setTimeout flush never fires

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

    it("usability Phase 0.1/0.3: a ritual broadcast is filtered at the broadcastToAll seam (mutation guard)", async () => {
      router.watchRitualTask("ritual-task-pm", "nightly-close");
      router.startEventListeners();
      findHandler("task.completed")!({
        data: {
          task_id: "ritual-task-pm",
          agent_id: "fast",
          result:
            "[timeout after 900s — partial response below]\n\n**Cierre del día** 🌙 2026-08-22\n\n**✅ Lo que se movió hoy**\n- Plan de usabilidad aprobado y Phase 0 en marcha.\n\nSTATUS: DONE_WITH_CONCERNS — partial",
          duration_ms: 5000,
        },
      });
      expect(waAdapter.sentMessages).toHaveLength(1);
      const text = waAdapter.sentMessages[0].text;
      expect(text).not.toContain("[timeout after");
      expect(text).not.toContain("STATUS:");
      expect(text.startsWith("**Cierre del día**")).toBe(true);
      expect(text).toContain("¿Sigo desde donde quedó?");
    });

    it("usability Phase 0.3 (ruling 2): evolution-log and day-narrative are never broadcast", async () => {
      router.watchRitualTask("ritual-evo", "evolution-log");
      router.watchRitualTask("ritual-narr", "day-narrative");
      router.startEventListeners();
      const h = findHandler("task.completed")!;
      h({
        data: {
          task_id: "ritual-evo",
          agent_id: "fast",
          result: "## 2026-08-22\n\nEvolution entry…",
          duration_ms: 1,
        },
      });
      h({
        data: {
          task_id: "ritual-narr",
          agent_id: "fast",
          result: "Narrativa del día…",
          duration_ms: 1,
        },
      });
      expect(waAdapter.sentMessages).toHaveLength(0);
    });

    it("broadcastToAll({raw:true}) delivers router-authored diagnostics verbatim (R1 audit W3)", async () => {
      const alert =
        '⚠️ Scheduled task "Williams Journal" FAILED:\n[error_max_turns — Reached maximum number of turns (55)]\nAPI Error: 400 Output blocked by content filtering policy';
      await router.broadcastToAll(alert, undefined, { raw: true });
      expect(waAdapter.sentMessages).toHaveLength(1);
      expect(waAdapter.sentMessages[0].text).toBe(alert);
      // …and the same text WITHOUT raw is rewritten — proving the seam filters.
      waAdapter.sentMessages.length = 0;
      await router.broadcastToAll(alert);
      expect(waAdapter.sentMessages[0].text).not.toBe(alert);
    });

    // 2026-07-13 operator request: skill-evolution's full report arrived as
    // 5 Telegram chunks — digest rituals broadcast the reflector summary +
    // a mc-ctl pointer instead of the multi-chunk artifact.
    // Usability Phase 5.3 (2026-08-24): skill-evolution is now SUPPRESSED at
    // the delivery seam (memory bank + `mc-ctl task` keep the report; the
    // nightly close is the single evening message). The digest builder stays
    // for any future digest ritual; this pins that nothing is broadcast.
    it("skill-evolution is not broadcast at all (Phase 5.3)", () => {
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

      expect(waAdapter.sentMessages).toHaveLength(0);
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
    it("uses semantic groups when classifier returned non-empty (sticky off)", async () => {
      const { decideActiveGroups } = await import("./router.js");
      const semantic = new Set(["coding"]);
      const prior = new Set(["google"]);
      const fallback = vi.fn(() => new Set(["wordpress"]));
      const result = decideActiveGroups(
        semantic,
        prior,
        fallback,
        undefined,
        false,
      );
      expect(result.source).toBe("semantic");
      expect([...result.groups]).toEqual(["coding"]);
      expect(fallback).not.toHaveBeenCalled();
    });

    it("usability Phase 1.1: a NEW classification UNIONS the prior scope (exchange 11189 'confirmo eliminación' keeps coding)", async () => {
      const { decideActiveGroups } = await import("./router.js");
      const semantic = new Set(["destructive"]);
      const prior = new Set(["coding"]);
      const result = decideActiveGroups(
        semantic,
        prior,
        vi.fn(() => new Set()),
        "confirmo eliminación",
      );
      expect(result.source).toBe("semantic");
      expect([...result.groups].sort()).toEqual(["coding", "destructive"]);
    });

    it("usability Phase 1.1 (R2 audit C1): the inherited branch returns SEPARATE Sets — mutating groups never touches base", async () => {
      const { decideActiveGroups } = await import("./router.js");
      const d = decideActiveGroups(
        new Set<string>(),
        new Set(["meta"]),
        vi.fn(() => new Set()),
        "continúa",
      );
      expect(d.source).toBe("inherited");
      d.groups.add("google");
      expect(d.base.has("google")).toBe(false);
      expect([...d.base]).toEqual(["meta"]);
    });

    it("usability Phase 1.1: a conversational closer does NOT drag the prior scope along", async () => {
      const { decideActiveGroups } = await import("./router.js");
      const semantic = new Set(["google"]);
      const prior = new Set(["coding"]);
      const result = decideActiveGroups(
        semantic,
        prior,
        vi.fn(() => new Set()),
        "gracias",
      );
      expect([...result.groups]).toEqual(["google"]);
    });

    it("usability Phase 1.1: no prior → semantic only (cold thread)", async () => {
      const { decideActiveGroups } = await import("./router.js");
      const result = decideActiveGroups(
        new Set(["google"]),
        undefined,
        vi.fn(() => new Set()),
        "abre el sheet",
      );
      expect([...result.groups]).toEqual(["google"]);
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

describe("Phase 4.2 — thread image expiry", () => {
  let router: MessageRouter;
  let waAdapter: ReturnType<typeof createMockAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    subscribers.length = 0;
    router = new MessageRouter();
    waAdapter = createMockAdapter("whatsapp");
    router.registerChannel(waAdapter);
  });

  it("only the LAST exchange's image reaches the next turn's history", async () => {
    _testSeedThread("whatsapp", [
      {
        text: "User: mira esta captura\nJarvis: La veo.",
        imageUrl: "data:image/png;base64,OLD",
      },
      {
        text: "User: y esta otra\nJarvis: También.",
        imageUrl: "data:image/png;base64,RECENT",
      },
    ]);
    await router.handleInbound({
      channel: "whatsapp",
      from: "owner@s.whatsapp.net",
      text: "qué diferencias ves?",
      timestamp: new Date(),
    });
    const call = (submitTask as any).mock.calls[0][0];
    const images = call.conversationHistory
      .filter((t: any) => t.imageUrl)
      .map((t: any) => t.imageUrl);
    expect(images).toEqual(["data:image/png;base64,RECENT"]);
  });

  it("an image two exchanges back is never re-injected (stale-image hijack)", async () => {
    _testSeedThread("whatsapp", [
      {
        text: "User: mira esta captura\nJarvis: La veo.",
        imageUrl: "data:image/png;base64,STALE",
      },
      { text: "User: ahora hablemos del P&L\nJarvis: Claro." },
    ]);
    await router.handleInbound({
      channel: "whatsapp",
      from: "owner@s.whatsapp.net",
      text: "dame el resumen",
      timestamp: new Date(),
    });
    const call = (submitTask as any).mock.calls[0][0];
    expect(call.conversationHistory.some((t: any) => t.imageUrl)).toBe(false);
    // The TEXT of the old exchange survives — only the image expires.
    expect(
      call.conversationHistory.some((t: any) => /captura/.test(t.content)),
    ).toBe(true);
  });

  it("threadImageLive: only the final index is live", () => {
    expect(threadImageLive(2, 3)).toBe(true);
    expect(threadImageLive(1, 3)).toBe(false);
    expect(threadImageLive(0, 3)).toBe(false);
    expect(threadImageLive(0, 1)).toBe(true);
  });
});

describe("Phase 4.4 — hard stop", () => {
  let router: MessageRouter;
  let waAdapter: ReturnType<typeof createMockAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    subscribers.length = 0;
    router = new MessageRouter();
    waAdapter = createMockAdapter("whatsapp");
    router.registerChannel(waAdapter);
  });

  it("'Para ya' with no active task replies one line, no question, no task submitted", async () => {
    await router.handleInbound({
      channel: "whatsapp",
      from: "owner@s.whatsapp.net",
      text: "Para ya",
      timestamp: new Date(),
    });
    expect(waAdapter.sentMessages).toHaveLength(1);
    expect(waAdapter.sentMessages[0].text).toBe(
      "Detenido: no había tareas activas.",
    );
    expect(waAdapter.sentMessages[0].text).not.toContain("?");
    expect(submitTask).not.toHaveBeenCalled();
  });

  it("'Para el viernes recuérdame el reporte' is NOT a stop — task submitted", async () => {
    await router.handleInbound({
      channel: "whatsapp",
      from: "owner@s.whatsapp.net",
      text: "Para el viernes recuérdame el reporte",
      timestamp: new Date(),
    });
    expect(submitTask).toHaveBeenCalled();
    expect(
      waAdapter.sentMessages.some((m) => m.text.startsWith("Detenido")),
    ).toBe(false);
  });

  it("'Detente, cambio de plan' is a stop even with a tail", async () => {
    await router.handleInbound({
      channel: "whatsapp",
      from: "owner@s.whatsapp.net",
      text: "Detente, cambio de plan",
      timestamp: new Date(),
    });
    expect(waAdapter.sentMessages[0].text).toMatch(/^Detenido:/);
    expect(submitTask).not.toHaveBeenCalled();
  });

  // R1 audit W2/C3: the central behaviour — ALL tasks of THIS thread stop,
  // other threads on the same channel are untouched.
  it("cancels ALL pending tasks of the thread and reports the count", async () => {
    process.env.WHATSAPP_OWNER_JID = "owner@s.whatsapp.net";
    (submitTask as any)
      .mockResolvedValueOnce({
        taskId: "task-stop-1",
        agentType: "fast",
        classification: { score: 1, reason: "t", explicit: false },
      })
      .mockResolvedValueOnce({
        taskId: "task-stop-2",
        agentType: "fast",
        classification: { score: 1, reason: "t", explicit: false },
      })
      .mockResolvedValueOnce({
        taskId: "task-stop-group",
        agentType: "fast",
        classification: { score: 1, reason: "t", explicit: false },
      });
    // Two DM tasks (tk = "whatsapp") …
    await router.handleInbound({
      channel: "whatsapp",
      from: "owner@s.whatsapp.net",
      text: "genera el reporte semanal de señales",
      timestamp: new Date(),
    });
    await router.handleInbound({
      channel: "whatsapp",
      from: "owner@s.whatsapp.net",
      text: "analiza el corpus de la semana",
      timestamp: new Date(),
    });
    // … and one GROUP task from the owner (tk = "whatsapp:g:owner").
    await router.handleInbound({
      channel: "whatsapp",
      from: "estrategia@g.us",
      text: "[Grupo: Estrategia, De: Owner]\ngenera el resumen del grupo",
      timestamp: new Date(),
      metadata: { senderJid: "owner@s.whatsapp.net" },
    });

    waAdapter.sentMessages.length = 0;
    await router.handleInbound({
      channel: "whatsapp",
      from: "owner@s.whatsapp.net",
      text: "Para ya",
      timestamp: new Date(),
    });
    // Both DM tasks cancelled, the group thread's task untouched.
    expect(waAdapter.sentMessages[0].text).toBe(
      "Detenido: 2 tareas canceladas.",
    );
    // R3 audit C2: the stop exchange is RETAINED (pushToThread is in-memory
    // only) — without this, `stops_honoured` reads 0 forever.
    expect(memoryRetainSpy).toHaveBeenCalledWith(
      expect.stringContaining("Detenido: 2 tareas canceladas."),
      expect.objectContaining({ bank: "mc-jarvis" }),
    );
  });

  // R1 audit C4: a group "Para ya" arrives with the [Grupo: …] prefix and
  // must still stop that group's own task.
  it("group-prefixed 'Para ya' stops the group thread's task", async () => {
    process.env.WHATSAPP_OWNER_JID = "owner@s.whatsapp.net";
    (submitTask as any).mockResolvedValueOnce({
      taskId: "task-group-stop",
      agentType: "fast",
      classification: { score: 1, reason: "t", explicit: false },
    });
    await router.handleInbound({
      channel: "whatsapp",
      from: "estrategia@g.us",
      text: "[Grupo: Estrategia, De: Owner]\ngenera el resumen del grupo",
      timestamp: new Date(),
      metadata: { senderJid: "owner@s.whatsapp.net" },
    });
    waAdapter.sentMessages.length = 0;
    await router.handleInbound({
      channel: "whatsapp",
      from: "estrategia@g.us",
      text: "[Grupo: Estrategia, De: Owner]\nPara ya",
      timestamp: new Date(),
      metadata: { senderJid: "owner@s.whatsapp.net" },
    });
    expect(waAdapter.sentMessages[0].text).toBe("Detenido: 1 tarea cancelada.");
  });
});

describe("Phase 4.1 — thread pins wiring", () => {
  let router: MessageRouter;
  let waAdapter: ReturnType<typeof createMockAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    subscribers.length = 0;
    _resetThreadPins();
    router = new MessageRouter();
    waAdapter = createMockAdapter("whatsapp");
    router.registerChannel(waAdapter);
  });

  it("a pinned URL is injected FIRST in the next turn's variable half", async () => {
    pinFromExchange(
      "whatsapp",
      "User: publica el demo\nJarvis: Listo: https://ant-colony.187.77.25.101.nip.io",
    );
    await router.handleInbound({
      channel: "whatsapp",
      from: "owner@s.whatsapp.net",
      text: "cómo va el demo?",
      timestamp: new Date(),
    });
    const call = (submitTask as any).mock.calls[0][0];
    expect(call.description).toContain("## FIJADO EN ESTE HILO");
    expect(call.description).toContain(
      "https://ant-colony.187.77.25.101.nip.io",
    );
  });

  it("no pins → no FIJADO section", async () => {
    await router.handleInbound({
      channel: "whatsapp",
      from: "owner@s.whatsapp.net",
      text: "hola qué tal todo",
      timestamp: new Date(),
    });
    const call = (submitTask as any).mock.calls[0][0];
    expect(call.description).not.toContain("## FIJADO EN ESTE HILO");
  });

  it("'Confirmo' pins the previous reply's figures and binds them to the submitted task (2.3)", async () => {
    _testSeedThread("whatsapp", [
      {
        text: "User: dame el modelo\nJarvis: Modelo final:\n- Margen bruto: 34%\n- Utilidad neta: $1.2M",
      },
    ]);
    await router.handleInbound({
      channel: "whatsapp",
      from: "owner@s.whatsapp.net",
      text: "Confirmo, pásalo al Sheet",
      timestamp: new Date(),
    });
    // Pinned on the thread…
    const figs = getPins("whatsapp").filter((p) => p.kind === "figure");
    expect(figs.map((f) => f.value)).toContain("34%");
    // …and bound to the task the router submitted (2.3 seam).
    const bound = getTaskConfirmedFigures("test-task-123");
    expect(bound.map((f) => f.raw)).toContain("34%");
    // The confirming turn itself already sees the pins.
    const call = (submitTask as any).mock.calls[0][0];
    expect(call.description).toContain("## FIJADO EN ESTE HILO");
    expect(call.description).toContain("34%");
  });
});

describe("R5 audit W3 — checkpoint continuation is operator-only", () => {
  let router: MessageRouter;
  let waAdapter: ReturnType<typeof createMockAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    subscribers.length = 0;
    _resetThreadPins();
    process.env.WHATSAPP_OWNER_JID = "owner@s.whatsapp.net";
    router = new MessageRouter();
    waAdapter = createMockAdapter("whatsapp");
    router.registerChannel(waAdapter);
  });

  it("the OWNER's continúa injects the checkpoint block", async () => {
    await router.handleInbound({
      channel: "whatsapp",
      from: "owner@s.whatsapp.net",
      text: "continúa",
      timestamp: new Date(),
    });
    const call = (submitTask as any).mock.calls[0][0];
    expect(call.description).toContain("CONTINUACIÓN DE TAREA ANTERIOR");
    expect(call.description).toContain("termina el reporte de señales");
  });

  it("a community-email sender's continúa gets NO checkpoint (operator partial must not leak)", async () => {
    // A public-mailbox sender reaches the same submit path as the owner —
    // this is the population the R4/R5 gate exists for.
    const emailAdapter = {
      name: "email:comunidades",
      mode: "community-manager" as const,
      sentMessages: [] as OutgoingMessage[],
      start: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue("id"),
      onMessage: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
      isConnected: () => true,
    };
    router.registerChannel(emailAdapter as never);
    await router.handleInbound({
      channel: "email:comunidades" as never,
      from: "alice@example.com",
      text: "continúa",
      timestamp: new Date(),
    });
    const call = (submitTask as any).mock.calls.at(-1)?.[0];
    expect(call).toBeDefined();
    expect(call.description).not.toContain("CONTINUACIÓN DE TAREA ANTERIOR");
    expect(call.description).not.toContain("termina el reporte de señales");
  });
});

describe("usability Phase 5.5 — /rituales intercept", () => {
  let router: MessageRouter;
  let waAdapter: ReturnType<typeof createMockAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    subscribers.length = 0;
    _resetThreadPins();
    process.env.WHATSAPP_OWNER_JID = "owner@s.whatsapp.net";
    router = new MessageRouter();
    waAdapter = createMockAdapter("whatsapp");
    router.registerChannel(waAdapter);
  });

  it("the owner's /rituales is answered from the command module — no task, retained", async () => {
    await router.handleInbound({
      channel: "whatsapp",
      from: "owner@s.whatsapp.net",
      text: "/rituales",
      timestamp: new Date(),
    });
    expect(ritualesMocks.handleRitualesCommand).toHaveBeenCalledWith(
      "/rituales",
    );
    expect(waAdapter.sentMessages[0].text).toMatch(/^🗓 Rituales/);
    expect(submitTask).not.toHaveBeenCalled();
    expect(memoryRetainSpy).toHaveBeenCalledWith(
      expect.stringContaining("Rituales (hora MX)"),
      expect.objectContaining({ tags: expect.arrayContaining(["rituales"]) }),
    );
  });

  it("'rituales pausa 1' without the slash also works", async () => {
    await router.handleInbound({
      channel: "whatsapp",
      from: "owner@s.whatsapp.net",
      text: "rituales pausa 1",
      timestamp: new Date(),
    });
    expect(waAdapter.sentMessages[0].text).toBe(
      "Pausado: Signal intelligence.",
    );
    expect(submitTask).not.toHaveBeenCalled();
  });

  it("a community-email sender's /rituales is NOT a command (falls through to the normal path)", async () => {
    const emailAdapter = {
      name: "email:comunidades",
      mode: "community-manager" as const,
      sentMessages: [] as OutgoingMessage[],
      start: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue("id"),
      onMessage: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
      isConnected: () => true,
    };
    router.registerChannel(emailAdapter as never);
    await router.handleInbound({
      channel: "email:comunidades" as never,
      from: "alice@example.com",
      text: "/rituales pausa 1",
      timestamp: new Date(),
    });
    expect(ritualesMocks.handleRitualesCommand).not.toHaveBeenCalled();
    expect(submitTask).toHaveBeenCalled();
  });

  it("a WhatsApp GROUP member's /rituales is NOT a command (R1 audit W6 — the group branch of the owner gate)", async () => {
    await router.handleInbound({
      channel: "whatsapp",
      from: "estrategia@g.us",
      text: "[Grupo: Estrategia, De: Member]\n/rituales pausa 1",
      timestamp: new Date(),
      metadata: { isGroup: true, senderJid: "member@s.whatsapp.net" },
    });
    expect(ritualesMocks.handleRitualesCommand).not.toHaveBeenCalled();
    expect(
      waAdapter.sentMessages.some((m) => /Pausado|Rituales/.test(m.text)),
    ).toBe(false);
  });

  it("a non-command ('ritualesco') is not intercepted", async () => {
    await router.handleInbound({
      channel: "whatsapp",
      from: "owner@s.whatsapp.net",
      text: "ritualesco es una palabra",
      timestamp: new Date(),
    });
    expect(ritualesMocks.handleRitualesCommand).not.toHaveBeenCalled();
  });
});

describe("/loop — operator-instructed unlimited task (2026-08-27)", () => {
  let router: MessageRouter;
  let waAdapter: ReturnType<typeof createMockAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    subscribers.length = 0;
    _resetThreadPins();
    process.env.WHATSAPP_OWNER_JID = "owner@s.whatsapp.net";
    router = new MessageRouter();
    waAdapter = createMockAdapter("whatsapp");
    router.registerChannel(waAdapter);
  });

  it("the owner's `/loop <tarea>` submits ONE task pinned to fast, unlimited, tagged loop, prefix stripped", async () => {
    await router.handleInbound({
      channel: "whatsapp",
      from: "owner@s.whatsapp.net",
      text: "/loop Revisa todos los PRs abiertos y ciérralos uno por uno",
      timestamp: new Date(),
    });
    expect(submitTask).toHaveBeenCalledTimes(1);
    const sub = vi.mocked(submitTask).mock.calls[0][0];
    expect(sub.title).toBe(
      "Chat: Revisa todos los PRs abiertos y ciérralos uno por uno",
    );
    expect(sub.agentType).toBe("fast");
    expect(sub.unlimited).toBe(true);
    expect(sub.tags).toContain("loop");
    const last = sub.conversationHistory?.at(-1);
    expect(last?.role).toBe("user");
    expect(last?.content).toContain("[MODO /loop");
    expect(last?.content).not.toContain("/loop Revisa");
  });

  it("a bare `/loop` answers the usage line and creates no task", async () => {
    await router.handleInbound({
      channel: "whatsapp",
      from: "owner@s.whatsapp.net",
      text: "/loop",
      timestamp: new Date(),
    });
    expect(submitTask).not.toHaveBeenCalled();
    expect(waAdapter.sentMessages[0].text).toMatch(/^Uso: \/loop/);
  });

  it("without the prefix nothing changes: auto routing, no unlimited flag, no loop tag", async () => {
    await router.handleInbound({
      channel: "whatsapp",
      from: "owner@s.whatsapp.net",
      text: "Revisa todos los PRs abiertos y ciérralos uno por uno",
      timestamp: new Date(),
    });
    expect(submitTask).toHaveBeenCalledTimes(1);
    const sub = vi.mocked(submitTask).mock.calls[0][0];
    expect(sub.agentType).toBe("auto");
    expect(sub.unlimited).toBe(false);
    expect(sub.tags).not.toContain("loop");
    expect(sub.conversationHistory?.at(-1)?.content).not.toContain(
      "[MODO /loop",
    );
  });
});

describe("/loop — surfaces, gating and the abort registry (qa-audit R1 folds)", () => {
  let router: MessageRouter;
  let waAdapter: ReturnType<typeof createMockAdapter>;
  let tgAdapter: ReturnType<typeof createMockAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    subscribers.length = 0;
    _resetThreadPins();
    process.env.WHATSAPP_OWNER_JID = "owner@s.whatsapp.net";
    process.env.TELEGRAM_OWNER_CHAT_ID = "12345";
    router = new MessageRouter();
    waAdapter = createMockAdapter("whatsapp");
    tgAdapter = createMockAdapter("telegram");
    router.registerChannel(waAdapter);
    router.registerChannel(tgAdapter);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.TELEGRAM_OWNER_CHAT_ID;
  });

  it("Telegram, slash-less `loop <tarea>` (the adapter drops `/`-messages) → unlimited task", async () => {
    await router.handleInbound({
      channel: "telegram",
      from: "12345",
      text: "loop Revisa todos los PRs abiertos y ciérralos uno por uno",
      timestamp: new Date(),
    });
    expect(submitTask).toHaveBeenCalledTimes(1);
    const sub = vi.mocked(submitTask).mock.calls[0][0];
    expect(sub.unlimited).toBe(true);
    expect(sub.agentType).toBe("fast");
    expect(sub.title).toBe(
      "Chat: Revisa todos los PRs abiertos y ciérralos uno por uno",
    );
  });

  it("WhatsApp group from the owner: the `[Grupo:]` header is kept, the prefix behind it is stripped", async () => {
    await router.handleInbound({
      channel: "whatsapp",
      from: "group@g.us",
      text: "[Grupo: group@g.us, De: owner]\nloop Cierra los PRs abiertos",
      timestamp: new Date(),
      metadata: {
        isGroup: true,
        groupJid: "group@g.us",
        senderJid: "owner@s.whatsapp.net",
      },
    });
    expect(submitTask).toHaveBeenCalledTimes(1);
    const sub = vi.mocked(submitTask).mock.calls[0][0];
    expect(sub.unlimited).toBe(true);
    expect(sub.detectionText).toMatch(
      /^\[Grupo: group@g\.us, De: owner\]\s*Cierra los PRs abiertos$/,
    );
  });

  it("a group MEMBER's `loop …` never becomes an unlimited task", async () => {
    await router.handleInbound({
      channel: "whatsapp",
      from: "group@g.us",
      text: "[Grupo: group@g.us, De: member]\nloop Cierra los PRs abiertos",
      timestamp: new Date(),
      metadata: {
        isGroup: true,
        groupJid: "group@g.us",
        senderJid: "member@s.whatsapp.net",
      },
    });
    for (const call of vi.mocked(submitTask).mock.calls) {
      expect(call[0].unlimited).not.toBe(true);
      expect(call[0].tags ?? []).not.toContain("loop");
    }
  });

  it("a /loop task is NEVER abandoned: 21 min later the abort registry still holds it, a nudge was sent, no 'Se agotó'", async () => {
    vi.useFakeTimers();
    await router.handleInbound({
      channel: "whatsapp",
      from: "owner@s.whatsapp.net",
      text: "loop Revisa todos los PRs abiertos y ciérralos",
      timestamp: new Date(),
    });
    await vi.advanceTimersByTimeAsync(21 * 60_000);
    const pending = (
      router as unknown as { pendingReplies: Map<string, unknown> }
    ).pendingReplies;
    expect(pending.has("test-task-123")).toBe(true);
    const texts = waAdapter.sentMessages.map((m) => m.text);
    expect(texts.some((t) => t.startsWith("Se agotó el tiempo"))).toBe(false);
    expect(texts.some((t) => t.startsWith("Sigo en /loop"))).toBe(true);
  });

  it("a normal task still abandons at 11 min (the registry entry is released)", async () => {
    vi.useFakeTimers();
    await router.handleInbound({
      channel: "whatsapp",
      from: "owner@s.whatsapp.net",
      text: "Revisa todos los PRs abiertos y ciérralos",
      timestamp: new Date(),
    });
    await vi.advanceTimersByTimeAsync(12 * 60_000);
    const pending = (
      router as unknown as { pendingReplies: Map<string, unknown> }
    ).pendingReplies;
    expect(pending.has("test-task-123")).toBe(false);
    const texts = waAdapter.sentMessages.map((m) => m.text);
    expect(texts.some((t) => t.startsWith("Se agotó el tiempo"))).toBe(true);
  });
});
