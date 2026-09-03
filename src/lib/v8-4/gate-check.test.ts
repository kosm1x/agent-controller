/**
 * V8.4 gate-check runner: EXPECT decides over exit code, timeouts fail with
 * evidence and kill the process group, evaluateLedger honors ABANDON, never
 * touches manual gates, and only re-runs met gates on `rerun`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, initDatabase } from "../../db/index.js";
import { declareGates, listGates, recordGateResult } from "./gates.js";
import {
  evaluateLedger,
  evidenceTail,
  expectMatches,
  hasRunnableGates,
  runCheck,
  runShellCheck,
  type CheckExecutor,
  undefinedShellVars,
} from "./gate-check.js";
import type { LandingExec } from "./landing.js";

beforeEach(() => {
  initDatabase(":memory:");
});
afterEach(() => {
  closeDatabase();
});

describe("expectMatches / evidenceTail", () => {
  it("substring by default, /regex/ when wrapped, invalid regex never matches", () => {
    expect(expectMatches("8/8 passed", "x\n8/8 passed\n")).toBe(true);
    expect(expectMatches("/8\\/8 passed/", "8/8 passed")).toBe(true);
    expect(expectMatches("/PASS/i", "pass")).toBe(true);
    expect(expectMatches("/[unclosed/", "[unclosed")).toBe(false);
    expect(expectMatches("done", "nope")).toBe(false);
  });

  it("evidenceTail keeps the last two non-empty lines, capped", () => {
    expect(evidenceTail("a\n\nb\n  c  \n\n")).toBe("b | c");
    expect(evidenceTail("")).toBe("(no output)");
    expect(evidenceTail("x".repeat(1000), 10)).toHaveLength(10);
  });
});

const fakeExec =
  (
    table: Record<
      string,
      { output: string; exitCode: number | null; timedOut?: boolean }
    >,
  ): CheckExecutor =>
  async (command) => {
    const r = table[command];
    if (!r)
      return {
        output: `unknown command ${command}`,
        exitCode: 127,
        timedOut: false,
      };
    return {
      output: r.output,
      exitCode: r.exitCode,
      timedOut: r.timedOut ?? false,
    };
  };

describe("runCheck", () => {
  it("a command that does not exist (the shell's not-found diagnostic) is NOT RUNNABLE — abandoned with the reason, never FAILED (task c4c6ae63, 2026-09-03)", async () => {
    const exec = fakeExec({
      // Real shape: a pipeline — exit status is grep's (1), NOT 127; only the
      // shell's diagnostic line says the command is missing.
      "gdocs_read 1cOi | grep -c Fase": {
        output: "/bin/sh: 1: gdocs_read: not found\n0",
        exitCode: 1,
      },
      "bash-shape": {
        output: "/bin/bash: line 1: gsheets_read: command not found",
        exitCode: 127,
      },
      "grep -q Fase /tmp/doc.txt": { output: "", exitCode: 0 },
      // A check whose OUTPUT merely says "not found" is a real verdict.
      "grep -c 'not found' /tmp/log.txt": {
        output: "3 not found",
        exitCode: 0,
      },
    });
    expect(
      await runCheck(
        { check_cmd: "bash-shape", expect: null },
        { timeoutMs: 1000, exec },
      ),
    ).toMatchObject({ ok: false, notRunnable: true });
    const verdictNotFound = await runCheck(
      { check_cmd: "grep -c 'not found' /tmp/log.txt", expect: null },
      { timeoutMs: 1000, exec },
    );
    expect(verdictNotFound.ok).toBe(true);
    expect(verdictNotFound.notRunnable).toBeUndefined();

    // A check that reads a variable nobody defines here (the planner's
    // `$DOC_ID` from the goal's own run) never spawns and is NOT RUNNABLE.
    const execSpy: CheckExecutor = async () => {
      throw new Error("must not spawn");
    };
    const undefinedVar = await runCheck(
      {
        check_cmd:
          'test -n "$DOC_ID" && curl -s "https://docs.google.com/document/d/$DOC_ID"',
        expect: "200",
      },
      { timeoutMs: 1000, exec: execSpy },
    );
    expect(undefinedVar).toMatchObject({ ok: false, notRunnable: true });
    expect(undefinedVar.evidence).toContain("$DOC_ID");
    expect(undefinedShellVars("echo $HOME $PATH ${HOME} $? $1 $$")).toEqual([]);
    expect(undefinedShellVars("x=$NOPE_A; y=${NOPE_B}", {})).toEqual([
      "NOPE_A",
      "NOPE_B",
    ]);
    const missing = await runCheck(
      { check_cmd: "gdocs_read 1cOi | grep -c Fase", expect: "11" },
      { timeoutMs: 1000, exec },
    );
    expect(missing).toMatchObject({
      ok: false,
      notRunnable: true,
      exitCode: 1,
    });
    expect(missing.evidence).toMatch(/observes nothing.*gdocs_read: not found/);

    declareGates(
      "t-nf",
      [
        {
          criterion: "Doc has the 11 phases",
          check: "gdocs_read 1cOi | grep -c Fase",
          expect: "11",
        },
        {
          criterion: "local copy mentions Fase",
          check: "grep -q Fase /tmp/doc.txt",
        },
      ],
      "plan",
    );
    const v = await evaluateLedger({ taskId: "t-nf", exec, timeoutMs: 1000 });
    const rows = Object.fromEntries(
      listGates("t-nf").map((r) => [r.gate_id, r]),
    );
    expect(rows["G1"]).toMatchObject({
      state: "abandoned",
      abandon_reason: expect.stringContaining("gdocs_read: not found"),
    });
    expect(rows["G2"]!.state).toBe("met");
    expect(v.verdict).toBe("met"); // the missing binary did not fail the ledger
    expect(v.abandonedNow).toBe(1);
    expect(v.failed).toBe(0);
  });

  it("EXPECT decides even when the command exits non-zero; no EXPECT ⇒ exit code decides", async () => {
    const exec = fakeExec({
      grep: { output: "3/3 tiers ok", exitCode: 1 },
      ok: { output: "fine", exitCode: 0 },
      bad: { output: "boom", exitCode: 2 },
    });
    expect(
      await runCheck(
        { check_cmd: "grep", expect: "3/3 tiers ok" },
        { timeoutMs: 1000, exec },
      ),
    ).toMatchObject({
      ok: true,
      evidence: "3/3 tiers ok",
    });
    expect(
      await runCheck(
        { check_cmd: "ok", expect: null },
        { timeoutMs: 1000, exec },
      ),
    ).toMatchObject({ ok: true });
    const bad = await runCheck(
      { check_cmd: "bad", expect: null },
      { timeoutMs: 1000, exec },
    );
    expect(bad.ok).toBe(false);
    expect(bad.evidence).toBe("boom (exit 2)");
    expect(
      await runCheck(
        { check_cmd: null, expect: null },
        { timeoutMs: 1000, exec },
      ),
    ).toMatchObject({
      ok: false,
      evidence: "no CHECK command",
    });
  });

  it("a timeout is FAILED with the timeout as evidence", async () => {
    const exec = fakeExec({
      slow: { output: "partial", exitCode: null, timedOut: true },
    });
    const r = await runCheck(
      { check_cmd: "slow", expect: "never" },
      { timeoutMs: 50, exec },
    );
    expect(r).toMatchObject({ ok: false, timedOut: true });
    expect(r.evidence).toMatch(/timed out after 50ms/);
  });
});

describe("runShellCheck (real subprocess)", () => {
  it("captures output and exit code, and kills a hung process group on timeout", async () => {
    const ok = await runShellCheck("echo hello; echo world >&2", {
      timeoutMs: 5000,
    });
    expect(ok.exitCode).toBe(0);
    expect(ok.output).toContain("hello");
    expect(ok.output).toContain("world");
    const bad = await runShellCheck("exit 3", { timeoutMs: 5000 });
    expect(bad.exitCode).toBe(3);
    const t0 = Date.now();
    const slow = await runShellCheck("sleep 5 & wait", { timeoutMs: 200 });
    expect(slow.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3000);
  }, 10_000);

  it("runs with a minimal environment — service secrets never reach a check", async () => {
    process.env.V84_TEST_SECRET = "s3cret";
    try {
      const r = await runShellCheck(
        'echo "[$V84_TEST_SECRET]"; echo "path=$PATH"',
        { timeoutMs: 5000 },
      );
      expect(r.output).toContain("[]");
      expect(r.output).toMatch(/path=\S+/);
    } finally {
      delete process.env.V84_TEST_SECRET;
    }
  });
});

describe("evaluateLedger", () => {
  it("runs pending shell gates, records met/failed with evidence, and never touches manual gates", async () => {
    declareGates(
      "t1",
      [
        { criterion: "typecheck", check: "tsc", expect: "0 errors" },
        {
          criterion: "tests",
          check: "npx vitest run src/x.test.ts",
          expect: "/(\\d+) passed/",
        },
        { criterion: "reads well" },
      ],
      "submission",
    );
    const exec = fakeExec({
      tsc: { output: "Found 0 errors", exitCode: 0 },
      "npx vitest run src/x.test.ts": {
        output: "Tests 3 failed | 10 passed",
        exitCode: 1,
      },
    });
    const v = await evaluateLedger({ taskId: "t1", exec, timeoutMs: 1000 });
    expect(v.ran).toBe(2);
    expect(v.verdict).toBe("unverified"); // manual gate still pending
    const rows = listGates("t1");
    expect(rows[0]).toMatchObject({ state: "met", evidence: "Found 0 errors" });
    expect(rows[1]).toMatchObject({ state: "met" }); // regex matched "10 passed"
    expect(rows[2]).toMatchObject({ state: "pending", evidence: null });
    expect(rows.every((r) => r.frozen_at !== null)).toBe(true);
  });

  it("does not re-run met gates unless rerun is set; a rerun can regress a gate", async () => {
    declareGates(
      "t2",
      [{ criterion: "c", check: "cmd", expect: "ok" }],
      "submission",
    );
    let calls = 0;
    const exec: CheckExecutor = async () => {
      calls++;
      return {
        output: calls === 1 ? "ok" : "nope",
        exitCode: 0,
        timedOut: false,
      };
    };
    expect((await evaluateLedger({ taskId: "t2", exec })).verdict).toBe("met");
    expect((await evaluateLedger({ taskId: "t2", exec })).verdict).toBe("met");
    expect(calls).toBe(1);
    const re = await evaluateLedger({ taskId: "t2", exec, rerun: true });
    expect(calls).toBe(2);
    expect(re.verdict).toBe("failed");
  });

  it("honors ABANDON lines from the report — only for known gate ids — before running checks", async () => {
    declareGates(
      "t3",
      [
        { criterion: "a", check: "never" },
        { criterion: "b", check: "also-never" },
      ],
      "submission",
    );
    let ran = 0;
    const exec: CheckExecutor = async () => {
      ran++;
      return { output: "x", exitCode: 1, timedOut: false };
    };
    const v = await evaluateLedger({
      taskId: "t3",
      exec,
      outputText:
        "Report.\nABANDON: G1 no oracle in the sandbox\nABANDON: G7 does not exist",
    });
    expect(v.abandonedNow).toBe(1);
    expect(ran).toBe(1); // G1 skipped, G2 ran (and failed)
    expect(v.verdict).toBe("failed");
    expect(listGates("t3")[0]).toMatchObject({
      state: "abandoned",
      abandon_reason: "no oracle in the sandbox",
    });
  });

  it("landing gates use the landing probe: true→met, false→failed, null→stays pending", async () => {
    declareGates(
      "t4",
      [
        { id: "L1", criterion: "landed", kind: "landing" },
        { id: "L2", criterion: "landed", kind: "landing" },
        { id: "L3", criterion: "landed", kind: "landing" },
      ],
      "harness",
    );
    // A landing exec that knows one remote head, no PRs.
    const landingExec: LandingExec = async (cmd, args) => {
      if (cmd === "git" && args[0] === "ls-remote") {
        return {
          stdout: "abc\trefs/heads/main\ndef\trefs/heads/feat/ledger\n",
          exitCode: 0,
        };
      }
      return { stdout: "", exitCode: 1 };
    };
    // Same three gates, one probe each; the report mentions the real branch.
    const v = await evaluateLedger({
      taskId: "t4",
      landingExec,
      outputText: "Pushed branch feat/ledger to origin.",
    });
    expect(v.verdict).toBe("met");
    // A report claiming a branch that is NOT on origin fails; an empty report stays pending.
    declareGates(
      "t5",
      [{ id: "L1", criterion: "landed", kind: "landing" }],
      "harness",
    );
    expect(
      (
        await evaluateLedger({
          taskId: "t5",
          landingExec,
          outputText: "Pushed branch feat/ghost to origin.",
        })
      ).verdict,
    ).toBe("failed");
    declareGates(
      "t6",
      [{ id: "L1", criterion: "landed", kind: "landing" }],
      "harness",
    );
    expect(
      (
        await evaluateLedger({
          taskId: "t6",
          landingExec,
          outputText: "All done.",
        })
      ).verdict,
    ).toBe("unverified");
  });

  it("hasRunnableGates ignores manual and abandoned gates", () => {
    declareGates(
      "t7",
      [{ criterion: "manual" }, { criterion: "shell", check: "true" }],
      "submission",
    );
    expect(hasRunnableGates(listGates("t7"))).toBe(true);
    recordGateResult("t7", "G2", { state: "abandoned", reason: "gone" });
    expect(hasRunnableGates(listGates("t7"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// qa folds 2026-08-16 (C1 guard parity + redaction · C2 regex deadline ·
// W1 container shell-skip · W5 ledger budget · I1 MC_TASK_ID · I3 env guard)
// ---------------------------------------------------------------------------
import { safeRegexTest } from "./gate-check.js";

describe("guard parity (qa C1)", () => {
  it("a check the shell_exec guard would block never spawns and is FAILED with the reason", async () => {
    let spawned = 0;
    const exec: CheckExecutor = async () => {
      spawned++;
      return { output: "", exitCode: 0, timedOut: false };
    };
    for (const cmd of [
      "rm -rf /tmp/x",
      "echo $(cat /etc/passwd)",
      "cat /root/claude/mission-control/.env",
      "sqlite3 data/mc.db 'DELETE FROM tasks'",
    ]) {
      const r = await runCheck(
        { check_cmd: cmd, expect: null },
        { timeoutMs: 1000, exec },
      );
      expect(r.ok, cmd).toBe(false);
      expect(r.evidence, cmd).toMatch(/^check rejected by shell guard: /);
    }
    expect(spawned).toBe(0);
    // A benign check still runs.
    const ok = await runCheck(
      { check_cmd: "echo fine", expect: null },
      { timeoutMs: 1000, exec },
    );
    expect(spawned).toBe(1);
    expect(ok.ok).toBe(true);
    // The unscoped-vitest rule applies to gates too (16GB box).
    const unscoped = await runCheck(
      { check_cmd: "npx vitest run", expect: null },
      { timeoutMs: 1000, exec },
    );
    expect(unscoped.evidence).toMatch(/unscoped `vitest` run/);
    expect(spawned).toBe(1);
  });

  it("evidence is secret-redacted before it is recorded", async () => {
    const exec = fakeExec({
      leak: {
        output: "token=sk-abcdefghijklmnopqrstuvwxyz0123 done",
        exitCode: 0,
      },
    });
    const r = await runCheck(
      { check_cmd: "leak", expect: null },
      { timeoutMs: 1000, exec },
    );
    expect(r.ok).toBe(true);
    expect(r.evidence).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123");
    expect(r.evidence).toContain("done");
  });
});

describe("regex deadline (qa C2)", () => {
  it("a catastrophic pattern returns false quickly instead of wedging the loop", () => {
    const t0 = Date.now();
    // Overlapping alternation — not caught by the nested-quantifier heuristic, so
    // this exercises the vm deadline itself.
    expect(safeRegexTest("(a|aa)+b", "", "a".repeat(40))).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000);
    // Nested quantifiers are rejected outright.
    expect(safeRegexTest("(a+)+b", "", "aaab")).toBe(false);
    expect(safeRegexTest("x**", "", "x")).toBe(false);
    // Sane patterns still work, with flags.
    expect(safeRegexTest("(\\d+) passed", "", "Tests 12 passed")).toBe(true);
    expect(safeRegexTest("PASSED", "i", "3 passed")).toBe(true);
    expect(safeRegexTest("[unclosed", "", "x")).toBe(false);
  });

  it("EXPECT matches against the tail window of a huge output", () => {
    const huge = "x".repeat(300_000) + "\nALL MET";
    expect(expectMatches("ALL MET", huge)).toBe(true);
    expect(expectMatches("/ALL MET$/", huge)).toBe(true);
    // A marker only in the head (older than 64KB) is outside the window.
    expect(expectMatches("HEAD-ONLY", "HEAD-ONLY" + "y".repeat(100_000))).toBe(
      false,
    );
  });
});

describe("container shell-skip (qa W1) + ledger budget (qa W5) + env guards", () => {
  it("shellGatesRunnable=false leaves shell gates pending (counted), still probes landing", async () => {
    declareGates(
      "c1",
      [
        { criterion: "typecheck", check: "tsc", expect: "ok" },
        { id: "L", criterion: "landed", kind: "landing" },
      ],
      "plan",
    );
    let ran = 0;
    const exec: CheckExecutor = async () => {
      ran++;
      return { output: "ok", exitCode: 0, timedOut: false };
    };
    const landingExec: LandingExec = async (cmd, args) =>
      cmd === "git" && args[0] === "ls-remote"
        ? { stdout: "1\trefs/heads/feat/x\n", exitCode: 0 }
        : { stdout: "", exitCode: 1 };
    const v = await evaluateLedger({
      taskId: "c1",
      exec,
      landingExec,
      outputText: "pushed branch feat/x",
      shellGatesRunnable: false,
    });
    expect(ran).toBe(0);
    expect(v.shellSkipped).toBe(1);
    expect(v.verdict).toBe("unverified"); // shell gate pending, landing met
    expect(listGates("c1").map((r) => r.state)).toEqual(["pending", "met"]);
  });

  it("a ledger past its wall-clock budget leaves the remaining runnable gates pending and counts them", async () => {
    declareGates(
      "b1",
      [
        { criterion: "a", check: "x" },
        { criterion: "b", check: "y" },
        { criterion: "c", check: "z" },
      ],
      "submission",
    );
    const exec: CheckExecutor = async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { output: "", exitCode: 0, timedOut: false };
    };
    const v = await evaluateLedger({ taskId: "b1", exec, budgetMs: 10 });
    expect(v.ran).toBe(1); // first gate starts inside the budget
    expect(v.budgetExhausted).toBe(2);
    expect(listGates("b1").map((r) => r.state)).toEqual([
      "met",
      "pending",
      "pending",
    ]);
    expect(v.verdict).toBe("unverified"); // never FAILED by a slow ledger
  });

  it("MC_TASK_ID reaches the check; a malformed timeout env falls back to the default", async () => {
    declareGates("e1", [{ criterion: "id", check: "cmd" }], "submission");
    let seenTimeout = -1;
    let seenTask = "";
    const exec: CheckExecutor = async (_cmd, opts) => {
      seenTimeout = opts.timeoutMs;
      seenTask = opts.taskId ?? "";
      return { output: "", exitCode: 0, timedOut: false };
    };
    const saved = process.env.TASK_GATES_CHECK_TIMEOUT_MS;
    process.env.TASK_GATES_CHECK_TIMEOUT_MS = "60s";
    try {
      await evaluateLedger({ taskId: "e1", exec });
    } finally {
      if (saved === undefined) delete process.env.TASK_GATES_CHECK_TIMEOUT_MS;
      else process.env.TASK_GATES_CHECK_TIMEOUT_MS = saved;
    }
    expect(seenTask).toBe("e1");
    expect(seenTimeout).toBe(60_000);
    // Real subprocess sees MC_TASK_ID.
    const real = await runShellCheck('echo "task=$MC_TASK_ID"', {
      timeoutMs: 5000,
      taskId: "e1",
    });
    expect(real.output).toContain("task=e1");
  });
});
