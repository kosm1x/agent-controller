/**
 * Confirmation gate on the Claude SDK path (2026-09-29): `wrapTool` — the MCP
 * bridge handler every SDK tool call runs through — applies the ONE
 * confirmation gate (task-executor.ts) before `toolRegistry.execute`.
 * Before this, the SDK path (`permissionMode: "dontAsk"`) never asked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (name: string, desc: string, shape: unknown, handler: unknown) => ({
    name,
    desc,
    shape,
    handler,
  }),
  createSdkMcpServer: (config: unknown) => ({ type: "mcp", config }),
  query: vi.fn(),
}));

const reg = vi.hoisted(() => ({
  tiers: {} as Record<string, "low" | "medium" | "high">,
  execute: vi.fn(async (name: string) => JSON.stringify({ ok: true, name })),
}));
vi.mock("../tools/registry.js", () => ({
  toolRegistry: {
    get: () => undefined,
    execute: reg.execute,
    getEffectiveRiskTier: (name: string) => reg.tiers[name] ?? "low",
  },
}));

const emitTraceMock = vi.hoisted(() => vi.fn());
vi.mock("../observability/task-trace.js", () => ({
  emitTraceEvent: emitTraceMock,
}));
vi.mock("../lib/v8-4/stop-hook.js", () => ({ makeGatesStopHook: () => null }));
vi.mock("../config.js", () => ({
  getConfig: () => ({ budgetEnabled: false, budgetEnforce: false }),
}));

import { wrapToolCached } from "./claude-sdk.js";
import {
  TaskExecutionContext,
  currentExecutionContext,
  runWithExecutionContext,
  runnerExecutionContext,
  type ConfirmationFacts,
} from "./execution-context.js";
import {
  enterRunToolContext,
  outsideRunToolContext,
  type RunOrigin,
} from "../tools/rule-of-two.js";
import {
  NO_CONFIRM_CHANNEL_ERROR,
  NO_CONFIRM_IN_CHAT_ERROR,
  NO_CONFIRM_A2A_ERROR,
} from "../tools/task-executor.js";
import type { Tool } from "../tools/types.js";

const OPERATOR: RunOrigin = { source: "operator", threadId: "telegram:1" };
const BACKGROUND: RunOrigin = { source: "background", threadId: "background" };

function makeTool(name: string): Tool {
  return {
    name,
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
    definition: {
      type: "function",
      function: {
        name,
        description: `${name} test tool`,
        parameters: { type: "object", properties: {} },
      },
    },
    execute: vi.fn(),
  };
}

type Handler = (
  args: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }> }>;

const tools = new Map<string, Tool>();
function call(name: string, args: Record<string, unknown> = {}) {
  let t = tools.get(name);
  if (!t) {
    t = makeTool(name);
    tools.set(name, t);
  }
  const wrapped = wrapToolCached(t) as unknown as { handler: Handler };
  return wrapped.handler(args).then((r) => r.content[0].text);
}

/** Run `fn` as a dispatcher run (origin) with `ctx` entered (or none). */
function inRun<T>(
  origin: RunOrigin,
  ctx: TaskExecutionContext | null,
  fn: () => Promise<T>,
): Promise<T> {
  return enterRunToolContext(
    ctx?.taskId ?? "task-x",
    () => (ctx ? runWithExecutionContext(ctx, fn) : fn()),
    origin,
  );
}

/** The fast runner's context on a router-tracked operator chat root. */
const fastChatRoot = (taskId: string) =>
  new TaskExecutionContext(taskId, true, {
    routerRoot: true,
    canAskOperator: true,
    chatOrigin: true,
  });

/** What the dispatcher enters around a runner (never asks by itself). */
const dispatcherCtx = (
  taskId: string,
  interactive: boolean,
  facts: ConfirmationFacts,
) => new TaskExecutionContext(taskId, interactive, facts);

beforeEach(() => {
  reg.execute.mockClear();
  emitTraceMock.mockReset();
  reg.tiers = {
    wp_delete: "high",
    gmail_send: "high",
    google_workspace_cli: "high",
    web_search: "low",
  };
});

describe("wrapTool confirmation gate (claude-sdk path)", () => {
  it("runs a low-risk tool in an interactive chat run", async () => {
    const ctx = fastChatRoot("t-low");
    const text = await inRun(OPERATOR, ctx, () =>
      call("web_search", { q: "x" }),
    );
    expect(reg.execute).toHaveBeenCalledWith("web_search", { q: "x" });
    expect(JSON.parse(text)).toEqual({ ok: true, name: "web_search" });
    expect(ctx.getPendingConfirmation()).toBeNull();
  });

  it("does NOT execute a high-risk tool in an interactive chat run; stores the pending action", async () => {
    const ctx = fastChatRoot("t-chat");
    const text = await inRun(OPERATOR, ctx, () => call("wp_delete", { id: 7 }));
    expect(reg.execute).not.toHaveBeenCalled();
    const parsed = JSON.parse(text);
    expect(parsed.error).toBe("CONFIRMATION_REQUIRED");
    expect(parsed.tool).toBe("wp_delete");
    expect(parsed.message).toContain("NO se ejecutó");
    expect(ctx.getPendingConfirmation()).toEqual({
      toolName: "wp_delete",
      args: { id: 7 },
    });
    expect(ctx.getGatedCalls()).toEqual(["wp_delete"]);
    expect(emitTraceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "t-chat",
        name: "tool.gated",
        tool: "wp_delete",
        attrs: { decision: "confirmation_required", origin: "operator" },
      }),
    );
  });

  it("first pending wins: a second gated call is refused and not executed", async () => {
    const ctx = fastChatRoot("t-two");
    await inRun(OPERATOR, ctx, () => call("wp_delete", { id: 7 }));
    const second = await inRun(OPERATOR, ctx, () =>
      call("gmail_send", { to: "a@b.com" }),
    );
    expect(reg.execute).not.toHaveBeenCalled();
    expect(JSON.parse(second).error).toContain(
      "Ya hay una confirmación pendiente",
    );
    expect(ctx.getPendingConfirmation()?.toolName).toBe("wp_delete");
    expect(ctx.getGatedCalls()).toEqual(["wp_delete", "gmail_send"]);
  });

  it("background populations (ritual, scheduled, cron, retry of either) execute high-risk tools exactly as before", async () => {
    // The dispatcher context for every non-interactive shape, on any runner.
    for (const facts of [
      {},
      { chatOrigin: true },
      { routerRoot: true, chatOrigin: true },
    ]) {
      const ctx = dispatcherCtx("t-cron", false, facts);
      const text = await inRun(BACKGROUND, ctx, () =>
        call("gmail_send", { to: "a@b.com" }),
      );
      expect(JSON.parse(text).ok).toBe(true);
      // ...and the fast runner's own context inherits interactive=false.
      const fast = await inRun(BACKGROUND, ctx, () =>
        runWithExecutionContext(runnerExecutionContext("t-cron", true), () =>
          call("wp_delete", { id: 9 }),
        ),
      );
      expect(JSON.parse(fast).ok).toBe(true);
    }
    expect(reg.execute).toHaveBeenCalledTimes(6);
    expect(emitTraceMock).not.toHaveBeenCalled();
  });

  it("R6: an interactive API task (no chat) is refused with the API hint, not executed", async () => {
    const ctx = runnerExecutionContext("t-api", true); // outside a dispatched chat
    const text = await inRun(BACKGROUND, ctx, () =>
      call("wp_delete", { id: 7 }),
    );
    expect(reg.execute).not.toHaveBeenCalled();
    expect(JSON.parse(text)).toEqual({ error: NO_CONFIRM_CHANNEL_ERROR });
    expect(ctx.getPendingConfirmation()).toBeNull();
  });

  it("C2: a heavy/swarm/Prometheus run (dispatcher context only) refuses — even an operator chat root — and never stores a pending", async () => {
    for (const [facts, error] of [
      [{ routerRoot: true, chatOrigin: true }, NO_CONFIRM_IN_CHAT_ERROR],
      [{}, NO_CONFIRM_CHANNEL_ERROR],
    ] as const) {
      const ctx = dispatcherCtx("t-heavy", true, facts);
      const text = await inRun(OPERATOR, ctx, () =>
        call("gmail_send", { to: "a@b.com" }),
      );
      expect(JSON.parse(text)).toEqual({ error });
      expect(ctx.getPendingConfirmation()).toBeNull();
    }
    expect(reg.execute).not.toHaveBeenCalled();
    expect(emitTraceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "t-heavy",
        name: "tool.gated",
        attrs: { decision: "refused_cannot_ask", origin: "operator" },
      }),
    );
  });

  it("W3: the fast runner asks only on a router root; a sub-task or retry of a chat task refuses (generic text) instead of asking into a dropped output", async () => {
    const child = dispatcherCtx("t-child", true, { chatOrigin: true });
    const refused = await inRun(OPERATOR, child, () =>
      runWithExecutionContext(runnerExecutionContext("t-child", true), () =>
        call("wp_delete", { id: 7 }),
      ),
    );
    expect(JSON.parse(refused)).toEqual({ error: NO_CONFIRM_IN_CHAT_ERROR });
    expect(refused).not.toContain("interactive");

    const root = dispatcherCtx("t-root", true, {
      routerRoot: true,
      chatOrigin: true,
    });
    const fast = runnerExecutionContext("t-root", true);
    const asked = await inRun(OPERATOR, root, () =>
      runWithExecutionContext(runnerExecutionContext("t-root", true), () =>
        call("wp_delete", { id: 7 }),
      ),
    );
    expect(JSON.parse(asked).error).toBe("CONFIRMATION_REQUIRED");
    expect(fast.canAskOperator).toBe(false); // built outside the run
    expect(reg.execute).not.toHaveBeenCalled();
  });

  it("round 3: an A2A task's fast runner refuses with the A2A text (the fact reaches the runner's own context)", async () => {
    const a2a = dispatcherCtx("t-a2a", true, { a2aOrigin: true });
    const text = await inRun(BACKGROUND, a2a, () =>
      runWithExecutionContext(runnerExecutionContext("t-a2a", true), () =>
        call("gmail_send", { to: "a@b.com" }),
      ),
    );
    expect(JSON.parse(text)).toEqual({ error: NO_CONFIRM_A2A_ERROR });
    expect(reg.execute).not.toHaveBeenCalled();
  });

  it("fail closed: a dispatched run with no execution context does not execute a high-risk tool (either origin)", async () => {
    for (const origin of [OPERATOR, BACKGROUND]) {
      const text = await inRun(origin, null, () =>
        call("wp_delete", { id: 7 }),
      );
      expect(JSON.parse(text)).toEqual({ error: NO_CONFIRM_IN_CHAT_ERROR });
    }
    expect(reg.execute).not.toHaveBeenCalled();
    expect(emitTraceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "tool.gated",
        attrs: { decision: "refused_no_context", origin: "operator" },
      }),
    );
  });

  it("outside any dispatched run (no run, no context) proceeds as before", async () => {
    await call("gmail_send", { to: "a@b.com" });
    expect(reg.execute).toHaveBeenCalledTimes(1);
  });

  it("no execution context still runs a low-risk tool", async () => {
    await inRun(OPERATOR, null, () => call("web_search", { q: "x" }));
    expect(reg.execute).toHaveBeenCalledTimes(1);
  });

  it("N1: outsideRunToolContext exits the execution context too", async () => {
    const ctx = fastChatRoot("t-n1");
    const inside = await inRun(OPERATOR, ctx, async () =>
      outsideRunToolContext(() => currentExecutionContext()),
    );
    expect(inside).toBeUndefined();
  });

  it("R2 + C1: google_workspace_cli plain read runs; write, unknown and flag-smuggled calls ask", async () => {
    const ctx = fastChatRoot("t-gws");
    await inRun(OPERATOR, ctx, () =>
      call("google_workspace_cli", {
        service: "people",
        resource: "people.connections",
        method: "list",
      }),
    );
    expect(reg.execute).toHaveBeenCalledTimes(1);

    for (const args of [
      { service: "chat", resource: "spaces.messages", method: "create" },
      { service: "tasks", resource: "tasks", method: "move" },
      {
        service: "chat",
        resource: "+send.--space.spaces/AAAA.--text",
        method: "list",
      },
    ]) {
      const fresh = fastChatRoot("t-gws-ask");
      const text = await inRun(OPERATOR, fresh, () =>
        call("google_workspace_cli", args),
      );
      expect(JSON.parse(text).error).toBe("CONFIRMATION_REQUIRED");
    }
    expect(reg.execute).toHaveBeenCalledTimes(1);
  });
});

describe("wrapTool external guard (jarvis-pull on the claude-sdk path)", () => {
  const external = (taskId: string) =>
    new TaskExecutionContext(taskId, true, {}, [
      "jarvis_file_read",
      "jarvis_file_list",
      "web_search",
    ]);

  it("refuses a tool outside the run's list without executing it", async () => {
    const text = await inRun(BACKGROUND, external("t-ext1"), () =>
      call("memory_search", { query: "x" }),
    );
    expect(JSON.parse(text)).toEqual({ error: "tool not available on this path" });
    expect(reg.execute).not.toHaveBeenCalled();
  });

  it("refuses a malformed jarvis_file_read path without executing it", async () => {
    const text = await inRun(BACKGROUND, external("t-ext2"), () =>
      call("jarvis_file_read", { path: "projects/expansion-crm/../../INDEX.md" }),
    );
    expect(JSON.parse(text)).toEqual({ error: "path not available on this path" });
    expect(reg.execute).not.toHaveBeenCalled();
  });

  it("refuses an untagged private row returned by jarvis_file_read", async () => {
    reg.execute.mockImplementationOnce(async () =>
      JSON.stringify({ path: "knowledge/health/x.md", content: "PRIVATE", tags: [] }),
    );
    const text = await inRun(BACKGROUND, external("t-ext2b"), () =>
      call("jarvis_file_read", { path: "knowledge/health/x.md" }),
    );
    expect(JSON.parse(text)).toEqual({ error: "path not available on this path" });
    expect(text).not.toContain("PRIVATE");
  });

  it("filters private paths out of a jarvis_file_list result (runs at max limit)", async () => {
    reg.execute.mockImplementationOnce(async () =>
      [
        "📂 **2 files**",
        "  knowledge/people/someone.md (1K, always-read)",
        "  knowledge/domain/tv-tarifas.md (3K, reference)",
      ].join("\n"),
    );
    const text = await inRun(BACKGROUND, external("t-ext3"), () =>
      call("jarvis_file_list", { prefix: "knowledge/", limit: 1 }),
    );
    expect(reg.execute).toHaveBeenCalledWith("jarvis_file_list", {
      prefix: "knowledge/",
      limit: 500,
    });
    expect(text).toContain("knowledge/domain/tv-tarifas.md");
    expect(text).not.toContain("knowledge/people/");
    expect(text.split("\n")[0]).toBe("📂 **1 files**");
  });

  it("a run without externalTools is unaffected", async () => {
    const text = await inRun(BACKGROUND, new TaskExecutionContext("t-int", true), () =>
      call("memory_search", { query: "x" }),
    );
    expect(JSON.parse(text)).toEqual({ ok: true, name: "memory_search" });
  });
});
