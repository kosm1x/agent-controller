/**
 * V8.3 shared gated-execution wrapper — ONE implementation behind BOTH seams:
 *
 *  - interactive (`trigger.ts` → messaging-router confirm-accept site), and
 *  - background (`ToolRegistry.execute` — scheduled/ritual tasks, the Prometheus
 *    executor, the claude-sdk MCP bridge: every non-interactive path funnels
 *    through the registry chokepoint).
 *
 * Added 2026-08-08 (gate-validity assessment): the interactive-only coverage
 * boundary meant §14's shadow scored an empty-by-construction population — 0
 * lifetime decisions in 33 days while ~27 real gated-capability executions/wk
 * flowed through the registry unlogged. Re-siting collection here fills the
 * shadow with the traffic autonomy would actually govern.
 *
 * INVARIANTS (identical to the original trigger.ts wrapper):
 *  - Observability, not a gate: any pipeline failure degrades to a direct
 *    execute — never blocks, never swallows the tool's own output.
 *  - At-most-once: the execute thunk runs exactly once across all paths; after
 *    `output` is set the degrade path never re-executes.
 *  - Fails OPEN — safe for L1-L2 ONLY. Any future L≥3 (autonomous) wiring MUST
 *    NOT reuse this degrade: a pipeline failure on an autonomous decision must
 *    fail CLOSED (block or drop to confirm), never direct-execute.
 *
 * IMPORT DISCIPLINE: this module must NOT import `tools/registry.js`,
 * `trigger.ts`, or `db/index.js` (the registry imports it — the execute thunk
 * is injected and the db handle flows through ctx/pipeline precisely to keep
 * the dependency one-way). The db/index edge matters doubly: importing it
 * would re-create a transitive ESM cycle (registry → here → db/index →
 * tuning/activation → registry, qa S1), and calling `getDatabase()` here would
 * put a throw-capable statement outside the never-blocks try (qa W1; cf.
 * feedback_boot_throw_exits_zero).
 */
import type Database from "better-sqlite3";
import type { ToolAnnotations } from "../../tools/types.js";
import { createLogger } from "../logger.js";
import { isV83Enabled } from "./flags.js";
import { runDecisionPipeline, type DecisionTrigger } from "./pipeline.js";
import { errMsg } from "../err-msg.js";

const log = createLogger("v8-3:gated-execution");

/**
 * Tool name → seeded `capability_autonomy` key. Only tool-backed capabilities;
 * `task_edit` (an internal `tasks` UPDATE, the `sql_inverse` reversibility
 * workhorse) is a SEPARATE seam and is intentionally NOT mapped here.
 *
 * 2026-08-01 — two confirm-path DELETE tools were missing from this map, so
 * they executed unlogged even with the capability armed (`delete_schedule` ran
 * 2026-08-01 13:22 MX and left no ledger row). The mapped tool need not equal
 * the capability name: a capability is the governed ACTION CLASS, and
 * `delete_schedule` is the `delete_inverse` half of `schedule_task`.
 *
 * 2026-08-08 — with the registry chokepoint wired, tools WITHOUT
 * `requiresConfirmation` (e.g. `schedule_task` itself, `gmail_send` from a
 * scheduled task) now reach the ledger via the background seam.
 */
export const CAPABILITY_BY_TOOL: Record<string, string> = {
  jarvis_file_delete: "jarvis_file_delete",
  jarvis_files_batch_delete: "jarvis_file_delete",
  gmail_send: "gmail_send",
  northstar_sync: "northstar_sync",
  skill_run: "skill_run",
  schedule_task: "schedule_task",
  delete_schedule: "schedule_task",
};

/**
 * Tool → the row its execution CREATES, for capabilities whose canonical
 * reversal is `delete_inverse`. The pipeline builds a delete-the-created-row
 * template pre-execution and completes it from the tool's output
 * (`resultPkField`). Only creation tools belong here — `delete_schedule` is the
 * inverse half, not a creation.
 */
export const CREATION_BY_TOOL: Record<
  string,
  { table: string; pkColumn: string; resultPkField: string }
> = {
  // CONTRACT with src/tools/builtin/schedule.ts — its result's top-level
  // `schedule_id` field and the `scheduled_tasks.schedule_id` column are what
  // these three strings bind to; renaming either silently degrades every
  // schedule_task decision to an unreplayable null-pk op (qa W4). A cross-
  // comment sits at the tool's return site. ONLY tables with TEXT/UUID pks may
  // be listed here: an INTEGER PRIMARY KEY table reuses rowids after delete, so
  // a late revert could delete a DIFFERENT row that inherited the id (qa R4).
  schedule_task: {
    table: "scheduled_tasks",
    pkColumn: "schedule_id",
    resultPkField: "schedule_id",
  },
};

/**
 * v1 CANARY — only these gated capabilities are ACTIVE when `V83_ENABLED=true`.
 * Widen/narrow WITHOUT a redeploy via the `V83_GATED_CAPABILITIES` env (csv);
 * an empty value disables all.
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

/**
 * True iff executing `toolName` should be recorded in the decision ledger:
 * the tool maps to a capability that is armed. O(1) — safe on the registry's
 * hot path.
 */
export function shouldRecordGatedExecution(toolName: string): boolean {
  const capability = CAPABILITY_BY_TOOL[toolName];
  return Boolean(
    capability && isV83Enabled() && activeGatedCapabilities().has(capability),
  );
}

/**
 * A tool result string is a structured error iff it parses to `{error: truthy}`
 * OR `{success: false}` — the latter is the documented batch-tool partial-error
 * envelope (`jarvis_files_batch_delete` returns `{success: errors === 0, …}`),
 * which task-executor already grades this way; the ledger must match (qa R3).
 */
function toolReportedError(result: string): boolean {
  try {
    const parsed: unknown = JSON.parse(result);
    if (!parsed || typeof parsed !== "object") return false;
    const obj = parsed as { error?: unknown; success?: unknown };
    return Boolean(obj.error) || obj.success === false;
  } catch {
    return false; // non-JSON output is not a structured error
  }
}

export interface GatedExecutionCtx {
  /** Which seam recorded this execution (persisted in the decision context). */
  source: "interactive" | "background";
  /** Conversation thread the decision belongs to (persisted on the row). */
  threadId: string;
  /**
   * Rule of Two (V8.5 Phase 5.2): tools this run invoked BEFORE this call
   * (`priorRunTools()` at the registry seam). The pipeline composes them with
   * this tool and demotes to L1 on an A∧B∧C run. Absent ⇒ no prior.
   */
  priorToolNames?: readonly string[];
  /**
   * Rule of Two — the registry's annotation view by tool name. Absent ⇒ the
   * pipeline treats every name as unclassified (all three ⇒ demote), so a
   * caller that forgets it fails toward a human, never toward autonomy.
   */
  resolveToolAnnotations?: (name: string) => ToolAnnotations | undefined;
  /** Test injection; defaults to the singleton. */
  db?: Database.Database;
}

/**
 * Run `executeThunk` through the V8.3 decision pipeline, recording a
 * `decisions`/`decision_events` ledger row. ALWAYS returns the tool's own
 * output string; the ledger accrues out of band and never swallows or blocks
 * the action. Callers are responsible for the shouldRecordGatedExecution
 * check — this function assumes the tool is gated and armed.
 */
export async function recordGatedExecution(
  toolName: string,
  args: Record<string, unknown>,
  executeThunk: () => Promise<string>,
  ctx: GatedExecutionCtx,
): Promise<string> {
  const capability = CAPABILITY_BY_TOOL[toolName];
  // qa W1: do NOT resolve getDatabase() here — it can throw ("Database not
  // initialized") and this is the one place a throw would land BEFORE the try
  // that implements "never blocks". The pipeline resolves its own default
  // INSIDE our try; ctx.db stays a pure test-injection passthrough.
  let output: string | undefined;
  let thunkThrew = false;
  let thunkError: unknown;
  const trigger: DecisionTrigger = {
    capability,
    payload: args,
    context: { tool: toolName, source: ctx.source },
    threadId: ctx.threadId,
    priorToolNames: ctx.priorToolNames,
    // `creation` (delete_inverse template) only for creation tools; other
    // capabilities land audit-only rows (`reversal: null`), same shape
    // `jarvis_file_delete` has had since v1. No `sqlMutation` at this seam —
    // a sql_inverse capability (task_edit) declares it at ITS own seam.
    creation: CREATION_BY_TOOL[toolName],
    //
    // No `externalContent` (Phase 5 §8): this seam is OBSERVABILITY-ONLY and must
    // never block. WIRING CONTRACT — before any caller sets `externalContent`
    // here, this wrapper MUST handle a `status:"interrupted"` result: the pipeline
    // RETURNS (does not throw) on an injection hit, so the `execute` callback
    // never runs and `output` stays undefined → `return output ?? ""` would hand
    // back a SILENT empty string. An interrupted decision must be surfaced, not
    // swallowed as success.
    //
    // No `judgmentId` / L≥3 path: this wrapper only ever produces L1-L2
    // decisions (every seeded capability sits at L1; §7/§12 demote anything
    // higher that lacks its gates). See the fail-OPEN invariant in the module
    // doc before wiring any autonomous caller through here.
  };

  try {
    const result = await runDecisionPipeline(trigger, {
      db: ctx.db,
      resolveToolAnnotations: ctx.resolveToolAnnotations,
      // The pipeline captures pre-state, THEN calls execute. This callback
      // captures the tool's own throw (→ ok:false) so the tool runs AT MOST
      // ONCE: after `output` is set the outer catch never re-executes. The
      // original exception is kept so the background seam can re-throw it (qa
      // W2 — see below).
      execute: async () => {
        try {
          output = await executeThunk();
          return { ok: !toolReportedError(output), output };
        } catch (e) {
          thunkThrew = true;
          thunkError = e;
          output = JSON.stringify({ error: errMsg(e) });
          return { ok: false, output };
        }
      },
    });
    log.info(
      {
        capability,
        source: ctx.source,
        decisionId: result.decisionId,
        route: result.route,
        status: result.status,
        reversal: result.reversal,
      },
      "v8-3: gated capability recorded",
    );
    // qa R1: the pipeline RETURNS (does not throw) on an §8 injection hit —
    // the execute callback never ran. Surface a structured error instead of
    // the silent "" the trailing `output ?? ""` would produce. Unreachable
    // today (neither seam sets externalContent); this is the runtime guard
    // behind the wiring contract above. Do NOT degrade to executeThunk() here:
    // interrupted means "deliberately not executed".
    if (result.status === "interrupted" && output === undefined) {
      return JSON.stringify({
        error: "blocked: prompt injection suspected (decision interrupted)",
      });
    }
  } catch (err) {
    // Pipeline-internal failure (unseeded/disabled/malformed capability). Never
    // block the action: if execute never ran (output undefined) fall back to a
    // direct execute; if it already ran, return what we have (no re-exec).
    log.error(
      { capability, source: ctx.source, err: errMsg(err) },
      "v8-3: decision pipeline failed — degrading to direct execute",
    );
    if (output === undefined) return executeThunk();
  }
  // qa W2: preserve the chokepoint's failure channel. Before this seam existed,
  // a background caller (task-executor, Prometheus, claude-sdk bridge) saw the
  // tool's exception PROPAGATE from registry.execute — the claude-sdk bridge
  // sets its MCP isError flag off that throw. Re-throw the original error so
  // arming a capability never silently converts a throw into a success-shaped
  // string. The interactive seam keeps its pre-existing JSON-error contract
  // (the router expects a string result).
  if (thunkThrew && ctx.source === "background") {
    throw thunkError;
  }
  return output ?? "";
}
