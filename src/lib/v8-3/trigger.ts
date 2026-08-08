/**
 * V8.3 interactive call site — routes an operator-confirmed, gated-capability
 * tool execution through the decision ledger. §16 v1: "audit + reversibility
 * immediately; autonomy earned later".
 *
 * DORMANT BY DEFAULT. With `V83_ENABLED` unset, OR a tool that maps to no gated
 * capability, OR a capability outside the active canary set, this is a LITERAL
 * passthrough to `toolRegistry.execute` — byte-for-byte today's behavior.
 *
 * 2026-08-08 — the wrapper implementation moved to `gated-execution.ts`, shared
 * with the BACKGROUND seam inside `ToolRegistry.execute` (scheduled/ritual/
 * Prometheus/claude-sdk paths). The COVERAGE BOUNDARY the original module doc
 * described ("a gated capability reaching execution by another path runs
 * UNLOGGED") is CLOSED: both seams now record, distinguished by
 * `context.source` ('interactive' here, 'background' at the registry). This
 * seam calls the registry with `{v83: "skip"}` so the chokepoint does not
 * double-record the same execution.
 *
 * All original invariants live in `gated-execution.ts`: observability-not-a-gate
 * (pipeline failure degrades to direct execute, never blocks), at-most-once
 * execution, fail-OPEN (L1-L2 only — never reuse for an autonomous caller).
 */
import type Database from "better-sqlite3";
import { toolRegistry } from "../../tools/registry.js";
import {
  CAPABILITY_BY_TOOL,
  recordGatedExecution,
  shouldRecordGatedExecution,
} from "./gated-execution.js";

// Re-export: pre-2026-08-08 importers/tests reference the map from this module.
export { CAPABILITY_BY_TOOL };

export interface GatedExecCtx {
  /** Conversation thread the decision belongs to (persisted on the row). */
  threadId: string;
  /** Test injection; defaults to the singleton. */
  db?: Database.Database;
}

/**
 * Execute a tool, wrapping it in the V8.3 decision ledger IFF the tool maps to
 * an ACTIVE gated capability and `V83_ENABLED` is on — otherwise a straight
 * passthrough. ALWAYS returns the tool's own output string; the ledger accrues
 * out of band and never swallows or blocks the operator's action.
 */
export async function executeGatedCapability(
  toolName: string,
  args: Record<string, unknown>,
  ctx: GatedExecCtx,
): Promise<string> {
  if (!shouldRecordGatedExecution(toolName)) {
    return toolRegistry.execute(toolName, args);
  }
  return recordGatedExecution(
    toolName,
    args,
    () => toolRegistry.execute(toolName, args, { v83: "skip" }),
    { source: "interactive", threadId: ctx.threadId, db: ctx.db },
  );
}
