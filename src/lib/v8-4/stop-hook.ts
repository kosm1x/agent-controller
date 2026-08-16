/**
 * V8.4 — the ledger WALL: an in-process Claude Agent SDK `Stop` hook.
 *
 * unlazy's layer 5, ported from a shell hook that scans GATES.md to an SDK
 * `hooks.Stop` callback that consults the harness ledger. When the model
 * tries to end its turn while a RUNNABLE gate is FAILED, the stop is blocked
 * with a one-line reason naming the gates and their evidence, so the model
 * works the gate instead of composing a done-report. Two guards make it a
 * wall and not a trap (`feedback_turn_exhaustion_unwinnable_endgame`):
 *
 *   • Manual gates NEVER block — the model cannot write evidence, so a block
 *     on them would be unwinnable by construction. Only FAILED checks block;
 *     pending-manual gates surface later as "unverified".
 *   • Progress-aware release: the set of failing gate ids is the progress
 *     hash. `MAX_HOOK_BLOCKS` consecutive blocks with the same failing set
 *     ⇒ release (recorded as `gates.hook_released`, never silent). An
 *     `ABANDON: <id> <reason>` line in the last message is honored first.
 *
 * Armed only when BOTH `TASK_GATES_STOP_HOOK=true` and the ledger mode is not
 * off; the factory returns null otherwise so the SDK options object is
 * byte-for-byte today's when dormant.
 */
import type {
  HookCallback,
  HookInput,
  HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import { emitTraceEvent } from "../../observability/task-trace.js";
import { gatesMode, hasGates, listGates } from "./gates.js";
import {
  evaluateLedger,
  hasRunnableGates,
  type EvaluateOptions,
  type EvaluateResult,
} from "./gate-check.js";

export const MAX_HOOK_BLOCKS = 3;
/** Absolute ceiling regardless of "progress" — an oscillating failing set (qa W2) still ends. */
export const MAX_HOOK_BLOCKS_TOTAL = MAX_HOOK_BLOCKS * 2;

export function stopHookEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TASK_GATES_STOP_HOOK === "true" && gatesMode(env) !== "off";
}

interface HookState {
  hash: string;
  blocks: number;
  total: number;
}
const stateByTask = new Map<string, HookState>();

/** @internal test hook */
export function _resetStopHookState(): void {
  stateByTask.clear();
}

export interface StopHookDeps {
  evaluate?: (opts: EvaluateOptions) => Promise<EvaluateResult>;
  env?: NodeJS.ProcessEnv;
}

/**
 * Build the Stop hook for one task, or null when dormant / the task has no
 * ledger at query start (plan-declared gates that appear mid-run are the
 * dispatcher's consumer's job, not the wall's — v1 boundary).
 */
export function makeGatesStopHook(
  taskId: string,
  deps: StopHookDeps = {},
): HookCallback | null {
  const env = deps.env ?? process.env;
  if (!stopHookEnabled(env)) return null;
  if (!hasGates(taskId)) return null;
  const evaluate = deps.evaluate ?? evaluateLedger;

  return async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "Stop") return {};
    // Never let the wall become a new way to lose the run: any internal error
    // (DB busy, spawn EAGAIN) allows the stop and is recorded (qa W3).
    try {
      return await decide(input);
    } catch (err) {
      stateByTask.delete(taskId);
      emitTraceEvent({
        taskId,
        name: "gates.hook_released",
        attrs: { error: err instanceof Error ? err.message : String(err) },
      });
      return {};
    }
  };

  async function decide(input: HookInput): Promise<HookJSONOutput> {
    const rows = listGates(taskId);
    if (!hasRunnableGates(rows)) return {};

    const res = await evaluate({
      taskId,
      outputText:
        "last_assistant_message" in input &&
        typeof input.last_assistant_message === "string"
          ? input.last_assistant_message
          : "",
    });
    if (res.failed === 0) {
      stateByTask.delete(taskId);
      return {};
    }
    const failedIds = res.failedRows.map((r) => r.gate_id).sort();
    const hash = failedIds.join(",");
    const prev = stateByTask.get(taskId);
    const state: HookState =
      prev && prev.hash === hash
        ? { hash, blocks: prev.blocks + 1, total: prev.total + 1 }
        : { hash, blocks: 1, total: (prev?.total ?? 0) + 1 };
    stateByTask.set(taskId, state);

    if (state.blocks > MAX_HOOK_BLOCKS || state.total > MAX_HOOK_BLOCKS_TOTAL) {
      stateByTask.delete(taskId);
      emitTraceEvent({
        taskId,
        name: "gates.hook_released",
        attrs: {
          blocks: state.blocks - 1,
          total: state.total - 1,
          failed: failedIds,
        },
      });
      return {
        systemMessage: `gates: releasing after ${state.total - 1} blocked stops without progress; still FAILED: ${failedIds.join(", ")}.`,
      };
    }

    const detail = res.failedRows
      .slice(0, 4)
      .map(
        (r) =>
          `${r.gate_id} — ${r.criterion}${r.evidence ? ` [${r.evidence.slice(0, 160)}]` : ""}`,
      )
      .join("; ");
    emitTraceEvent({
      taskId,
      name: "gates.hook_blocked",
      attrs: { block: state.blocks, total: state.total, failed: failedIds },
    });
    return {
      decision: "block",
      reason:
        `Acceptance gates FAILED (${res.failed}/${res.total}): ${detail}. ` +
        `Fix the underlying issue and finish again — the harness re-runs the checks; ` +
        `if a gate is genuinely impossible, write \`ABANDON: <gate id> <reason>\` in your report. ` +
        `(block ${state.blocks}/${MAX_HOOK_BLOCKS})`,
    };
  }
}
