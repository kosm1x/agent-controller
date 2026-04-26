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
      // Jarvis file READ tools always-on (NorthStar visions live here)
      expect(call.tools).toContain("jarvis_file_read");
      expect(call.tools).toContain("jarvis_file_list");
      // 2026-04-14: Jarvis file WRITE tools are now scope-gated (jarvis_write
      // group). Generic chat must not carry write capabilities — prevents
      // memory-recalled SOPs from driving silent tool calls. See task 2378.
      expect(call.tools).not.toContain("jarvis_file_write");
      expect(call.tools).not.toContain("jarvis_file_update");
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
});
