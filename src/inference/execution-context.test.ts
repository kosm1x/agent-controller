import { describe, it, expect } from "vitest";
import { TaskExecutionContext } from "./execution-context.js";

describe("TaskExecutionContext", () => {
  describe("destructive locks", () => {
    it("starts locked", () => {
      const ctx = new TaskExecutionContext("task-1");
      expect(ctx.isDestructiveUnlocked("dangerous_tool")).toBe(false);
    });

    it("unlocks after explicit call", () => {
      const ctx = new TaskExecutionContext("task-1");
      ctx.unlockDestructive("dangerous_tool");
      expect(ctx.isDestructiveUnlocked("dangerous_tool")).toBe(true);
    });

    it("isolates between contexts", () => {
      const ctxA = new TaskExecutionContext("task-a");
      const ctxB = new TaskExecutionContext("task-b");
      ctxA.unlockDestructive("dangerous_tool");
      expect(ctxA.isDestructiveUnlocked("dangerous_tool")).toBe(true);
      expect(ctxB.isDestructiveUnlocked("dangerous_tool")).toBe(false);
    });

    // CCP9: Scope-bounded approval tests
    it("broad unlock (no fingerprint) allows any target", () => {
      const ctx = new TaskExecutionContext("task-1");
      ctx.unlockDestructive("delete_item");
      expect(ctx.isDestructiveUnlocked("delete_item", "contact_123")).toBe(
        true,
      );
      expect(ctx.isDestructiveUnlocked("delete_item", "contact_456")).toBe(
        true,
      );
    });

    it("target-scoped unlock only allows matching fingerprint", () => {
      const ctx = new TaskExecutionContext("task-1");
      ctx.unlockDestructive("delete_item", "contact_123");
      expect(ctx.isDestructiveUnlocked("delete_item", "contact_123")).toBe(
        true,
      );
      expect(ctx.isDestructiveUnlocked("delete_item", "contact_456")).toBe(
        false,
      );
    });

    it("broad unlock overrides target-scoped", () => {
      const ctx = new TaskExecutionContext("task-1");
      ctx.unlockDestructive("delete_item", "contact_123");
      ctx.unlockDestructive("delete_item"); // broad override
      expect(ctx.isDestructiveUnlocked("delete_item", "contact_456")).toBe(
        true,
      );
    });
  });

  describe("memory store rate limiting", () => {
    it("allows stores under limit", () => {
      const ctx = new TaskExecutionContext("task-1");
      expect(ctx.tryMemoryStore()).toBe(true);
      expect(ctx.getMemoryStoreCount()).toBe(1);
    });

    it("blocks at limit", () => {
      const ctx = new TaskExecutionContext("task-1");
      for (let i = 0; i < 5; i++) {
        expect(ctx.tryMemoryStore()).toBe(true);
      }
      expect(ctx.tryMemoryStore()).toBe(false);
      expect(ctx.getMemoryStoreCount()).toBe(5);
    });

    it("isolates between contexts", () => {
      const ctxA = new TaskExecutionContext("task-a");
      const ctxB = new TaskExecutionContext("task-b");
      for (let i = 0; i < 5; i++) ctxA.tryMemoryStore();
      expect(ctxA.tryMemoryStore()).toBe(false);
      expect(ctxB.tryMemoryStore()).toBe(true); // B unaffected
    });
  });
});
