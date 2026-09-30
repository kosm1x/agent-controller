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

import { AsyncLocalStorage } from "async_hooks";

const MAX_MEMORY_STORES_PER_TASK = 5;

/** Who can be asked to confirm a high-risk call in this run (all default false). */
export interface ConfirmationFacts {
  routerRoot?: boolean;
  canAskOperator?: boolean;
  chatOrigin?: boolean;
  a2aOrigin?: boolean;
}

export class TaskExecutionContext {
  readonly taskId: string;

  /**
   * Whether this task has an interactive user who can confirm high-risk actions.
   * Scheduled tasks, rituals, and autonomous improvement have no user in the loop —
   * confirmation gate is bypassed for these (the schedule itself is the authorization).
   */
  readonly interactive: boolean;

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

  /** Tool calls the confirmation gate stopped (never executed) in this run. */
  private readonly _gatedCalls: string[] = [];

  /**
   * The router tracks this task's reply: an operator-thread root submission,
   * never a sub-task or a retry (dispatcher `gateContextFor`).
   */
  readonly routerRoot: boolean;

  /**
   * A high-risk call may pause for the operator's yes: the task is a router
   * root AND this context's runner surfaces the pending action in its output
   * (fast runner). Otherwise the gate refuses instead of asking.
   */
  readonly canAskOperator: boolean;

  /** The run answers a chat message (any sender): refusals stay generic. */
  readonly chatOrigin: boolean;

  /** The run serves an A2A peer (tag `a2a`): its refusal has no API hint. */
  readonly a2aOrigin: boolean;

  constructor(
    taskId: string,
    interactive = true,
    facts: ConfirmationFacts = {},
  ) {
    this.taskId = taskId;
    this.interactive = interactive;
    this.routerRoot = facts.routerRoot === true;
    this.canAskOperator = facts.canAskOperator === true;
    this.chatOrigin = facts.chatOrigin === true;
    this.a2aOrigin = facts.a2aOrigin === true;
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

  /** Record a call the gate stopped, so the run's toolCalls can drop it. */
  recordGatedCall(toolName: string): void {
    this._gatedCalls.push(toolName);
  }

  getGatedCalls(): readonly string[] {
    return this._gatedCalls;
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

/**
 * The execution context of the run in flight. The dispatcher enters one around
 * EVERY `runner.execute` (confirmation facts only); the fast runner enters its
 * own around each SDK query. The Claude Agent SDK runs tools through the
 * in-process MCP bridge (`wrapTool` in claude-sdk.ts), which never sees a
 * runner's executor — this store carries the context to it so the one
 * confirmation gate (task-executor.ts) runs on that path too.
 */
const executionContextStore = new AsyncLocalStorage<TaskExecutionContext>();

export function runWithExecutionContext<T>(
  context: TaskExecutionContext,
  fn: () => T,
): T {
  return executionContextStore.run(context, fn);
}

/** Context of the current SDK query; `undefined` outside one. */
export function currentExecutionContext(): TaskExecutionContext | undefined {
  return executionContextStore.getStore();
}

/** Run `fn` outside any execution context (paired with `outsideRunToolContext`). */
export function exitExecutionContext<T>(fn: () => T): T {
  return executionContextStore.exit(fn);
}

/**
 * A runner's own context for `taskId` — one that surfaces a pending
 * confirmation in its output (fast runner). Inside a dispatched run it takes
 * the dispatcher's facts for the same task and may ask only for a router
 * root; outside one (reflection) it never asks.
 */
export function runnerExecutionContext(
  taskId: string,
  interactive: boolean,
): TaskExecutionContext {
  const outer = currentExecutionContext();
  const run = outer?.taskId === taskId ? outer : undefined;
  return new TaskExecutionContext(taskId, run ? run.interactive : interactive, {
    routerRoot: run?.routerRoot,
    canAskOperator: run?.routerRoot,
    chatOrigin: run?.chatOrigin,
    a2aOrigin: run?.a2aOrigin,
  });
}
