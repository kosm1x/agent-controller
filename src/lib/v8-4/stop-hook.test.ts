/**
 * V8.4 ledger wall: dormant unless armed AND the task has a ledger; blocks
 * only on FAILED runnable gates; honors ABANDON; releases after
 * MAX_HOOK_BLOCKS blocked stops without progress and RECORDS the release.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StopHookInput } from "@anthropic-ai/claude-agent-sdk";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import { declareGates, listGates, recordGateResult } from "./gates.js";
import {
  MAX_HOOK_BLOCKS,
  _resetStopHookState,
  makeGatesStopHook,
  stopHookEnabled,
} from "./stop-hook.js";

const ARMED = { TASK_GATES_STOP_HOOK: "true", TASK_GATES_MODE: "shadow" };

const stopInput = (last = ""): StopHookInput => ({
  hook_event_name: "Stop",
  session_id: "s",
  transcript_path: "/dev/null",
  cwd: "/",
  stop_hook_active: false,
  last_assistant_message: last,
});

function traces(taskId: string): string[] {
  return (
    getDatabase()
      .prepare(
        `SELECT name FROM task_trace_events WHERE task_id = ? ORDER BY id`,
      )
      .all(taskId) as Array<{ name: string }>
  ).map((r) => r.name);
}

beforeEach(() => {
  initDatabase(":memory:");
  _resetStopHookState();
});
afterEach(() => closeDatabase());

describe("arming", () => {
  it("stopHookEnabled needs BOTH the flag and a non-off mode", () => {
    expect(stopHookEnabled({})).toBe(false);
    expect(stopHookEnabled({ TASK_GATES_STOP_HOOK: "true" })).toBe(false);
    expect(stopHookEnabled({ TASK_GATES_MODE: "enforce" })).toBe(false);
    expect(stopHookEnabled(ARMED)).toBe(true);
  });

  it("factory returns null when dormant or the task has no ledger — SDK options stay untouched", () => {
    declareGates("t1", [{ criterion: "c", check: "false" }], "submission");
    expect(makeGatesStopHook("t1", { env: {} })).toBeNull();
    expect(makeGatesStopHook("no-ledger", { env: ARMED })).toBeNull();
    expect(makeGatesStopHook("t1", { env: ARMED })).toBeTypeOf("function");
  });
});

describe("blocking", () => {
  it("blocks with a reason naming FAILED gates; allows once they pass", async () => {
    let pass = false;
    declareGates(
      "t1",
      [{ criterion: "tests green", check: "cmd", expect: "ok" }],
      "submission",
    );
    const hook = makeGatesStopHook("t1", {
      env: ARMED,
      evaluate: async (opts) => {
        recordGateResult(
          "t1",
          "G1",
          pass
            ? { state: "met", evidence: "ok" }
            : { state: "failed", evidence: "1 failed" },
        );
        const rows = listGates("t1");
        return {
          verdict: pass ? "met" : "failed",
          total: 1,
          met: pass ? 1 : 0,
          failed: pass ? 0 : 1,
          pending: 0,
          abandoned: 0,
          failedRows: pass ? [] : rows,
          pendingRows: [],
          abandonedRows: [],
          ran: 1,
          abandonedNow: 0,
          rows,
          ...(opts.rerun && {}),
        };
      },
    })!;
    const blocked = await hook(stopInput("Listo."), undefined, {
      signal: new AbortController().signal,
    });
    expect(blocked).toMatchObject({ decision: "block" });
    expect((blocked as { reason: string }).reason).toContain(
      "G1 — tests green [1 failed]",
    );
    expect((blocked as { reason: string }).reason).toContain(
      "ABANDON: <gate id> <reason>",
    );
    expect((blocked as { reason: string }).reason).toContain(
      `(block 1/${MAX_HOOK_BLOCKS})`,
    );
    pass = true;
    const allowed = await hook(stopInput("Fixed."), undefined, {
      signal: new AbortController().signal,
    });
    expect(allowed).toEqual({});
    expect(traces("t1")).toEqual(["gates.hook_blocked"]);
  });

  it("never blocks on manual-only ledgers (unwinnable by construction) and ignores non-Stop events", async () => {
    declareGates("t2", [{ criterion: "reads well" }], "submission");
    const hook = makeGatesStopHook("t2", { env: ARMED })!;
    expect(
      await hook(stopInput("done"), undefined, {
        signal: new AbortController().signal,
      }),
    ).toEqual({});
    expect(
      await hook(
        { ...stopInput(), hook_event_name: "PreToolUse" } as never,
        undefined,
        {
          signal: new AbortController().signal,
        },
      ),
    ).toEqual({});
  });

  it("honors ABANDON in the last assistant message (real evaluate) → allow", async () => {
    declareGates(
      "t3",
      [{ criterion: "impossible", check: "false" }],
      "submission",
    );
    const hook = makeGatesStopHook("t3", { env: ARMED })!;
    const first = await hook(stopInput("trying"), undefined, {
      signal: new AbortController().signal,
    });
    expect(first).toMatchObject({ decision: "block" });
    const second = await hook(
      stopInput("ABANDON: G1 no sandbox network"),
      undefined,
      {
        signal: new AbortController().signal,
      },
    );
    expect(second).toEqual({});
    expect(listGates("t3")[0]).toMatchObject({
      state: "abandoned",
      abandon_reason: "no sandbox network",
    });
  });

  it(`releases after ${MAX_HOOK_BLOCKS} blocked stops with the same failing set, and records it; progress resets the counter`, async () => {
    declareGates(
      "t4",
      [
        { criterion: "a", check: "false" },
        { criterion: "b", check: "false" },
      ],
      "submission",
    );
    const hook = makeGatesStopHook("t4", { env: ARMED })!;
    const sig = { signal: new AbortController().signal };
    for (let i = 1; i <= MAX_HOOK_BLOCKS; i++) {
      const r = await hook(stopInput("still trying"), undefined, sig);
      expect(r).toMatchObject({ decision: "block" });
      expect((r as { reason: string }).reason).toContain(
        `(block ${i}/${MAX_HOOK_BLOCKS})`,
      );
    }
    const released = await hook(stopInput("still trying"), undefined, sig);
    expect(released).not.toHaveProperty("decision");
    expect((released as { systemMessage: string }).systemMessage).toMatch(
      /releasing after 3 blocked stops/,
    );
    expect(traces("t4")).toEqual([
      "gates.hook_blocked",
      "gates.hook_blocked",
      "gates.hook_blocked",
      "gates.hook_released",
    ]);
    // Progress (one gate abandoned → failing set shrinks) restarts the count at 1.
    const again = await hook(stopInput("ABANDON: G1 cannot"), undefined, sig);
    expect((again as { reason: string }).reason).toContain(
      `(block 1/${MAX_HOOK_BLOCKS})`,
    );
  });
});

describe("qa folds 2026-08-16", () => {
  it("W2: an oscillating failing set still ends — absolute ceiling MAX_HOOK_BLOCKS_TOTAL", async () => {
    declareGates(
      "o1",
      [
        { criterion: "a", check: "x" },
        { criterion: "b", check: "y" },
      ],
      "submission",
    );
    let turn = 0;
    const hook = makeGatesStopHook("o1", {
      env: ARMED,
      evaluate: async () => {
        // Alternate which gate fails: G1, G2, G1, G2, …
        const failing = turn++ % 2 === 0 ? "G1" : "G2";
        const rows = listGates("o1");
        const failedRows = rows.filter((r) => r.gate_id === failing);
        return {
          verdict: "failed",
          total: 2,
          met: 1,
          failed: 1,
          pending: 0,
          abandoned: 0,
          failedRows,
          pendingRows: [],
          abandonedRows: [],
          ran: 1,
          abandonedNow: 0,
          shellSkipped: 0,
          budgetExhausted: 0,
          rows,
        };
      },
    })!;
    const sig = { signal: new AbortController().signal };
    let released: unknown = null;
    for (let i = 0; i < 12; i++) {
      const r = await hook(stopInput("still"), undefined, sig);
      if (!("decision" in (r as object))) {
        released = r;
        break;
      }
    }
    expect(released).not.toBeNull();
    expect((released as { systemMessage: string }).systemMessage).toMatch(/releasing after 6 blocked stops/);
    expect(traces("o1").filter((n) => n === "gates.hook_blocked")).toHaveLength(6);
    expect(traces("o1").at(-1)).toBe("gates.hook_released");
  });

  it("W3: an internal error allows the stop (never kills the run) and is recorded", async () => {
    declareGates("x1", [{ criterion: "a", check: "x" }], "submission");
    const hook = makeGatesStopHook("x1", {
      env: ARMED,
      evaluate: async () => {
        throw new Error("SQLITE_BUSY");
      },
    })!;
    const r = await hook(stopInput("done"), undefined, { signal: new AbortController().signal });
    expect(r).toEqual({});
    expect(traces("x1")).toEqual(["gates.hook_released"]);
  });
});
