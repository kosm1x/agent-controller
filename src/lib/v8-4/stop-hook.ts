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
 * Own deadline (landscape [a16]): the SDK matcher timeout
 * (`STOP_HOOK_SDK_TIMEOUT_S`) > the hook's own deadline
 * (`STOP_HOOK_DEADLINE_MS`) > the ledger budget it passes to `evaluate`
 * (capped `DEADLINE_MARGIN_MS` below the deadline). When the SDK ceiling fired
 * first it discarded the result and let the stop through with no trace; now
 * the hook's own deadline (or the SDK's abort signal) allows the stop and
 * records `gates.hook_released` with `reason`, so a timeout is never silent.
 * A late `evaluate` result is ignored. Every hook trace carries `elapsed_ms`.
 *
 * Armed only when BOTH `TASK_GATES_STOP_HOOK=true` and the ledger mode is not
 * off; the factory returns null otherwise so the SDK options object is
 * byte-for-byte today's when dormant.
 */
import { isGradeCheck, isReadbackCheck } from "./ledger-lines.js";
import type {
  HookCallback,
  HookInput,
  HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import { emitTraceEvent } from "../../observability/task-trace.js";
import { scrubSecrets } from "../secret-refs.js";
import { gatesMode, hasGates, listGates } from "./gates.js";
import {
  evaluateLedger,
  hasRunnableGates,
  ledgerBudgetMs,
  type EvaluateOptions,
  type EvaluateResult,
} from "./gate-check.js";

export const MAX_HOOK_BLOCKS = 3;
/** Absolute ceiling regardless of "progress" — an oscillating failing set (qa W2) still ends. */
export const MAX_HOOK_BLOCKS_TOTAL = MAX_HOOK_BLOCKS * 2;
/** The hook's own ceiling: past it the stop is allowed and the release recorded. */
export const STOP_HOOK_DEADLINE_MS = 150_000;
/** The SDK matcher timeout (seconds) — always above the hook's own deadline. */
export const STOP_HOOK_SDK_TIMEOUT_S =
  Math.ceil(STOP_HOOK_DEADLINE_MS / 1000) + 30;
/** The ledger budget ends this far before the deadline (freeze/read-back/DB overhead). */
const DEADLINE_MARGIN_MS = 10_000;

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
  /** Override of `STOP_HOOK_DEADLINE_MS` (tests). */
  deadlineMs?: number;
}

/** One hook invocation: whichever of decide / deadline / abort settles first wins. */
interface HookCall {
  enteredAt: number;
  state: "running" | "committed" | "cut";
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
  const deadlineMs = deps.deadlineMs ?? STOP_HOOK_DEADLINE_MS;

  return async (
    input: HookInput,
    _toolUseID?: string,
    options?: { signal?: AbortSignal },
  ): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "Stop") return {};
    const call: HookCall = { enteredAt: Date.now(), state: "running" };
    const signal = options?.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    // Deadline or SDK abort ⇒ allow the stop and RECORD it; never block on a
    // timeout (the consumer re-evaluates at completion).
    const cutoff = new Promise<HookJSONOutput>((resolve) => {
      const cut = (reason: "deadline" | "aborted"): void => {
        if (call.state !== "running") return;
        call.state = "cut";
        stateByTask.delete(taskId);
        emitTraceEvent({
          taskId,
          name: "gates.hook_released",
          attrs: {
            reason,
            deadline_ms: deadlineMs,
            elapsed_ms: Date.now() - call.enteredAt,
          },
        });
        resolve({});
      };
      timer = setTimeout(() => cut("deadline"), deadlineMs);
      if (signal?.aborted) cut("aborted");
      else if (signal) {
        onAbort = () => cut("aborted");
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    // An already-aborted signal never starts an evaluation.
    if (call.state === "cut") {
      clearTimeout(timer);
      return cutoff;
    }
    // Never let the wall become a new way to lose the run: any internal error
    // (DB busy, spawn EAGAIN) allows the stop and is recorded (qa W3).
    const run = (async (): Promise<HookJSONOutput> => {
      try {
        return await decide(input, call);
      } catch (err) {
        if (call.state === "cut") return {};
        call.state = "committed";
        stateByTask.delete(taskId);
        emitTraceEvent({
          taskId,
          name: "gates.hook_released",
          attrs: {
            error: err instanceof Error ? err.message : String(err),
            elapsed_ms: Date.now() - call.enteredAt,
          },
        });
        return {};
      }
    })();
    try {
      return await Promise.race([run, cutoff]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  };

  // An EVALUATED allow is recorded too: block/release alone left an armed wall
  // indistinguishable from an unwired one until a gate FAILED (2026-09-18).
  // Still silent by design when no runnable gate exists (nothing evaluated) —
  // e.g. a recovery leg whose only rows are mid-run RB-* read-backs.
  function allowed(res: EvaluateResult, call: HookCall): HookJSONOutput {
    stateByTask.delete(taskId);
    emitTraceEvent({
      taskId,
      name: "gates.hook_allowed",
      attrs: {
        total: res.total,
        met: res.met,
        failed: res.failed,
        abandoned: res.abandoned,
        elapsed_ms: Date.now() - call.enteredAt,
      },
    });
    return {};
  }

  async function decide(
    input: HookInput,
    call: HookCall,
  ): Promise<HookJSONOutput> {
    const rows = listGates(taskId);
    if (!hasRunnableGates(rows)) return {};

    const res = await evaluate({
      taskId,
      outputText:
        "last_assistant_message" in input &&
        typeof input.last_assistant_message === "string"
          ? input.last_assistant_message
          : "",
      // The evaluation bounds itself below the hook's own deadline.
      budgetMs: Math.min(
        ledgerBudgetMs(env),
        Math.max(1_000, deadlineMs - DEADLINE_MARGIN_MS),
      ),
    });
    // A result that lands after the deadline/abort is ignored: the release
    // is already recorded — no second trace, no state write.
    if (call.state === "cut") return {};
    call.state = "committed";
    if (res.failed === 0) return allowed(res, call);
    // Read-back rows are completion-time proofs rendered as Spanish lines;
    // they never wall the model (it cannot "fix" a harness re-read mid-run
    // except by redoing the write, which the deliverable line already asks).
    // V9 W1 grade gates (GR-*) are manual rows: never evaluated here, so a
    // Stop never pays for a grader call; a stale graded row (resumed task)
    // does not wall either.
    const blocking = res.failedRows.filter(
      (r) =>
        !isReadbackCheck(r.check_kind, r.check_cmd) &&
        !isGradeCheck(r.check_kind, r.check_cmd),
    );
    if (blocking.length === 0) return allowed(res, call);
    const failedIds = blocking.map((r) => r.gate_id).sort();
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
          elapsed_ms: Date.now() - call.enteredAt,
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
          // Ruling 3c, audit round 5: scrub before the 160-char cut (a cut
          // value would escape the reason-level scrub in claude-sdk.ts).
          `${r.gate_id} — ${r.criterion}${r.evidence ? ` [${scrubSecrets(r.evidence).slice(0, 160)}]` : ""}`,
      )
      .join("; ");
    emitTraceEvent({
      taskId,
      name: "gates.hook_blocked",
      attrs: {
        block: state.blocks,
        total: state.total,
        failed: failedIds,
        elapsed_ms: Date.now() - call.enteredAt,
      },
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
