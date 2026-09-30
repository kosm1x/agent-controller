import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createTaskExecutor,
  argsFingerprint,
  confirmationGate,
  NO_CONFIRM_CHANNEL_ERROR,
  NO_CONFIRM_IN_CHAT_ERROR,
  NO_CONFIRM_A2A_ERROR,
} from "./task-executor.js";
import { TaskExecutionContext } from "../inference/execution-context.js";

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
