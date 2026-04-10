/**
 * Per-task execution context — isolates mutable state that was previously
 * shared globally via singletons (destructive locks, memory rate limits).
 *
 * Each task creates its own context. The context flows through the executor
 * callback into inferWithTools, ensuring concurrent tasks don't corrupt
 * each other's state.
 *
 * v5.0 S2: replaces toolRegistry.destructiveUnlocked + memory.ts globals.
 */

const MAX_MEMORY_STORES_PER_TASK = 5;

export class TaskExecutionContext {
  readonly taskId: string;

  /**
   * CCP9: Scope-bounded destructive tool approval.
   * Map: tool name → args fingerprint (null = any target approved).
   * target-scoped: unlock("delete_item", "contact_123") only unlocks that target.
   * broad: unlock("delete_item") unlocks for any target (deletion commands).
   */
  private readonly destructiveUnlocked = new Map<string, string | null>();

  /** Memory store count for rate limiting. */
  private memoryStoreCount = 0;

  /** Pending tool confirmation — set when a high-risk tool is blocked. */
  private _pendingConfirmation: {
    toolName: string;
    args: Record<string, unknown>;
  } | null = null;

  constructor(taskId: string) {
    this.taskId = taskId;
  }

  // --- Pending confirmation (pause/resume pattern) ---

  setPendingConfirmation(
    toolName: string,
    args: Record<string, unknown>,
  ): void {
    this._pendingConfirmation = { toolName, args };
  }

  getPendingConfirmation(): {
    toolName: string;
    args: Record<string, unknown>;
  } | null {
    return this._pendingConfirmation;
  }

  // --- Destructive lock management ---

  /**
   * Unlock a destructive tool.
   * @param name Tool name
   * @param argsFingerprint Optional target fingerprint. If omitted, unlocks for ANY target.
   */
  unlockDestructive(name: string, argsFingerprint?: string): void {
    // Broad unlock (no fingerprint) always wins over target-scoped
    if (!argsFingerprint || this.destructiveUnlocked.get(name) === null) {
      this.destructiveUnlocked.set(name, null);
    } else {
      this.destructiveUnlocked.set(name, argsFingerprint);
    }
  }

  /**
   * Check if a destructive tool is unlocked for the given args.
   * null fingerprint in the map = any target approved (broad unlock).
   */
  isDestructiveUnlocked(name: string, argsFingerprint?: string): boolean {
    if (!this.destructiveUnlocked.has(name)) return false;
    const stored = this.destructiveUnlocked.get(name);
    // null = broad unlock (any target approved)
    if (stored === null) return true;
    // Target-scoped: must match fingerprint
    return !argsFingerprint || stored === argsFingerprint;
  }

  // --- Memory store rate limiting ---

  /**
   * Check if memory store is allowed. Returns true if under limit.
   * Increments the counter on success.
   */
  tryMemoryStore(): boolean {
    if (this.memoryStoreCount >= MAX_MEMORY_STORES_PER_TASK) {
      return false;
    }
    this.memoryStoreCount++;
    return true;
  }

  getMemoryStoreCount(): number {
    return this.memoryStoreCount;
  }

  getMemoryStoreLimit(): number {
    return MAX_MEMORY_STORES_PER_TASK;
  }
}
