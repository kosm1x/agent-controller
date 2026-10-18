import { describe, it, expect } from "vitest";
import { TaskExecutionContext, CONFIRMATION_LIST_MAX } from "./execution-context.js";

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

  // Queue 4l + qa R2: the card dedups on tool AND args sha, then caps.
  describe("addPendingConfirmation", () => {
    it("no pending card → full (nothing to add to)", () => {
      const ctx = new TaskExecutionContext("t");
      expect(ctx.addPendingConfirmation("wp_delete", { id: 7 })).toBe("full");
      expect(ctx.getPendingConfirmation()).toBeNull();
    });

    it("same args, different tool → queued", () => {
      const ctx = new TaskExecutionContext("t");
      ctx.setPendingConfirmation("wp_delete", { id: 7 });
      expect(ctx.addPendingConfirmation("wp_unpublish", { id: 7 })).toBe("queued");
      expect(ctx.getPendingConfirmation()!.items.map((i) => i.toolName)).toEqual(["wp_delete", "wp_unpublish"]);
    });

    it("same tool, different args → queued", () => {
      const ctx = new TaskExecutionContext("t");
      ctx.setPendingConfirmation("wp_delete", { id: 7 });
      expect(ctx.addPendingConfirmation("wp_delete", { id: 8 })).toBe("queued");
      expect(ctx.getPendingConfirmation()!.items).toHaveLength(2);
    });

    it("same tool, same args (any key order, any item) → duplicate, nothing added", () => {
      const ctx = new TaskExecutionContext("t");
      ctx.setPendingConfirmation("gmail_send", { to: "a@b.com", subject: "x" });
      expect(ctx.addPendingConfirmation("wp_delete", { id: 7 })).toBe("queued");
      expect(ctx.addPendingConfirmation("gmail_send", { subject: "x", to: "a@b.com" })).toBe("duplicate");
      expect(ctx.addPendingConfirmation("wp_delete", { id: 7 })).toBe("duplicate");
      expect(ctx.getPendingConfirmation()!.items).toHaveLength(2);
    });

    it("cap order: a new call past CONFIRMATION_LIST_MAX → full; a repeat at the cap → duplicate", () => {
      const ctx = new TaskExecutionContext("t");
      ctx.setPendingConfirmation("wp_delete", { id: 1 });
      for (let i = 2; i <= CONFIRMATION_LIST_MAX; i++) {
        expect(ctx.addPendingConfirmation("wp_delete", { id: i })).toBe("queued");
      }
      expect(ctx.addPendingConfirmation("wp_delete", { id: 99 })).toBe("full");
      expect(ctx.addPendingConfirmation("wp_delete", { id: 3 })).toBe("duplicate");
      expect(ctx.getPendingConfirmation()!.items).toHaveLength(CONFIRMATION_LIST_MAX);
    });
  });
});
