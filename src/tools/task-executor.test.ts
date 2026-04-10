import { describe, it, expect, vi, afterEach } from "vitest";
import { createTaskExecutor, argsFingerprint } from "./task-executor.js";
import { TaskExecutionContext } from "../inference/execution-context.js";

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
    const ctx = new TaskExecutionContext("task-interactive", true);
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
