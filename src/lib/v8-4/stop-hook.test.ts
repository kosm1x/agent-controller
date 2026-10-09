/**
 * V8.4 ledger wall: dormant unless armed AND the task has a ledger; blocks
 * only on FAILED runnable gates; honors ABANDON; releases after
 * MAX_HOOK_BLOCKS blocked stops without progress and RECORDS the release.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StopHookInput } from "@anthropic-ai/claude-agent-sdk";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import { declareGates, listGates, recordGateResult } from "./gates.js";
import {
  MAX_HOOK_BLOCKS,
  STOP_HOOK_DEADLINE_MS,
  STOP_HOOK_SDK_TIMEOUT_S,
  _resetStopHookState,
  makeGatesStopHook,
  stopHookEnabled,
} from "./stop-hook.js";
import {
  ledgerBudgetMs,
  type EvaluateOptions,
  type EvaluateResult,
} from "./gate-check.js";

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
    // The allow is recorded too — an armed wall must be tellable from an
    // unwired one without waiting for a gate to FAIL.
    expect(traces("t1")).toEqual(["gates.hook_blocked", "gates.hook_allowed"]);
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
    // No runnable gate ⇒ nothing was evaluated ⇒ nothing to record.
    expect(traces("t2")).toEqual([]);
  });

  it("a FAILED read-back row never walls the model — allowed, and recorded with failed > 0", async () => {
    declareGates(
      "t5",
      [{ criterion: "tests green", check: "true" }],
      "submission",
    );
    const hook = makeGatesStopHook("t5", {
      env: ARMED,
      evaluate: async () => {
        const rb = {
          ...listGates("t5")[0],
          gate_id: "RB-1",
          check_kind: "manual" as const,
          check_cmd: 'readback:{"tool":"jarvis_file_write"}',
          state: "failed" as const,
        };
        return {
          verdict: "failed",
          total: 2,
          met: 1,
          failed: 1,
          pending: 0,
          abandoned: 0,
          failedRows: [rb],
          pendingRows: [],
          abandonedRows: [],
          ran: 1,
          abandonedNow: 0,
          rows: [...listGates("t5"), rb],
        };
      },
    })!;
    expect(
      await hook(stopInput("Listo."), undefined, {
        signal: new AbortController().signal,
      }),
    ).toEqual({});
    const row = getDatabase()
      .prepare(`SELECT name, attrs FROM task_trace_events WHERE task_id = 't5'`)
      .all() as Array<{ name: string; attrs: string }>;
    expect(row.map((r) => r.name)).toEqual(["gates.hook_allowed"]);
    expect(JSON.parse(row[0].attrs)).toMatchObject({ failed: 1, total: 2 });
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
    expect(traces("t3")).toEqual(["gates.hook_blocked", "gates.hook_allowed"]);
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

describe("ruling 3c, audit round 5 — evidence scrubbed before the 160-char cut", () => {
  it("a stored value straddling char 160 of the evidence never leaks as a fragment", async () => {
    const { resetSecretRefsForTest, secretPlaceholder } = await import(
      "../secret-refs.js"
    );
    const stored = "sh-" + "k".repeat(20);
    getDatabase()
      .prepare("INSERT INTO user_facts (category, key, value) VALUES (?, ?, ?)")
      .run("projects", "acme_ftp_password", stored);
    resetSecretRefsForTest();
    declareGates("t5", [{ criterion: "deploy ok", check: "cmd" }], "submission");
    // 150 filler chars, so a plain slice(0,160) would keep "sh-kkkkkkk".
    const evidence = "e".repeat(150) + stored + " tail";
    const hook = makeGatesStopHook("t5", {
      env: ARMED,
      evaluate: async () => {
        recordGateResult("t5", "G1", { state: "failed", evidence });
        const rows = listGates("t5");
        return {
          verdict: "failed",
          total: 1,
          met: 0,
          failed: 1,
          pending: 0,
          abandoned: 0,
          failedRows: rows,
          pendingRows: [],
          abandonedRows: [],
          ran: 1,
          abandonedNow: 0,
          rows,
        };
      },
    })!;
    const blocked = (await hook(stopInput("Listo."), undefined, {
      signal: new AbortController().signal,
    })) as { reason: string };
    expect(blocked.reason).not.toContain("sh-kkk");
    expect(blocked.reason).toContain(
      secretPlaceholder("SECRET_PROJECTS_ACME_FTP_PASSWORD").slice(0, 9),
    );
    resetSecretRefsForTest();
  });
});

describe("own deadline + trace (landscape [a16])", () => {
  afterEach(() => vi.useRealTimers());

  function traceRows(
    taskId: string,
  ): Array<{ name: string; attrs: Record<string, unknown> }> {
    return (
      getDatabase()
        .prepare(
          `SELECT name, attrs FROM task_trace_events WHERE task_id = ? ORDER BY id`,
        )
        .all(taskId) as Array<{ name: string; attrs: string | null }>
    ).map((r) => ({ name: r.name, attrs: JSON.parse(r.attrs ?? "{}") }));
  }

  /** A FAILED G1 result, recorded in the ledger like the real evaluate would. */
  function failedResult(taskId: string): EvaluateResult {
    recordGateResult(taskId, "G1", { state: "failed", evidence: "1 failed" });
    const rows = listGates(taskId);
    return {
      verdict: "failed",
      total: 1,
      met: 0,
      failed: 1,
      pending: 0,
      abandoned: 0,
      failedRows: rows,
      pendingRows: [],
      abandonedRows: [],
      ran: 1,
      abandonedNow: 0,
      shellSkipped: 0,
      budgetExhausted: 0,
      rows,
    };
  }

  const never = (): Promise<EvaluateResult> => new Promise(() => {});

  it("invariant: the SDK matcher timeout stays 180 s and above the hook's own deadline", () => {
    expect(STOP_HOOK_SDK_TIMEOUT_S).toBe(180);
    expect(STOP_HOOK_SDK_TIMEOUT_S * 1000).toBeGreaterThan(
      STOP_HOOK_DEADLINE_MS,
    );
  });

  it("deadline: an evaluation that never ends allows the stop and records hook_released reason=deadline; no timer left", async () => {
    vi.useFakeTimers();
    declareGates("d1", [{ criterion: "a", check: "x" }], "submission");
    const hook = makeGatesStopHook("d1", {
      env: ARMED,
      deadlineMs: 50,
      evaluate: never,
    })!;
    const p = hook(stopInput("done"), undefined, {
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(await p).toEqual({});
    const rows = traceRows("d1");
    expect(rows.map((r) => r.name)).toEqual(["gates.hook_released"]);
    expect(rows[0].attrs.reason).toBe("deadline");
    expect(rows[0].attrs.deadline_ms).toBe(50);
    expect(rows[0].attrs.elapsed_ms).toBeTypeOf("number");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("deadline clears the block counter: the next failing stop starts at block 1", async () => {
    vi.useFakeTimers();
    declareGates("d2", [{ criterion: "a", check: "x" }], "submission");
    let hang = false;
    const hook = makeGatesStopHook("d2", {
      env: ARMED,
      deadlineMs: 50,
      evaluate: async () => (hang ? never() : failedResult("d2")),
    })!;
    const sig = { signal: new AbortController().signal };
    const first = await hook(stopInput("x"), undefined, sig);
    expect((first as { reason: string }).reason).toContain(
      `(block 1/${MAX_HOOK_BLOCKS})`,
    );
    hang = true;
    const p = hook(stopInput("x"), undefined, sig);
    await vi.advanceTimersByTimeAsync(50);
    expect(await p).toEqual({});
    hang = false;
    const third = await hook(stopInput("x"), undefined, sig);
    expect((third as { reason: string }).reason).toContain(
      `(block 1/${MAX_HOOK_BLOCKS})`,
    );
    expect(traceRows("d2").map((r) => r.name)).toEqual([
      "gates.hook_blocked",
      "gates.hook_released",
      "gates.hook_blocked",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a FAILED result that lands after the deadline is ignored — one trace, no hook_blocked, no state write", async () => {
    vi.useFakeTimers();
    declareGates("d3", [{ criterion: "a", check: "x" }], "submission");
    let late = true;
    const hook = makeGatesStopHook("d3", {
      env: ARMED,
      deadlineMs: 50,
      evaluate: () =>
        late
          ? new Promise((resolve) =>
              setTimeout(() => resolve(failedResult("d3")), 60),
            )
          : Promise.resolve(failedResult("d3")),
    })!;
    const sig = { signal: new AbortController().signal };
    const p = hook(stopInput("done"), undefined, sig);
    await vi.advanceTimersByTimeAsync(50);
    expect(await p).toEqual({});
    await vi.advanceTimersByTimeAsync(10);
    expect(traceRows("d3").map((r) => r.name)).toEqual(["gates.hook_released"]);
    expect(vi.getTimerCount()).toBe(0);
    // The late result wrote no block state: the next failing stop is block 1.
    late = false;
    const next = await hook(stopInput("x"), undefined, sig);
    expect((next as { reason: string }).reason).toContain(
      `(block 1/${MAX_HOOK_BLOCKS})`,
    );
  });

  it("abort: the SDK's signal firing mid-evaluate allows the stop with reason=aborted", async () => {
    vi.useFakeTimers();
    declareGates("d4", [{ criterion: "a", check: "x" }], "submission");
    const hook = makeGatesStopHook("d4", { env: ARMED, evaluate: never })!;
    const ac = new AbortController();
    const p = hook(stopInput("done"), undefined, { signal: ac.signal });
    await vi.advanceTimersByTimeAsync(5);
    ac.abort();
    expect(await p).toEqual({});
    const rows = traceRows("d4");
    expect(rows.map((r) => r.name)).toEqual(["gates.hook_released"]);
    expect(rows[0].attrs).toMatchObject({
      reason: "aborted",
      deadline_ms: STOP_HOOK_DEADLINE_MS,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fast path: allowed/blocked traces carry elapsed_ms; a hook called without options still works", async () => {
    declareGates("d5", [{ criterion: "a", check: "x" }], "submission");
    let pass = false;
    const hook = makeGatesStopHook("d5", {
      env: ARMED,
      evaluate: async () => {
        if (!pass) return failedResult("d5");
        recordGateResult("d5", "G1", { state: "met", evidence: "ok" });
        return { ...failedResult("d5"), failed: 0, met: 1, failedRows: [] };
      },
    })!;
    expect(await hook(stopInput("x"), undefined, {} as never)).toMatchObject({
      decision: "block",
    });
    pass = true;
    expect(
      await (hook as (i: StopHookInput) => Promise<unknown>)(stopInput("x")),
    ).toEqual({});
    const rows = traceRows("d5");
    expect(rows.map((r) => r.name)).toEqual([
      "gates.hook_blocked",
      "gates.hook_allowed",
    ]);
    for (const r of rows) {
      expect(r.attrs.elapsed_ms).toBeTypeOf("number");
      expect(r.attrs.elapsed_ms as number).toBeGreaterThanOrEqual(0);
    }
  });

  it("budget cap: evaluate gets min(ledger budget, deadline − 10 s)", async () => {
    declareGates("d6", [{ criterion: "a", check: "x" }], "submission");
    const seen: Array<number | undefined> = [];
    const spy = async (opts: EvaluateOptions): Promise<EvaluateResult> => {
      seen.push(opts.budgetMs);
      return { ...failedResult("d6"), failed: 0, met: 1, failedRows: [] };
    };
    const sig = { signal: new AbortController().signal };
    const call = async (deps: {
      env: NodeJS.ProcessEnv;
      deadlineMs?: number;
    }): Promise<void> => {
      await makeGatesStopHook("d6", { ...deps, evaluate: spy })!(
        stopInput("x"),
        undefined,
        sig,
      );
    };
    // Defaults: 120 s ledger budget < 150 s − 10 s.
    await call({ env: ARMED });
    // Operator env past the deadline: the cap wins.
    const big = { ...ARMED, TASK_GATES_LEDGER_BUDGET_MS: "600000" };
    await call({ env: big });
    // A large deadline: the env / default wins.
    await call({ env: big, deadlineMs: 10_000_000 });
    await call({ env: ARMED, deadlineMs: 10_000_000 });
    // A deadline under the margin never yields a non-positive budget.
    await call({ env: ARMED, deadlineMs: 50 });
    expect(seen).toEqual([
      Math.min(ledgerBudgetMs(ARMED), STOP_HOOK_DEADLINE_MS - 10_000),
      STOP_HOOK_DEADLINE_MS - 10_000,
      600_000,
      ledgerBudgetMs(ARMED),
      1_000,
    ]);
    expect(seen[0]).toBe(120_000);
    expect(seen[1]).toBe(140_000);
  });
});

describe("audit folds 2026-10-09 (L5)", () => {
  afterEach(() => vi.useRealTimers());

  function traceRows(
    taskId: string,
  ): Array<{ name: string; attrs: Record<string, unknown> }> {
    return (
      getDatabase()
        .prepare(
          `SELECT name, attrs FROM task_trace_events WHERE task_id = ? ORDER BY id`,
        )
        .all(taskId) as Array<{ name: string; attrs: string | null }>
    ).map((r) => ({ name: r.name, attrs: JSON.parse(r.attrs ?? "{}") }));
  }

  it("W1: a signal aborted BEFORE the call never starts an evaluation", async () => {
    vi.useFakeTimers();
    declareGates("f1", [{ criterion: "a", check: "x" }], "submission");
    let calls = 0;
    const hook = makeGatesStopHook("f1", {
      env: ARMED,
      evaluate: async () => {
        calls++;
        return new Promise(() => {});
      },
    })!;
    const ac = new AbortController();
    ac.abort();
    expect(
      await hook(stopInput("done"), undefined, { signal: ac.signal }),
    ).toEqual({});
    expect(calls).toBe(0);
    const rows = traceRows("f1");
    expect(rows.map((r) => r.name)).toEqual(["gates.hook_released"]);
    expect(rows[0].attrs.reason).toBe("aborted");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("W2: an evaluate that REJECTS after the deadline records nothing more — no {error} trace", async () => {
    vi.useFakeTimers();
    declareGates("f2", [{ criterion: "a", check: "x" }], "submission");
    const hook = makeGatesStopHook("f2", {
      env: ARMED,
      deadlineMs: 50,
      evaluate: () =>
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error("SQLITE_BUSY")), 60),
        ),
    })!;
    const p = hook(stopInput("done"), undefined, {
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(await p).toEqual({});
    await vi.advanceTimersByTimeAsync(10);
    const rows = traceRows("f2");
    expect(rows.map((r) => r.name)).toEqual(["gates.hook_released"]);
    expect(rows[0].attrs.reason).toBe("deadline");
    expect(rows[0].attrs).not.toHaveProperty("error");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("R1: the abort listener is removed once the fast path commits", async () => {
    declareGates("f3", [{ criterion: "a", check: "x" }], "submission");
    const hook = makeGatesStopHook("f3", {
      env: ARMED,
      evaluate: async () => {
        const rows = listGates("f3");
        return {
          verdict: "met",
          total: 1,
          met: 1,
          failed: 0,
          pending: 0,
          abandoned: 0,
          failedRows: [],
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
    const ac = new AbortController();
    const added = vi.spyOn(ac.signal, "addEventListener");
    const removed = vi.spyOn(ac.signal, "removeEventListener");
    expect(
      await hook(stopInput("done"), undefined, { signal: ac.signal }),
    ).toEqual({});
    expect(added).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledTimes(1);
    expect(removed.mock.calls[0][0]).toBe("abort");
    expect(removed.mock.calls[0][1]).toBe(added.mock.calls[0][1]);
    ac.abort();
    expect(traceRows("f3").map((r) => r.name)).toEqual(["gates.hook_allowed"]);
    removed.mockRestore();
    added.mockRestore();
  });
});
