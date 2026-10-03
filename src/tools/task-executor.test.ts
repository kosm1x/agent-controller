import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createTaskExecutor,
  argsFingerprint,
  confirmationGate,
  highRiskScheduledTools,
  noConfirmBackgroundScheduleError,
  noConfirmApiScheduleError,
  undeclaredToolError,
  NO_CONFIRM_CHANNEL_ERROR,
  NO_CONFIRM_IN_CHAT_ERROR,
  NO_CONFIRM_A2A_ERROR,
} from "./task-executor.js";
import { TaskExecutionContext } from "../inference/execution-context.js";

// Ruling 2026-10-03: the undeclared-tool refusal is a trace event.
const traceMock = vi.hoisted(() => ({ emitTraceEvent: vi.fn() }));
vi.mock("../observability/task-trace.js", () => traceMock);

/** The fast runner's context on a router-tracked operator chat root. */
const askable = (taskId: string) =>
  new TaskExecutionContext(taskId, true, {
    routerRoot: true,
    canAskOperator: true,
    chatOrigin: true,
  });

afterEach(() => {
  vi.restoreAllMocks();
});

function mockRegistry() {
  return {
    execute: vi.fn().mockResolvedValue('{"ok": true}'),
    getEffectiveRiskTier: vi.fn().mockReturnValue("low"),
    isDestructiveMcp: vi.fn().mockReturnValue(false),
  } as unknown as import("./registry.js").ToolRegistry;
}

describe("createTaskExecutor", () => {
  it("delegates normal tool calls to registry", async () => {
    const registry = mockRegistry();
    const ctx = new TaskExecutionContext("task-1");
    const executor = createTaskExecutor(registry, ctx);

    const result = await executor("web_search", { q: "test" });
    expect(result).toBe('{"ok": true}');
    expect(registry.execute).toHaveBeenCalledWith("web_search", { q: "test" });
  });

  it("passes through tools not in DESTRUCTIVE_MCP_TOOLS", async () => {
    const registry = mockRegistry();
    const ctx = new TaskExecutionContext("task-1");
    const executor = createTaskExecutor(registry, ctx);

    const result = await executor("file_delete", { path: "/tmp/x" });
    expect(result).toBe('{"ok": true}');
    expect(registry.execute).toHaveBeenCalled();
  });

  it("enforces memory store rate limit via context", async () => {
    const registry = mockRegistry();
    const ctx = new TaskExecutionContext("task-1");
    const executor = createTaskExecutor(registry, ctx);

    // First 5 stores succeed
    for (let i = 0; i < 5; i++) {
      const result = await executor("memory_store", { content: `fact ${i}` });
      expect(result).toBe('{"ok": true}');
    }

    // 6th is rate-limited (not delegated to registry)
    const result = await executor("memory_store", { content: "too many" });
    expect(result).toContain("limit reached");
    expect(registry.execute).toHaveBeenCalledTimes(5); // not 6
  });

  it("isolates memory rate limits between tasks", async () => {
    const registry = mockRegistry();
    const ctxA = new TaskExecutionContext("task-a");
    const ctxB = new TaskExecutionContext("task-b");

    const execA = createTaskExecutor(registry, ctxA);
    const execB = createTaskExecutor(registry, ctxB);

    // Exhaust A's limit
    for (let i = 0; i < 5; i++)
      await execA("memory_store", { content: `a${i}` });
    expect(await execA("memory_store", { content: "blocked" })).toContain(
      "limit reached",
    );

    // B is unaffected
    expect(await execB("memory_store", { content: "b0" })).toBe('{"ok": true}');
  });
});

// ---------------------------------------------------------------------------
// Pre-flight verification (v6.4 H2)
// ---------------------------------------------------------------------------

describe("checkPreflight via createTaskExecutor", () => {
  it("rejects gmail_send with invalid email", async () => {
    const reg = mockRegistry();
    const ctx = new TaskExecutionContext("t1");
    const exec = createTaskExecutor(reg, ctx);

    const result = await exec("gmail_send", {
      to: "not-an-email",
      subject: "Test",
      body: "This is a valid body for the email.",
    });
    expect(result).toContain("invalid email");
    expect(reg.execute).not.toHaveBeenCalled();
  });

  it("rejects gmail_send with short body", async () => {
    const reg = mockRegistry();
    const ctx = new TaskExecutionContext("t2");
    const exec = createTaskExecutor(reg, ctx);

    const result = await exec("gmail_send", {
      to: "test@example.com",
      subject: "Test",
      body: "Hi",
    });
    expect(result).toContain("too short");
    expect(reg.execute).not.toHaveBeenCalled();
  });

  it("allows gmail_send with valid email and body", async () => {
    const reg = mockRegistry();
    const ctx = new TaskExecutionContext("t3");
    const exec = createTaskExecutor(reg, ctx);

    const result = await exec("gmail_send", {
      to: "test@example.com",
      subject: "Test",
      body: "This is a complete email body with enough content.",
    });
    expect(result).toBe('{"ok": true}');
    expect(reg.execute).toHaveBeenCalledOnce();
  });

  it("rejects git_push with non-existent cwd", async () => {
    const reg = mockRegistry();
    const ctx = new TaskExecutionContext("t4");
    const exec = createTaskExecutor(reg, ctx);

    const result = await exec("git_push", {
      cwd: "/nonexistent/path/abc123",
    });
    expect(result).toContain("does not exist");
    expect(reg.execute).not.toHaveBeenCalled();
  });

  it("passes through tools without preflight checks", async () => {
    const reg = mockRegistry();
    const ctx = new TaskExecutionContext("t5");
    const exec = createTaskExecutor(reg, ctx);

    const result = await exec("web_search", { query: "test" });
    expect(result).toBe('{"ok": true}');
    expect(reg.execute).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Confirmation gate: interactive vs non-interactive
// ---------------------------------------------------------------------------

describe("confirmation gate bypass for non-interactive tasks", () => {
  it("blocks high-risk tools in interactive context", async () => {
    const reg = mockRegistry();
    (reg.getEffectiveRiskTier as ReturnType<typeof vi.fn>).mockReturnValue(
      "high",
    );
    // A router-tracked operator chat root on the fast runner.
    const ctx = askable("task-interactive");
    const exec = createTaskExecutor(reg, ctx);

    const result = await exec("gmail_send", {
      to: "test@example.com",
      subject: "Test",
      body: "A complete email body with enough content to pass preflight.",
    });
    expect(result).toContain("CONFIRMATION_REQUIRED");
    expect(reg.execute).not.toHaveBeenCalled();
    expect(ctx.getPendingConfirmation()).not.toBeNull();
    expect(ctx.getPendingConfirmation()!.toolName).toBe("gmail_send");
  });

  // Combined audit 2026-10-03 (should-fix 3): no card for a call the
  // registry would refuse after the approval.
  it("a high-risk call carrying a rendered placeholder is refused before the card", async () => {
    const reg = mockRegistry();
    (reg.getEffectiveRiskTier as ReturnType<typeof vi.fn>).mockReturnValue(
      "high",
    );
    const ctx = askable("task-ph");
    const exec = createTaskExecutor(reg, ctx);
    const ph =
      "[oculto · úsalo por nombre: $SECRET_DEMO_X en shell_exec, {{SECRET_DEMO_X}} en http_fetch/navegador]";
    const result = await exec("gmail_send", {
      to: "test@example.com",
      subject: "Test",
      body: `A complete email body with the key ${ph} inside it.`,
    });
    expect(JSON.parse(result).error).toMatch(
      /^No ejecuté gmail_send: los argumentos contienen un dato oculto/,
    );
    expect(result).not.toContain("CONFIRMATION_REQUIRED");
    expect(reg.execute).not.toHaveBeenCalled();
    expect(ctx.getPendingConfirmation()).toBeNull();
    expect(traceMock.emitTraceEvent).toHaveBeenCalledWith({
      taskId: "task-ph",
      name: "tool.secret_ref_refused",
      tool: "gmail_send",
      attrs: { tool: "gmail_send", reason: "rendered_placeholder", stage: "pre_gate" },
    });
  });

  it("allows high-risk tools in non-interactive context (scheduled tasks)", async () => {
    const reg = mockRegistry();
    (reg.getEffectiveRiskTier as ReturnType<typeof vi.fn>).mockReturnValue(
      "high",
    );
    const ctx = new TaskExecutionContext("task-scheduled", false);
    const exec = createTaskExecutor(reg, ctx);

    const result = await exec("gmail_send", {
      to: "test@example.com",
      subject: "Test",
      body: "A complete email body with enough content to pass preflight.",
    });
    expect(result).toBe('{"ok": true}');
    expect(reg.execute).toHaveBeenCalledOnce();
    expect(ctx.getPendingConfirmation()).toBeNull();
  });

  it("defaults to interactive=true when not specified", () => {
    const ctx = new TaskExecutionContext("task-default");
    expect(ctx.interactive).toBe(true);
  });

  it("R6: refuses a high-risk tool in an interactive run with no chat thread (API task)", async () => {
    const reg = mockRegistry();
    (reg.getEffectiveRiskTier as ReturnType<typeof vi.fn>).mockReturnValue(
      "high",
    );
    const ctx = new TaskExecutionContext("task-api", true);
    const exec = createTaskExecutor(reg, ctx);

    const result = await exec("wp_delete", { id: 7 });
    expect(JSON.parse(result)).toEqual({ error: NO_CONFIRM_CHANNEL_ERROR });
    expect(reg.execute).not.toHaveBeenCalled();
    expect(ctx.getPendingConfirmation()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// confirmationGate — the one gate (task-executor + claude-sdk wrapTool)
// ---------------------------------------------------------------------------

describe("confirmationGate", () => {
  const reg = (tier: "low" | "medium" | "high") => ({
    getEffectiveRiskTier: vi.fn().mockReturnValue(tier),
  });
  const interactive = askable("g");
  const background = new TaskExecutionContext("g", false);
  const gws = (args: Record<string, unknown>) =>
    confirmationGate(reg("high"), interactive, "google_workspace_cli", args);

  it("proceeds for low- and medium-risk tools", () => {
    for (const tier of ["low", "medium"] as const) {
      expect(
        confirmationGate(reg(tier), interactive, "web_search", {}),
      ).toEqual({ action: "proceed" });
    }
  });

  it("asks for a high-risk tool when the context can ask (router-tracked operator root)", () => {
    expect(confirmationGate(reg("high"), interactive, "wp_delete", {})).toEqual(
      { action: "confirm" },
    );
  });

  it("proceeds for a non-interactive run (scheduled/ritual), whatever else it is", () => {
    expect(confirmationGate(reg("high"), background, "gmail_send", {})).toEqual(
      { action: "proceed" },
    );
    const bgChat = new TaskExecutionContext("g", false, {
      routerRoot: true,
      chatOrigin: true,
    });
    expect(confirmationGate(reg("high"), bgChat, "gmail_send", {})).toEqual({
      action: "proceed",
    });
  });

  it("R6: refuses an interactive run that cannot ask — API hint only without a chat origin (S3)", () => {
    const api = new TaskExecutionContext("g", true);
    expect(confirmationGate(reg("high"), api, "wp_delete", {})).toEqual({
      action: "refuse",
      error: NO_CONFIRM_CHANNEL_ERROR,
    });
    // A chat run that cannot ask (non-owner sender, sub-task, retry, a
    // runner that does not surface the ask): generic, no `interactive` hint.
    for (const facts of [
      { chatOrigin: true },
      { chatOrigin: true, routerRoot: true },
    ]) {
      const decision = confirmationGate(
        reg("high"),
        new TaskExecutionContext("g", true, facts),
        "wp_delete",
        {},
      );
      expect(decision).toEqual({
        action: "refuse",
        error: NO_CONFIRM_IN_CHAT_ERROR,
      });
      expect(JSON.stringify(decision)).not.toContain("interactive");
    }
  });

  it("round 3: an A2A task is refused with its own text — no interactive:false hint a peer cannot act on", () => {
    const decision = confirmationGate(
      reg("high"),
      new TaskExecutionContext("g", true, { a2aOrigin: true }),
      "gmail_send",
      { to: "a@b.com" },
    );
    expect(decision).toEqual({ action: "refuse", error: NO_CONFIRM_A2A_ERROR });
    expect(NO_CONFIRM_A2A_ERROR).toBe(
      "Esta acción de alto riesgo requiere la confirmación del operador y una tarea A2A no tiene dónde pedirla. No se ejecutó.",
    );
    expect(JSON.stringify(decision)).not.toContain("interactive");
  });

  it("R2: google_workspace_cli plain read calls run without asking", () => {
    for (const method of [
      "list",
      "get",
      "search",
      "batchGet",
      "--help",
      "listDirectoryPeople",
      "searchContacts",
      "getBatchGet",
      "getByDataFilter",
    ]) {
      expect(gws({ service: "people", resource: "people", method })).toEqual({
        action: "proceed",
      });
    }
    expect(
      gws({ service: "chat", resource: "spaces.messages", method: "list" }),
    ).toEqual({ action: "proceed" });
    // Service-level introspection: an empty resource adds no argv word.
    expect(gws({ service: "chat", resource: "", method: "--help" })).toEqual({
      action: "proceed",
    });
    // params travel as ONE --params JSON word — still a read.
    expect(
      gws({
        service: "tasks",
        resource: "tasklists",
        method: "list",
        params: { maxResults: 5 },
      }),
    ).toEqual({ action: "proceed" });
  });

  it("R2: google_workspace_cli write, unrecognised and malformed methods ask", () => {
    for (const method of [
      "create",
      "insert",
      "patch",
      "delete",
      "send",
      "listing",
      "getandset",
      "GET",
      " list",
      "list;delete",
      "list --page-all",
      "frobnicate",
    ]) {
      expect(gws({ service: "tasks", resource: "tasks", method })).toEqual({
        action: "confirm",
      });
    }
    // Missing / non-string method → ask.
    expect(gws({ service: "tasks", resource: "tasks" })).toEqual({
      action: "confirm",
    });
    expect(
      gws({ service: "tasks", resource: "tasks", method: ["list"] }),
    ).toEqual({ action: "confirm" });
  });

  it("C1: a read method behind a flag/helper segment or with a json body asks (reproduced bypasses)", () => {
    for (const args of [
      // gws chat +send --space spaces/AAAA --text list → a POST
      {
        service: "chat",
        resource: "+send.--space.spaces/AAAA.--text",
        method: "list",
      },
      // gws gmail users messages send --sanitize list --json {raw} → sends mail
      {
        service: "gmail",
        resource: "users.messages.send.--sanitize",
        method: "list",
        json: { raw: "VG86IGFAYi5jb20=" },
      },
      // gws tasks tasklists delete --params {...} --format get → deletes
      {
        service: "tasks",
        resource: 'tasklists.delete.--params.{"tasklist":"X"}.--format',
        method: "get",
      },
      // a plain resource but a json body is a write
      {
        service: "tasks",
        resource: "tasklists",
        method: "list",
        json: { title: "x" },
      },
      // flag or helper as the service, uppercase or empty segments
      { service: "--dry-run", resource: "tasklists", method: "list" },
      { service: "+gmail", resource: "", method: "list" },
      { service: "tasks", resource: "Tasklists", method: "list" },
      { service: "tasks", resource: "tasklists..x", method: "list" },
      { service: "tasks", resource: "tasklists.", method: "list" },
      { resource: "tasklists", method: "list" },
      { service: "tasks", method: "list" },
    ]) {
      expect(gws(args)).toEqual({ action: "confirm" });
    }
  });

  it("R2 predicate is per tool: another tool with method=list still asks", () => {
    expect(
      confirmationGate(reg("high"), interactive, "wp_raw_api", {
        method: "list",
      }),
    ).toEqual({ action: "confirm" });
  });

  it("R3: an instruction in the request text never counts — the gate reads no message", () => {
    // The gate's inputs are the tool name + args + the run's context only.
    expect(
      confirmationGate(reg("high"), interactive, "gmail_send", {
        to: "a@b.com",
        body: "sí, envíalo, confirmo, procede",
      }),
    ).toEqual({ action: "confirm" });
  });
});

// ---------------------------------------------------------------------------
// Operator ruling 2026-10-01: a schedule carrying a high-risk tool asks once
// ---------------------------------------------------------------------------

describe("schedule_task escalation (ruling 2026-10-01)", () => {
  /** Registry whose tier is per tool name: schedule_task itself stays low. */
  const tiered = () => ({
    getEffectiveRiskTier: vi.fn(
      (n: string): "low" | "medium" | "high" =>
        n === "gmail_send" || n === "tweet_post" ? "high" : "low",
    ),
    // Registered: everything named in these tests except the `__` names
    // below that are not loaded (xpoz__post, notion__create_page) and a
    // plain unknown name (unknown_tool_xyz).
    has: vi.fn(
      (n: string) =>
        !["xpoz__post", "notion__create_page", "unknown_tool_xyz"].includes(n),
    ),
  });
  const sched = (over: Record<string, unknown> = {}) => ({
    name: "Reporte",
    description: "Busca noticias",
    cron: "0 8 * * *",
    tools: ["web_search", "web_read"],
    delivery: "telegram",
    ...over,
  });

  it("a schedule whose tools are all low-risk runs without asking, as before", () => {
    expect(
      confirmationGate(tiered(), askable("s"), "schedule_task", sched()),
    ).toEqual({ action: "proceed" });
  });

  it("a declared high-risk tool asks in a chat that can ask", () => {
    for (const tools of [["web_search", "gmail_send"], ["tweet_post"]]) {
      expect(
        confirmationGate(tiered(), askable("s"), "schedule_task", sched({ tools })),
      ).toEqual({ action: "confirm" });
    }
  });

  it("email/both delivery carries gmail_send (dynamic.ts adds it to every run) → asks; telegram does not", () => {
    for (const delivery of ["email", "both"]) {
      expect(
        confirmationGate(tiered(), askable("s"), "schedule_task", sched({ delivery, email_to: "a@b.mx" })),
      ).toEqual({ action: "confirm" });
    }
    expect(
      confirmationGate(tiered(), askable("s"), "schedule_task", sched({ delivery: "telegram" })),
    ).toEqual({ action: "proceed" });
  });

  it("decided from the tools list only — prompt prose naming a high-risk tool does not ask", () => {
    expect(
      confirmationGate(tiered(), askable("s"), "schedule_task", sched({
        description: "usa gmail_send y tweet_post para avisar",
      })),
    ).toEqual({ action: "proceed" });
  });

  it("fold 1 W1: a background run (scheduled, ritual, batch child, API interactive:false) cannot create a schedule carrying a risky tool", () => {
    for (const bg of [
      new TaskExecutionContext("s", false),
      new TaskExecutionContext("s", false, { routerRoot: true, chatOrigin: true }),
      new TaskExecutionContext("s", false, { a2aOrigin: true }),
    ]) {
      expect(
        confirmationGate(tiered(), bg, "schedule_task", sched({ tools: ["web_search", "gmail_send", "tweet_post"] })),
      ).toEqual({
        action: "refuse",
        error: noConfirmBackgroundScheduleError(["gmail_send", "tweet_post"]),
      });
      expect(
        confirmationGate(tiered(), bg, "schedule_task", sched({ delivery: "email", email_to: "a@b.mx" })),
      ).toEqual({ action: "refuse", error: noConfirmBackgroundScheduleError(["gmail_send"]) });
      // A low-risk schedule, and every other tool, stays `proceed` in the background.
      expect(confirmationGate(tiered(), bg, "schedule_task", sched())).toEqual({ action: "proceed" });
      for (const name of ["gmail_send", "tweet_post", "list_schedules", "batch_decompose"]) {
        expect(
          confirmationGate(tiered(), bg, name, sched({ tools: ["gmail_send"] })),
        ).toEqual({ action: "proceed" });
      }
    }
    // Unlocked does not matter: nobody said "sí" for a background schedule.
    const unlocked = new TaskExecutionContext("s", false);
    unlocked.isDestructiveUnlocked = () => true;
    expect(
      confirmationGate(tiered(), unlocked, "schedule_task", sched({ tools: ["gmail_send"] })).action,
    ).toBe("refuse");
    expect(noConfirmBackgroundScheduleError(["gmail_send", "tweet_post"])).toBe(
      "Un schedule que usa herramientas de alto riesgo (gmail_send, tweet_post) solo puede crearse desde la conversación del operador, donde se confirma. Esta tarea en segundo plano no puede crearlo. No se ejecutó.",
    );
    expect(NO_CONFIRM_CHANNEL_ERROR).not.toBe(noConfirmBackgroundScheduleError(["gmail_send"]));
  });

  it("fold 1 W2: a declared tool-set carrier (schedule_task, batch_decompose) or an unloaded MCP name is risky whatever its tier", () => {
    for (const tools of [
      ["web_search", "schedule_task"],
      ["batch_decompose"],
      ["xpoz__post"],
    ]) {
      expect(
        confirmationGate(tiered(), askable("s"), "schedule_task", sched({ tools })),
      ).toEqual({ action: "confirm" });
    }
    const reg = tiered();
    expect(
      highRiskScheduledTools(reg, {
        tools: ["web_search", "schedule_task", "batch_decompose", "notion__create_page", "xpoz__search", "gmail_send"],
      }),
    ).toEqual(["schedule_task", "batch_decompose", "notion__create_page", "gmail_send"]);
    // The other way: a registered low MCP name and names that merely
    // contain a carrier's name do not ask.
    for (const tools of [
      ["xpoz__search"],
      ["list_schedules", "schedule_task_v2", "batch"],
    ]) {
      expect(highRiskScheduledTools(reg, { tools })).toEqual([]);
      expect(
        confirmationGate(tiered(), askable("s"), "schedule_task", sched({ tools })),
      ).toEqual({ action: "proceed" });
    }
  });

  it("fold 1 chain repro: A carrying schedule_task asks at creation; A's background run cannot then create B carrying gmail_send", () => {
    // Creating A (its runs could create schedules) asks the operator once.
    expect(
      confirmationGate(tiered(), askable("chain"), "schedule_task", sched({ name: "A", tools: ["web_search", "schedule_task"] })),
    ).toEqual({ action: "confirm" });
    // A's cron run is interactive:false: creating B with gmail_send is refused.
    const aRun = new TaskExecutionContext("chain-run", false);
    expect(
      confirmationGate(tiered(), aRun, "schedule_task", sched({ name: "B", tools: ["gmail_send"] })),
    ).toEqual({ action: "refuse", error: noConfirmBackgroundScheduleError(["gmail_send"]) });
    // Nor can it hand B the carrier itself.
    expect(
      confirmationGate(tiered(), aRun, "schedule_task", sched({ name: "B", tools: ["schedule_task"] })).action,
    ).toBe("refuse");
  });

  it("re-audit 2026-10-03: ANY unregistered name is risky at creation, not only MCP-shaped `__` names", () => {
    const reg = tiered();
    expect(highRiskScheduledTools(reg, { tools: ["web_search", "unknown_tool_xyz"] })).toEqual([
      "unknown_tool_xyz",
    ]);
    expect(
      confirmationGate(tiered(), askable("s"), "schedule_task", sched({ tools: ["unknown_tool_xyz"] })),
    ).toEqual({ action: "confirm" });
    expect(
      confirmationGate(tiered(), new TaskExecutionContext("s", false), "schedule_task", sched({ tools: ["unknown_tool_xyz"] })),
    ).toEqual({ action: "refuse", error: noConfirmBackgroundScheduleError(["unknown_tool_xyz"]) });
  });

  it("re-audit 2026-10-03: an API task (no chat, not A2A) creating a risky schedule is NOT told to resubmit with interactive:false", () => {
    const args = sched({ tools: ["gmail_send"] });
    const gate = confirmationGate(tiered(), new TaskExecutionContext("s", true), "schedule_task", args);
    expect(gate).toEqual({ action: "refuse", error: noConfirmApiScheduleError(["gmail_send"]) });
    const error = (gate as { error: string }).error;
    expect(error).not.toContain("interactive: false");
    expect(error).not.toContain("segundo plano");
    expect(error).toBe(
      "Un schedule que usa herramientas de alto riesgo (gmail_send) solo puede crearse desde la conversación del operador, donde se confirma. Esta tarea no tiene esa conversación, así que no puede crearlo (tampoco como tarea no interactiva). No se ejecutó.",
    );
    // A high-risk tool itself (no escalation) keeps the API hint: there,
    // interactive:false is the documented way to run it.
    expect(
      confirmationGate(tiered(), new TaskExecutionContext("s", true), "gmail_send", { to: "a@b.mx" }),
    ).toEqual({ action: "refuse", error: NO_CONFIRM_CHANNEL_ERROR });
  });

  it("an interactive chat / A2A run that cannot ask is refused with the existing texts", () => {
    const args = sched({ tools: ["gmail_send"] });
    expect(
      confirmationGate(tiered(), new TaskExecutionContext("s", true, { chatOrigin: true }), "schedule_task", args),
    ).toEqual({ action: "refuse", error: NO_CONFIRM_IN_CHAT_ERROR });
    expect(
      confirmationGate(tiered(), new TaskExecutionContext("s", true, { a2aOrigin: true }), "schedule_task", args),
    ).toEqual({ action: "refuse", error: NO_CONFIRM_A2A_ERROR });
  });

  it("the escalation is per tool: other tools with the same args are untouched", () => {
    const args = sched({ tools: ["gmail_send"], delivery: "email" });
    for (const name of ["list_schedules", "web_search", "constructor", "toString"]) {
      expect(confirmationGate(tiered(), askable("s"), name, args)).toEqual({
        action: "proceed",
      });
    }
  });

  it("highRiskScheduledTools: registry tier per name, deduped, non-strings ignored", () => {
    const reg = tiered();
    expect(
      highRiskScheduledTools(reg, {
        tools: ["gmail_send", 7, null, "tweet_post", "gmail_send", "web_search"],
        delivery: "both",
      }),
    ).toEqual(["gmail_send", "tweet_post"]);
    expect(highRiskScheduledTools(reg, { tools: "gmail_send" })).toEqual([]);
    expect(highRiskScheduledTools(reg, { delivery: "email" })).toEqual(["gmail_send"]);
  });

  it("a parked schedule_task never reaches the registry (no write, so no read-back gate to fail)", async () => {
    const reg = { ...mockRegistry(), ...tiered() } as unknown as import("./registry.js").ToolRegistry;
    const ctx = askable("s-park");
    const out = JSON.parse(
      await createTaskExecutor(reg, ctx)("schedule_task", sched({ tools: ["gmail_send"] })),
    );
    expect(out.error).toBe("CONFIRMATION_REQUIRED");
    expect(reg.execute).not.toHaveBeenCalled();
    expect(ctx.getPendingConfirmation()?.toolName).toBe("schedule_task");
  });
});

// CCP9: argsFingerprint tests
describe("argsFingerprint", () => {
  it("produces deterministic output for same args", () => {
    const fp1 = argsFingerprint({ to: "a@b.com", subject: "Hello" });
    const fp2 = argsFingerprint({ to: "a@b.com", subject: "Hello" });
    expect(fp1).toBe(fp2);
  });

  it("sorts keys for order independence", () => {
    const fp1 = argsFingerprint({ z: "1", a: "2" });
    const fp2 = argsFingerprint({ a: "2", z: "1" });
    expect(fp1).toBe(fp2);
  });

  it("truncates to 64 chars", () => {
    const fp = argsFingerprint({
      a: "x".repeat(100),
      b: "y".repeat(100),
    });
    expect(fp.length).toBeLessThanOrEqual(64);
  });

  it("handles empty args", () => {
    expect(argsFingerprint({})).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Operator ruling 2026-10-03 (batch_decompose): a background sub-task may not
// reach a high-risk tool or carrier that its run did not declare.
// ---------------------------------------------------------------------------

describe("undeclared high-risk tools in background sub-tasks (ruling 2026-10-03)", () => {
  const reg = () => ({
    getEffectiveRiskTier: vi.fn(
      (n: string): "low" | "medium" | "high" =>
        ["gmail_send", "google_workspace_cli"].includes(n) ? "high" : "low",
    ),
    has: vi.fn((n: string) => n !== "xpoz__post"),
  });
  /** A batch child of a scheduled run that declared `declared`. */
  const child = (declared: string[], interactive = false) =>
    new TaskExecutionContext("child", interactive, {
      inheritedDeclaredTools: declared,
    });

  it("an undeclared gmail_send is refused, naming the tool and the schedule", () => {
    expect(confirmationGate(reg(), child(["web_search"]), "gmail_send", { to: "a@b.mx" })).toEqual({
      action: "refuse",
      error: undeclaredToolError("gmail_send"),
      reason: "undeclared_tool",
    });
    expect(undeclaredToolError("gmail_send")).toBe(
      "La herramienta gmail_send es de alto riesgo y el schedule de esta tarea en segundo plano no la declaró, así que esta sub-tarea no puede usarla. No se ejecutó.",
    );
  });

  it("a declared gmail_send proceeds (the schedule is the authorization, as before)", () => {
    expect(
      confirmationGate(reg(), child(["web_search", "gmail_send"]), "gmail_send", { to: "a@b.mx" }),
    ).toEqual({ action: "proceed" });
  });

  it("nested carriers (batch_decompose, schedule_task) and unregistered names are refused when undeclared", () => {
    for (const name of ["batch_decompose", "schedule_task", "xpoz__post"]) {
      expect(confirmationGate(reg(), child(["web_search"]), name, {})).toMatchObject({
        action: "refuse",
        reason: "undeclared_tool",
        error: undeclaredToolError(name),
      });
    }
    // Declared: a carrier passes this check (schedule_task keeps its own).
    expect(
      confirmationGate(reg(), child(["batch_decompose"]), "batch_decompose", {}),
    ).toEqual({ action: "proceed" });
  });

  it("low-risk undeclared tools, and a read call of a mixed tool, are untouched", () => {
    expect(confirmationGate(reg(), child(["web_search"]), "web_read", {})).toEqual({
      action: "proceed",
    });
    expect(
      confirmationGate(reg(), child(["web_search"]), "google_workspace_cli", {
        service: "gmail",
        resource: "users.messages",
        method: "list",
      }),
    ).toEqual({ action: "proceed" });
    expect(
      confirmationGate(reg(), child(["web_search"]), "google_workspace_cli", {
        service: "gmail",
        resource: "users.messages",
        method: "send",
      }).action,
    ).toBe("refuse");
  });

  it("no inherited list (root run, interactive parent) → background behavior unchanged", () => {
    expect(
      confirmationGate(reg(), new TaskExecutionContext("root", false), "gmail_send", {}),
    ).toEqual({ action: "proceed" });
  });

  it("chat / interactive runs are unchanged even if a list is present", () => {
    const chat = new TaskExecutionContext("c", true, {
      routerRoot: true,
      canAskOperator: true,
      chatOrigin: true,
      inheritedDeclaredTools: ["web_search"],
    });
    expect(confirmationGate(reg(), chat, "gmail_send", {})).toEqual({ action: "confirm" });
    expect(confirmationGate(reg(), chat, "batch_decompose", {})).toEqual({ action: "proceed" });
  });

  it("the executor refuses without running the tool, records the refusal on the run, and traces it", async () => {
    const registry = {
      ...reg(),
      execute: vi.fn().mockResolvedValue('{"ok": true}'),
      isDestructiveMcp: vi.fn().mockReturnValue(false),
    } as unknown as import("./registry.js").ToolRegistry;
    const ctx = child(["web_search"]);
    const out = await createTaskExecutor(registry, ctx)("gmail_send", { to: "a@b.mx" });
    expect(JSON.parse(out)).toEqual({ error: undeclaredToolError("gmail_send") });
    expect(registry.execute).not.toHaveBeenCalled();
    expect(ctx.undeclaredRefusalSink).toEqual(["gmail_send"]);
    expect(traceMock.emitTraceEvent).toHaveBeenCalledWith({
      taskId: "child",
      name: "tool.gated",
      tool: "gmail_send",
      attrs: { decision: "refused_undeclared" },
    });
  });
});
