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

  /** Destructive tools unlocked for this task (e.g. after user confirmation). */
  private readonly destructiveUnlocked = new Set<string>();

  /** Memory store count for rate limiting. */
  private memoryStoreCount = 0;

  constructor(taskId: string) {
    this.taskId = taskId;
  }

  // --- Destructive lock management ---

  unlockDestructive(name: string): void {
    this.destructiveUnlocked.add(name);
  }

  isDestructiveUnlocked(name: string): boolean {
    return this.destructiveUnlocked.has(name);
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
