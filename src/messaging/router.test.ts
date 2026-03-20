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

import { MessageRouter } from "./router.js";
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
      // COMMIT read tools always present
      expect(call.tools).toContain("commit__get_daily_snapshot");
      expect(call.tools).toContain("commit__list_tasks");
      // Misc always present
      expect(call.tools).toContain("http_fetch");
      expect(call.tools).toContain("chart_generate");
      // Should NOT include heavy groups for a simple greeting
      expect(call.tools).not.toContain("browser__goto");
      expect(call.tools).not.toContain("shell_exec");
      expect(call.tools).not.toContain("gmail_send");
      expect(call.tools).not.toContain("commit__create_task");
    });

    it("should activate COMMIT write + coding tools when keywords present", async () => {
      const msg: IncomingMessage = {
        channel: "whatsapp",
        from: "owner@s.whatsapp.net",
        text: "crea una tarea para hacer deploy del servidor",
        timestamp: new Date(),
      };

      await router.handleInbound(msg);

      const call = (submitTask as any).mock.calls[0][0];
      // COMMIT write tools activated by "crea una tarea"
      expect(call.tools).toContain("commit__create_task");
      expect(call.tools).toContain("commit__update_task");
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
      expect(lastTurn).toEqual({ role: "user", content: "Hola" });
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

    it("should send timeout notice after 300s", async () => {
      const msg: IncomingMessage = {
        channel: "whatsapp",
        from: "owner@s.whatsapp.net",
        text: "test",
        timestamp: new Date(),
      };
      await router.handleInbound(msg);

      vi.advanceTimersByTime(300_001);

      // [0] = ack, [1] = interim (120s), [2] = timeout (300s)
      expect(waAdapter.sentMessages).toHaveLength(3);
      expect(waAdapter.sentMessages[2].text).toContain("Se agotó el tiempo");
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
});
