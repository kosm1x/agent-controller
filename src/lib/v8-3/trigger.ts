/**
 * V8.3 L1-L2 call site — the thin wrapper that routes an operator-confirmed,
 * gated-capability tool execution through `runDecisionPipeline`, so the write
 * lands a `decisions`/`decision_events` ledger row (and, for capabilities that
 * declare a SQL mutation, a captured reversal op) instead of executing
 * unrecorded. §16 v1: "audit + reversibility immediately; autonomy earned later".
 *
 * DORMANT BY DEFAULT. With `V83_ENABLED` unset, OR a tool that maps to no gated
 * capability, OR a capability outside the active canary set, this is a LITERAL
 * passthrough to `toolRegistry.execute` — byte-for-byte today's behavior. Only
 * L1-L2 (operator-confirmed) writes ever flow through the ledger here; autonomy
 * (L≥3) is out of scope and structurally capped by `gate_config.max_level`.
 *
 * The wrapper is an OBSERVABILITY layer, not a new gate: it must never BLOCK an
 * action the operator already confirmed, so any ledger failure degrades to a
 * direct execute and the tool's own output is always what the operator sees.
 * (Corollary: a capability seeded L0 or with a malformed `max_level` makes the
 * pipeline throw → the action still runs, just unlogged — the pipeline's
 * structural-safety refuse does NOT extend to this confirm-path seam, by design.)
 *
 * COVERAGE BOUNDARY (v1): this is wired ONLY into the messaging-router
 * confirm-accept site, so it records **interactive, operator-confirmed**
 * executions. A gated capability reaching execution by another path — a
 * scheduled/ritual task (`task-executor.ts` treats a schedule as prior
 * authorization, no confirm gate) or a Prometheus-executor tool call — runs
 * UNLOGGED. Acceptable for an audit-only canary; widening to full coverage means
 * wrapping the general tool-execution chokepoint, a separate change.
 */
import type Database from "better-sqlite3";
import { toolRegistry } from "../../tools/registry.js";
import { getDatabase } from "../../db/index.js";
import { createLogger } from "../logger.js";
import { isV83Enabled } from "./flags.js";
import { runDecisionPipeline, type DecisionTrigger } from "./pipeline.js";

const log = createLogger("v8-3:trigger");

/**
 * Tool name → seeded `capability_autonomy` key. Only the 5 tool-backed
 * capabilities that pass through the operator confirm path. `task_edit` (an
 * internal `tasks` UPDATE, the `sql_inverse` reversibility workhorse) is a
 * SEPARATE seam and is intentionally NOT wired here.
 */
export const CAPABILITY_BY_TOOL: Record<string, string> = {
  jarvis_file_delete: "jarvis_file_delete",
  gmail_send: "gmail_send",
  northstar_sync: "northstar_sync",
  skill_run: "skill_run",
  schedule_task: "schedule_task",
};

/**
 * v1 CANARY — only these gated capabilities are ACTIVE when `V83_ENABLED=true`.
 * Default = one audit-only capability (`jarvis_file_delete`, reversal `tri_restore`
 * → deferred, so ledger-only). Widen/narrow WITHOUT a redeploy via the
 * `V83_GATED_CAPABILITIES` env (csv); an empty value disables all.
 */
const DEFAULT_CANARY = new Set(["jarvis_file_delete"]);
function activeGatedCapabilities(): Set<string> {
  const env = process.env.V83_GATED_CAPABILITIES;
  if (env === undefined) return DEFAULT_CANARY;
  return new Set(
    env
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** A tool result string is a structured error iff it parses to `{error: truthy}`. */
function toolReportedError(result: string): boolean {
  try {
    const parsed: unknown = JSON.parse(result);
    return Boolean(
      parsed &&
      typeof parsed === "object" &&
      "error" in parsed &&
      (parsed as { error?: unknown }).error,
    );
  } catch {
    return false; // non-JSON output is not a structured error
  }
}

export interface GatedExecCtx {
  /** Conversation thread the decision belongs to (persisted on the row). */
  threadId: string;
  /** Test injection; defaults to the singleton. */
  db?: Database.Database;
}

/**
 * Execute a tool, wrapping it in the V8.3 L1-L2 decision ledger IFF the tool maps
 * to an ACTIVE gated capability and `V83_ENABLED` is on — otherwise a straight
 * passthrough. ALWAYS returns the tool's own output string; the ledger accrues
 * out of band and never swallows or blocks the operator's action.
 */
export async function executeGatedCapability(
  toolName: string,
  args: Record<string, unknown>,
  ctx: GatedExecCtx,
): Promise<string> {
  const capability = CAPABILITY_BY_TOOL[toolName];
  if (
    !capability ||
    !isV83Enabled() ||
    !activeGatedCapabilities().has(capability)
  ) {
    return toolRegistry.execute(toolName, args);
  }

  const db = ctx.db ?? getDatabase();
  let output: string | undefined;
  const trigger: DecisionTrigger = {
    capability,
    payload: args,
    context: { tool: toolName },
    threadId: ctx.threadId,
    // No `sqlMutation`: jarvis_file_delete's reversal is tri_restore (DEFERRED),
    // so v1 is audit-ledger only (Phase-2 mock pre-state, no reversal op). A
    // sql_inverse capability (task_edit) declares sqlMutation at ITS own seam.
  };

  try {
    const result = await runDecisionPipeline(trigger, {
      db,
      // The pipeline captures pre-state, THEN calls execute. This callback swallows
      // the tool's own throw (→ ok:false) so the tool runs AT MOST ONCE: after
      // `output` is set the outer catch never re-executes.
      execute: async () => {
        try {
          output = await toolRegistry.execute(toolName, args);
          return { ok: !toolReportedError(output) };
        } catch (e) {
          output = JSON.stringify({
            error: e instanceof Error ? e.message : String(e),
          });
          return { ok: false };
        }
      },
    });
    log.info(
      {
        capability,
        decisionId: result.decisionId,
        route: result.route,
        status: result.status,
      },
      "v8-3: gated capability recorded",
    );
  } catch (err) {
    // Pipeline-internal failure (unseeded/disabled/malformed capability). Never
    // block a confirmed action: if execute never ran (output undefined) fall back
    // to a direct execute; if it already ran, return what we have (no re-exec).
    log.error(
      {
        capability,
        err: err instanceof Error ? err.message : String(err),
      },
      "v8-3: decision pipeline failed — degrading to direct execute",
    );
    if (output === undefined) {
      log.warn(
        { capability, toolName },
        "v8-3: pipeline degrade — executing direct fallback (output was undefined)",
      );
      return toolRegistry.execute(toolName, args);
    }
  }
  return output ?? "";
}
