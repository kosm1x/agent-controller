import { describe, it, expect, vi, afterEach } from "vitest";
import { createTaskExecutor } from "./task-executor.js";
import { TaskExecutionContext } from "../inference/execution-context.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function mockRegistry() {
  return {
    execute: vi.fn().mockResolvedValue('{"ok": true}'),
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

  it("blocks destructive tool when not unlocked", async () => {
    const registry = mockRegistry();
    const ctx = new TaskExecutionContext("task-1");
    const executor = createTaskExecutor(registry, ctx);

    const result = await executor("commit__delete_item", { id: "1" });
    expect(result).toContain("CONFIRMATION_REQUIRED");
    expect(registry.execute).not.toHaveBeenCalled();
  });

  it("allows destructive tool when unlocked in context", async () => {
    const registry = mockRegistry();
    const ctx = new TaskExecutionContext("task-1");
    ctx.unlockDestructive("commit__delete_item");
    const executor = createTaskExecutor(registry, ctx);

    const result = await executor("commit__delete_item", { id: "1" });
    expect(result).toBe('{"ok": true}');
    expect(registry.execute).toHaveBeenCalled();
  });

  it("isolates destructive locks between tasks", async () => {
    const registry = mockRegistry();
    const ctxA = new TaskExecutionContext("task-a");
    const ctxB = new TaskExecutionContext("task-b");
    ctxA.unlockDestructive("commit__delete_item");

    const execA = createTaskExecutor(registry, ctxA);
    const execB = createTaskExecutor(registry, ctxB);

    // A can delete, B cannot
    expect(await execA("commit__delete_item", {})).toBe('{"ok": true}');
    expect(await execB("commit__delete_item", {})).toContain(
      "CONFIRMATION_REQUIRED",
    );
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
