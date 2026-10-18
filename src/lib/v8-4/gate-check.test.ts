/**
 * V8.4 gate-check runner: EXPECT decides over exit code, timeouts fail with
 * evidence and kill the process group, evaluateLedger honors ABANDON, never
 * touches manual gates, and only re-runs met gates on `rerun`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// qa R5 W5-3: the shim-missing branch of runShellCheck is pinned by flipping the probe.
const shimProbe = vi.hoisted(() => ({ missing: null as string | null }));
vi.mock("../../tools/builtin/shell.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../tools/builtin/shell.js")>();
  return { ...actual, pmShimMissing: (dir?: string) => shimProbe.missing ?? actual.pmShimMissing(dir) };
});
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import { declareGates, gateSpecsFromGoal, listGates, recordGateResult } from "./gates.js";
import {
  DEFAULT_LEDGER_BUDGET_MS,
  evaluateLedger,
  evidenceTail,
  expectMatches,
  hasRunnableGates,
  isReadOnlyCheck,
  ledgerBudgetMs,
  resolveCheckCommand,
  resolveCheckCwd,
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

describe("expectMatches — comparators read the last line as a number", () => {
  it("passes and fails by the comparator, never by substring", () => {
    expect(expectMatches("gt 0", "header\n3\n")).toBe(true);
    expect(expectMatches("gt 0", "0")).toBe(false);
    expect(expectMatches("gte 3", "2")).toBe(false);
    expect(expectMatches("eq 200", "200")).toBe(true);
    expect(expectMatches("between 2 4", "4")).toBe(true);
    expect(expectMatches("lte 0", "0")).toBe(true);
  });

  it("a non-numeric last line never passes a comparator", () => {
    expect(expectMatches("gt 0", "5 rows")).toBe(false);
    expect(expectMatches("gt 0", "")).toBe(false);
    expect(expectMatches("gt 0", "3\nerror: boom")).toBe(false);
  });

  it("regex and substring behave exactly as before", () => {
    expect(expectMatches("/[0-9]/", "0")).toBe(true); // legacy rows still evaluate; new ones are refused at write time
    expect(expectMatches("200", "HTTP 200 OK")).toBe(true);
  });
});

describe("legacy ledger rows keep evaluating after the write-time rule (read path unchanged)", () => {
  it("a row declared before 2026-09-12 with /[0-9]/ still runs and still matches", async () => {
    // Inserted directly: declareGates would now abandon this shape.
    getDatabase()
      .prepare(
        `INSERT INTO task_gates (task_id, gate_id, criterion, check_kind, check_cmd, expect, source, state)
         VALUES ('t-legacy', 'L1', 'legacy count', 'shell', 'grep -c x f', '/[0-9]/', 'plan', 'pending')`,
      )
      .run();
    const exec: CheckExecutor = async () => ({ output: "0\n", exitCode: 0, timedOut: false });
    const v = await evaluateLedger({ taskId: "t-legacy", exec, timeoutMs: 1000 });
    expect(v.ran).toBe(1);
    expect(listGates("t-legacy")[0]).toMatchObject({ state: "met", evidence: "0" });
  });
});

describe("runCheck — $MC_TASK_ID is defined for the guard exactly as for the child", () => {
  it("the tweet ritual's check (task_id='$MC_TASK_ID') runs instead of being abandoned as undefined (nightly 2026-09-04 → 09-11)", async () => {
    let calls = 0;
    const exec: CheckExecutor = async () => {
      calls++;
      return { output: "n\n-\n1\n", exitCode: 0, timedOut: false };
    };
    const row = {
      check_cmd:
        "./mc-ctl db \"SELECT COUNT(*) AS n FROM task_trace_events WHERE task_id='$MC_TASK_ID' AND tool='tweet_post'\"",
      expect: "gt 0",
    };
    const withTask = await runCheck(row, { timeoutMs: 1000, exec, taskId: "t-ritual" });
    expect(withTask).toMatchObject({ ok: true, evidence: "- | 1" });
    expect(withTask.notRunnable).toBeUndefined();
    // No task id: the child still gets MC_TASK_ID="" (defined), so the guard must agree.
    const withoutTask = await runCheck(row, { timeoutMs: 1000, exec });
    expect(withoutTask.notRunnable).toBeUndefined();
    expect(calls).toBe(2);
    // A variable nobody defines is still caught.
    const other = await runCheck(
      { check_cmd: 'test -n "$DOC_ID"', expect: null },
      { timeoutMs: 1000, exec, taskId: "t-ritual" },
    );
    expect(other).toMatchObject({ ok: false, notRunnable: true });
    expect(calls).toBe(2);
  });
});

describe("runCheck — comparator evidence", () => {
  it("a comparator against a non-numeric last line FAILS and says so; a numeric miss fails plainly", async () => {
    const exec: CheckExecutor = async (cmd) => ({
      output: cmd.includes("rows") ? "5 rows\n" : "0\n",
      exitCode: 0,
      timedOut: false,
    });
    const notNumber = await runCheck(
      { check_cmd: "printme rows", expect: "gt 0" },
      { timeoutMs: 1000, exec },
    );
    expect(notNumber.ok).toBe(false);
    expect(notNumber.notRunnable).toBeUndefined();
    expect(notNumber.evidence).toMatch(/^not a number: 5 rows/);
    const miss = await runCheck(
      { check_cmd: "printme count", expect: "gt 0" },
      { timeoutMs: 1000, exec },
    );
    expect(miss.ok).toBe(false);
    expect(miss.evidence).toBe("0 (exit 0)");
    const hit = await runCheck(
      { check_cmd: "printme count", expect: "lte 0" },
      { timeoutMs: 1000, exec },
    );
    expect(hit).toMatchObject({ ok: true, evidence: "0" });
  });
});

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
  it("fails closed when the package-manager shim is missing: no child spawns (qa R4 W-1)", async () => {
    shimProbe.missing = "[pm-shim] missing: /nowhere/npm — test";
    try {
      const r = await runShellCheck("echo CHILD-RAN", { timeoutMs: 5000 });
      expect(r).toEqual({ output: "[pm-shim] missing: /nowhere/npm — test", exitCode: 126, timedOut: false });
    } finally {
      shimProbe.missing = null;
    }
  });
  it("writes a journal line when the check's output carries a package-manager shim refusal", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await runShellCheck("echo '[pm-shim] refused: probe' >&2; exit 1", { timeoutMs: 5000 });
      expect(r.exitCode).toBe(1);
      expect(spy.mock.calls.map((c) => String(c[0]))).toContainEqual(expect.stringMatching(/^\[pm-shim\] refused \(check_cmd\): echo/));
      spy.mockClear();
      await runShellCheck("echo plain >&2; exit 1", { timeoutMs: 5000 });
      expect(spy.mock.calls.map((c) => String(c[0])).some((l) => l.includes("[pm-shim] refused"))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
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
  it("a check the shell_exec guard would block never spawns and is ABANDONED (notRunnable) with the reason", async () => {
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
      // Observes nothing → abandoned, never a FAILED gate that demotes the task.
      expect(r.notRunnable, cmd).toBe(true);
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

  it("the docker rule (ruling 5) applies to checks: data-reaching verbs never spawn, the psql form runs", async () => {
    let spawned = 0;
    const exec: CheckExecutor = async () => {
      spawned++;
      return { output: "1", exitCode: 0, timedOut: false };
    };
    for (const cmd of [
      "docker cp supabase-db:/var/lib/postgresql/data/pg_hba.conf /tmp/x",
      "docker run --rm -v /:/h alpine ls /h/root",
      "docker exec supabase-db cat /etc/hostname",
    ]) {
      const r = await runCheck({ check_cmd: cmd, expect: null }, { timeoutMs: 1000, exec });
      expect(r.notRunnable, cmd).toBe(true);
      expect(r.evidence, cmd).toMatch(/^check rejected by shell guard: .*operator ruling 2026-10-01/);
    }
    expect(spawned).toBe(0);
    const ok = await runCheck(
      { check_cmd: "docker exec supabase-db psql -U mcp_readonly -tA -c 'select 1'", expect: "1" },
      { timeoutMs: 1000, exec },
    );
    expect(spawned).toBe(1);
    expect(ok.ok).toBe(true);
  });

  it("a `/dev/null;` discard runs (task 60c6bf31); a real refusal keeps its exact evidence text", async () => {
    let spawned = 0;
    const exec: CheckExecutor = async () => {
      spawned++;
      return { output: "1", exitCode: 0, timedOut: false };
    };
    // The planner's `2>/dev/null` with a glued `;` used to be ABANDONED as
    // "write to '/dev/null;' outside allowed paths".
    const ok = await runCheck(
      { check_cmd: "grep -ic x /a/b 2>/dev/null; echo done", expect: null },
      { timeoutMs: 1000, exec },
    );
    expect(ok.notRunnable).toBeUndefined();
    expect(spawned).toBe(1);
    // A real write outside the allow-list: the evidence text is unchanged, and
    // the glued form now names the path bash writes (`/var/y`, not `/var/y;`).
    for (const cmd of ["echo x > /var/y", "echo x >/var/y; echo done"]) {
      const refused = await runCheck(
        { check_cmd: cmd, expect: null },
        { timeoutMs: 1000, exec },
      );
      expect(refused.notRunnable, cmd).toBe(true);
      expect(refused.evidence, cmd).toBe(
        "check rejected by shell guard: write to '/var/y' outside allowed paths",
      );
    }
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

// ---------------------------------------------------------------------------
// 2026-10-08 swarm 19b7d51a: KB-relative check paths run from the KB root
// ---------------------------------------------------------------------------
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** The live read-only shapes (queue 4d): moved to the KB root / rewritten when they name a KB path. */
const READ_ONLY = (p: string, q: string): string[] => [
  `grep -c '^# ' ${p}`,
  `test -f ${p}`,
  `wc -l ${p}`,
  `diff ${p} ${q}`,
  `jq .x ${p}`,
  `cat ${p} | head -5`,
  `grep -c '^# ' ${p} | wc -l`,
  `test -f ${p} && grep -q x ${p}`,
  `grep 'a;b' ${p}`,
  `grep 'a''b' ${p}`,
  `grep -c x ${p} 2>/dev/null`,
  `grep 'a\\.b' ${p}`,
  `grep -q x ${p} 2>/dev/null | wc -l`,
];

/** Shapes that can write (qa R1 + R2, verified on the host): never moved, never rewritten. */
const NOT_READ_ONLY = (p: string): string[] => [
  `awk -i inplace '{print}' ${p}`,
  `sed --i s/a/b/ ${p}`,
  `sed --in-pl s/a/b/ ${p}`,
  `sed -n 1p ${p}`,
  `sort --o=${p} ${p}`,
  `sort --outp ${p} ${p}`,
  `uniq ${p} ${p}`,
  `sed 's/a/b/gw ${p}' ${p}`,
  `sed -n 1w${p} ${p}`,
  `sed 's|x|cmd|ge' ${p}`,
  `xargs --process-slot-var grep curl -o ${p} https://example.com/a`,
  `curl -s -o ${p} https://example.com/a`,
  `wget -q -O ${p} https://example.com/a`,
  `rsync -a /tmp/x/ ${p}`,
  `tar -xf a.tar -C ${p}`,
  `chmod 000 ${p}`,
  `find ${p} -delete`,
  `find ${p} -exec rm {} ;`,
  `python3 -c 'open("x","w")' ${p}`,
  `node -e 'require("fs")' ${p}`,
  `cat ${p} | tee ${p}`,
  `cat ${p} | xargs -0 curl -o ${p}`,
  `env VAR=1 curl -o ${p} https://example.com/a`,
  `FOO=1 curl -o ${p} https://example.com/a`,
  `command curl -o ${p} https://example.com/a`,
  `\\curl -o ${p} https://example.com/a`,
  `cu''rl -o ${p} https://example.com/a`,
  `grep x ${p} || curl -o ${p} https://example.com/a`,
  `cp /tmp/a ${p}`,
  // qa R3: an escaped quote opens no span in dash, so the "quoted" text runs.
  `grep -c x ${p} \\'; sed -i s/a/PWNED/ ${p}; echo \\'`,
  `grep x ${p} \\'> E2 \\'`,
  `grep x ${p} \\'; sh -c id; touch E3; echo \\'`,
  `grep x ${p} # '\ntouch E4\n'`,
  `grep x ${p} && echo \\' && cp /tmp/a E5 && echo \\'`,
  // qa W1: substitutions inside double quotes, a heredoc body.
  `echo "$(touch x)"; grep -c x ${p}`,
  `echo "\`touch x\`"; grep -c x ${p}`,
  `grep x ${p} <<E\n$(touch x)\nE\ntrue`,
  `grep "'" ${p}; touch E8; echo "'"`,
  `grep x ${p} # c`,
  `grep 'x ${p}`,
  `grep x ${p} & touch E6`,
  `grep x ${p} |& tail -1`,
  // qa R4 W1/W2: no assignment prefix is skipped, quoted or not.
  `VAR=1 grep x ${p}`,
  `'X'=y cat ${p}`,
  `X'='y cat ${p}`,
  `'X=y' cat ${p}`,
  `LD_PRELOAD=/tmp/x.so cat ${p}`,
  `HOME=projects jq . ${p}`,
  // Only the literal word 2>/dev/null is a tolerated redirect.
  `grep x ${p} 2>&1 | tail -1`,
  `grep x ${p} 2>&1`,
  `grep x ${p} 2>/dev/null/`,
  `grep x ${p} 2>/dev/nul`,
  `grep x ${p} 2> /dev/null`,
  `grep x ${p} >/dev/null`,
  `grep x ${p} 1>/dev/null`,
  `grep x ${p}2>/dev/null`,
  `grep x < ${p}`,
  `grep 'a\nb' ${p}`,
];

describe("resolveCheckCwd — KB-relative paths run from the KB root (swarm 19b7d51a, 2026-10-08)", () => {
  let kbRoot: string;
  let procCwd: string;
  beforeEach(() => {
    kbRoot = mkdtempSync(join(tmpdir(), "gate-cwd-kb-"));
    procCwd = mkdtempSync(join(tmpdir(), "gate-cwd-proc-"));
    mkdirSync(join(kbRoot, "projects/bet-book"), { recursive: true });
    writeFileSync(join(kbRoot, "projects/bet-book/README.md"), "Índice propuesto\n");
    mkdirSync(join(procCwd, "src"), { recursive: true });
    writeFileSync(join(procCwd, "src/index.ts"), "x\n");
  });
  afterEach(() => {
    rmSync(kbRoot, { recursive: true, force: true });
    rmSync(procCwd, { recursive: true, force: true });
  });

  it("an explicit cwd always wins", () => {
    expect(
      resolveCheckCwd("grep -c x projects/bet-book/README.md", { cwd: "/explicit", kbRoot, processCwd: procCwd }),
    ).toBe("/explicit");
  });

  it("a path that exists only under the KB root resolves to the KB root (the live grep shape; the wc `<` shape no longer moves, queue 4d R3)", () => {
    const deps = { kbRoot, processCwd: procCwd };
    expect(resolveCheckCwd("grep -c 'Índice propuesto' projects/bet-book/README.md", deps)).toBe(kbRoot);
    expect(resolveCheckCwd("wc -c < projects/bet-book/README.md", deps)).toBeUndefined();
    writeFileSync(join(kbRoot, "projects/bet-book/marco-legal-2026-10-07.md"), "x".repeat(10));
    expect(resolveCheckCwd("wc -c <projects/bet-book/marco-legal-2026-10-07.md", deps)).toBeUndefined();
  });

  it("a path that exists under BOTH the checkout and the KB root keeps the default cwd (qa W2)", () => {
    mkdirSync(join(procCwd, "projects/bet-book"), { recursive: true });
    writeFileSync(join(procCwd, "projects/bet-book/README.md"), "x\n");
    expect(resolveCheckCwd("grep -c x projects/bet-book/README.md", { kbRoot, processCwd: procCwd })).toBeUndefined();
  });

  it("a mixed command naming a checkout-only path and a KB-only path keeps the default cwd (qa W3)", () => {
    writeFileSync(join(procCwd, "src/x.ts"), "x\n");
    writeFileSync(join(kbRoot, "projects/y.md"), "y\n");
    const deps = { kbRoot, processCwd: procCwd };
    expect(resolveCheckCwd("diff src/x.ts projects/y.md", deps)).toBeUndefined();
    expect(resolveCheckCwd("diff projects/y.md src/x.ts", deps)).toBeUndefined();
  });

  it("a write-shaped command is never moved, even when its path exists only under the KB root (qa W1)", () => {
    mkdirSync(join(kbRoot, "directives"), { recursive: true });
    writeFileSync(join(kbRoot, "directives/core.md"), "live\n");
    writeFileSync(join(kbRoot, "projects/a.md"), "x\n");
    const deps = { kbRoot, processCwd: procCwd };
    for (const cmd of [
      ": > directives/core.md",
      "echo x >> projects/a.md",
      "echo x >| projects/a.md",
      'echo x > "projects/a.md"',
      "sed -i s/a/b/ projects/a.md",
      "perl -pi -e s/a/b/ projects/a.md",
      "tee projects/a.md",
      "cat projects/a.md | tee projects/a.md",
      "cp projects/a.md projects/b.md",
      "mv projects/a.md projects/b.md",
      "rm projects/a.md",
      "/bin/rm projects/a.md",
      "touch projects/a.md",
      "truncate -s 0 projects/a.md",
      "dd if=/dev/zero of=projects/a.md",
      "ln -sf x projects/a.md",
      "mkdir projects/a.md/sub",
      "install -m 644 x projects/a.md",
    ]) {
      expect(resolveCheckCwd(cmd, deps), cmd).toBeUndefined();
    }
    // Only the literal 2>/dev/null redirect is tolerated (queue 4d R3).
    for (const cmd of ["grep -c x projects/a.md 2>&1 | tail -1", "grep -c x projects/a.md >/dev/stderr"]) {
      expect(resolveCheckCwd(cmd, deps), cmd).toBeUndefined();
    }
    // The literal 2>/dev/null and a quoted '>' still move.
    for (const cmd of [
      "grep -c x projects/a.md 2>/dev/null",
      "grep -c '>' projects/a.md",
      "head -1 projects/a.md",
    ]) {
      expect(resolveCheckCwd(cmd, deps), cmd).toBe(kbRoot);
    }
  });

  it("a path that exists under the process cwd keeps the default cwd", () => {
    expect(resolveCheckCwd("grep -c x src/index.ts", { kbRoot, processCwd: procCwd })).toBeUndefined();
  });

  it("a path missing in both places keeps the default cwd (the check still fails)", () => {
    expect(resolveCheckCwd("grep -c x projects/bet-book/missing.md", { kbRoot, processCwd: procCwd })).toBeUndefined();
  });

  it("absolute, ./, ../, ~, $ and flag tokens are never redirected", () => {
    const deps = { kbRoot, processCwd: procCwd, exists: (p: string) => p.startsWith(kbRoot) };
    for (const cmd of [
      `grep -c x ${join(kbRoot, "projects/bet-book/README.md")}`,
      "grep -c x ./projects/bet-book/README.md",
      "grep -c x ../projects/bet-book/README.md",
      "grep -c x ~/projects/bet-book/README.md",
      "grep -c x $HOME/projects/bet-book/README.md",
      "grep --file=projects/bet-book/README.md x",
    ]) {
      expect(resolveCheckCwd(cmd, deps), cmd).toBeUndefined();
    }
  });

  it("a URL inside the command is not treated as a path", () => {
    const seen: string[] = [];
    const exists = (p: string): boolean => {
      seen.push(p);
      return p.startsWith(kbRoot);
    };
    expect(
      resolveCheckCwd("curl -s https://example.com/projects/bet-book/README.md", { kbRoot, processCwd: procCwd, exists }),
    ).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it("a single-quoted path token resolves; a double-quoted one is outside the grammar (queue 4d R3)", () => {
    const deps = { kbRoot, processCwd: procCwd };
    expect(resolveCheckCwd("grep -c x 'projects/bet-book/README.md'", deps)).toBe(kbRoot);
    expect(resolveCheckCwd('grep -c x "projects/bet-book/README.md"', deps)).toBeUndefined();
  });
});

describe("evaluateLedger — shell gates on KB-relative paths run from the KB root (swarm 19b7d51a)", () => {
  let kbRoot: string;
  let savedKb: string | undefined;
  beforeEach(() => {
    kbRoot = mkdtempSync(join(tmpdir(), "gate-cwd-eval-kb-"));
    mkdirSync(join(kbRoot, "projects/zz-gate-cwd-test"), { recursive: true });
    writeFileSync(join(kbRoot, "projects/zz-gate-cwd-test/README.md"), "Índice propuesto\n");
    savedKb = process.env.JARVIS_KB_MIRROR_DIR;
    process.env.JARVIS_KB_MIRROR_DIR = kbRoot;
  });
  afterEach(() => {
    if (savedKb === undefined) delete process.env.JARVIS_KB_MIRROR_DIR;
    else process.env.JARVIS_KB_MIRROR_DIR = savedKb;
    rmSync(kbRoot, { recursive: true, force: true });
  });

  it("a KB-relative check runs with cwd = KB root and its evidence says [cwd=kb]; an absolute-path check runs with no cwd and plain evidence", async () => {
    const kbCmd = "grep -c 'Índice propuesto' projects/zz-gate-cwd-test/README.md";
    const absCmd = `grep -c 'Índice propuesto' ${join(kbRoot, "projects/zz-gate-cwd-test/README.md")}`;
    declareGates(
      "t-kbcwd",
      [
        { criterion: "README has the index", check: kbCmd, expect: "gte 1" },
        { criterion: "same file by absolute path", check: absCmd, expect: "gte 1" },
      ],
      "plan",
    );
    const seenCwd: Record<string, string | undefined> = {};
    const exec: CheckExecutor = async (cmd, opts) => {
      seenCwd[cmd] = opts.cwd;
      return { output: "1\n", exitCode: 0, timedOut: false };
    };
    const v = await evaluateLedger({ taskId: "t-kbcwd", exec, timeoutMs: 1000 });
    expect(v.verdict).toBe("met");
    expect(seenCwd[kbCmd]).toBe(kbRoot);
    expect(Object.prototype.hasOwnProperty.call(seenCwd, absCmd)).toBe(true);
    expect(seenCwd[absCmd]).toBeUndefined();
    const rows = Object.fromEntries(listGates("t-kbcwd").map((r) => [r.gate_id, r]));
    expect(rows["G1"]).toMatchObject({ state: "met", evidence: "[cwd=kb] 1" });
    expect(rows["G2"]).toMatchObject({ state: "met", evidence: "1" });
  });

  it("an abandoned check (nothing ran) keeps its plain reason, without the [cwd=kb] prefix (qa R2)", async () => {
    const cmd = 'grep -c "$NOPE_GATE_CWD_VAR" projects/zz-gate-cwd-test/README.md';
    declareGates("t-kbcwd-ab", [{ criterion: "var", check: cmd, expect: "gte 1" }], "plan");
    const exec: CheckExecutor = async () => {
      throw new Error("must not spawn");
    };
    await evaluateLedger({ taskId: "t-kbcwd-ab", exec, timeoutMs: 1000 });
    const row = listGates("t-kbcwd-ab")[0]!;
    expect(row.state).toBe("abandoned");
    expect(row.abandon_reason).toMatch(/^check references undefined variable/);
  });
});

describe("resolveCheckCommand — an absolute path on the guessed root is rewritten to the KB (queue 4d, 2026-10-17)", () => {
  // Synthetic layout: KB at /x/kb, the checkout at /x/repo; /x/projects does not exist.
  const files = new Set([
    "/x/kb/projects/bet-book/README.md",
    "/x/kb/projects/y.md",
    "/x/kb/directives/core.md",
    "/x/repo/src/x.ts",
    "/x/repo/src/foo.test.ts",
    "/x/repo/projects/xpoz-pipeline/README.md",
  ]);
  const deps = {
    kbRoot: "/x/kb",
    processCwd: "/x/repo",
    kbTopDirs: ["projects", "directives", "workspace"],
    exists: (p: string) => files.has(p),
  };

  it("the live shape is rewritten, cwd untouched", () => {
    expect(resolveCheckCommand("grep -c '^# ' /x/projects/bet-book/README.md", deps)).toEqual({
      cwd: undefined,
      command: "grep -c '^# ' /x/kb/projects/bet-book/README.md",
      rewritten: ["/x/projects/bet-book/README.md"],
    });
  });

  it("every occurrence is replaced, and only whole tokens; a repeated token is listed once", () => {
    expect(
      resolveCheckCommand("diff /x/projects/y.md /x/projects/y.md && wc -c /x/projects/y.md.bak", deps),
    ).toEqual({
      cwd: undefined,
      command: "diff /x/kb/projects/y.md /x/kb/projects/y.md && wc -c /x/projects/y.md.bak",
      rewritten: ["/x/projects/y.md"],
    });
  });

  it("a token that merely ends with the guessed path is not touched (leading boundary)", () => {
    expect(resolveCheckCommand("diff /x/projects/y.md /z/x/projects/y.md", deps).command).toBe(
      "diff /x/kb/projects/y.md /z/x/projects/y.md",
    );
  });

  it("a token with a .. or . segment is never rewritten, even when it would land on a real file", () => {
    const d = { ...deps, exists: (p: string) => p === "/x/kb/mission-control/package.json" || files.has(p) };
    for (const cmd of [
      "grep -c x /x/projects/bet-book/../../../mission-control/package.json",
      "grep -c x /x/projects/./bet-book/README.md",
    ]) {
      expect(resolveCheckCommand(cmd, d), cmd).toEqual({ cwd: undefined, command: cmd, rewritten: [] });
    }
  });

  it("single-quoted tokens are rewritten with their quotes kept; a double quote is outside the grammar (queue 4d R3)", () => {
    expect(
      resolveCheckCommand(`grep -c x '/x/projects/y.md' '/x/projects/bet-book/README.md'`, deps).command,
    ).toBe(`grep -c x '/x/kb/projects/y.md' '/x/kb/projects/bet-book/README.md'`);
    const dq = `grep -c x "/x/projects/y.md"`;
    expect(resolveCheckCommand(dq, deps)).toEqual({ cwd: undefined, command: dq, rewritten: [] });
  });

  it("an absolute token that exists on disk is untouched", () => {
    const d = { ...deps, exists: (p: string) => p === "/x/projects/y.md" || files.has(p) };
    expect(resolveCheckCommand("grep -c x /x/projects/y.md", d)).toEqual({
      cwd: undefined,
      command: "grep -c x /x/projects/y.md",
      rewritten: [],
    });
  });

  it("a missing file inside an existing first-level dir of the guessed root is untouched (a real tree, not the KB)", () => {
    const d = { ...deps, exists: (p: string) => p === "/x/projects/bet-book" || files.has(p) };
    expect(resolveCheckCommand("grep -c x /x/projects/bet-book/README.md", d)).toEqual({
      cwd: undefined,
      command: "grep -c x /x/projects/bet-book/README.md",
      rewritten: [],
    });
  });

  it("a token whose KB counterpart does not exist is untouched (the check still fails)", () => {
    expect(resolveCheckCommand("grep -c x /x/projects/missing.md", deps).rewritten).toEqual([]);
  });

  it("a write-shaped command is never rewritten (second guard: a read-only verb with a redirect)", () => {
    for (const cmd of [
      "cat /x/projects/bet-book/README.md > /x/projects/y.md",
      "grep x /x/projects/y.md >> /x/projects/y.md",
    ]) {
      expect(resolveCheckCommand(cmd, deps), cmd).toEqual({ cwd: undefined, command: cmd, rewritten: [] });
    }
  });

  it("no command in the not-read-only table is rewritten (qa C1 replay)", () => {
    for (const cmd of NOT_READ_ONLY("/x/projects/y.md")) {
      expect(resolveCheckCommand(cmd, deps), cmd).toEqual({ cwd: undefined, command: cmd, rewritten: [] });
    }
  });

  it("every command in the read-only table is rewritten", () => {
    for (const cmd of READ_ONLY("/x/projects/y.md", "/x/projects/bet-book/README.md")) {
      const r = resolveCheckCommand(cmd, deps);
      expect(r.rewritten, cmd).toContain("/x/projects/y.md");
      expect(r.command, cmd).toContain(" /x/kb/projects/y.md");
    }
  });

  it("an explicit cwd wins and nothing is rewritten", () => {
    expect(resolveCheckCommand("grep -c x /x/projects/y.md", { ...deps, cwd: "/explicit" })).toEqual({
      cwd: "/explicit",
      command: "grep -c x /x/projects/y.md",
      rewritten: [],
    });
  });

  it("relative, checkout, $VAR and ~ tokens are never rewritten", () => {
    for (const [cmd, cwd] of [
      ["npx vitest run src/foo.test.ts", undefined],
      ["grep -c x projects/xpoz-pipeline/README.md", undefined],
      ["grep -c x projects/y.md", "/x/kb"],
      ["grep -c x $HOME/projects/y.md", undefined],
      ["grep -c x ~/projects/y.md", undefined],
    ] as const) {
      expect(resolveCheckCommand(cmd, deps), cmd).toEqual({ cwd, command: cmd, rewritten: [] });
    }
  });

  it("the mixed-command rule is kept, and a KB-only relative path plus a rewritten one moves to the KB root", () => {
    expect(resolveCheckCommand("diff src/x.ts projects/y.md", deps)).toEqual({
      cwd: undefined,
      command: "diff src/x.ts projects/y.md",
      rewritten: [],
    });
    expect(resolveCheckCommand("diff projects/y.md /x/projects/bet-book/README.md", deps)).toEqual({
      cwd: "/x/kb",
      command: "diff projects/y.md /x/kb/projects/bet-book/README.md",
      rewritten: ["/x/projects/bet-book/README.md"],
    });
  });
});

describe("isReadOnlyCheck — the primary guard before a check is moved or rewritten (queue 4d qa C1/R2)", () => {
  it("every command in the read-only table passes", () => {
    for (const cmd of READ_ONLY("projects/a.md", "projects/b.md")) {
      expect(isReadOnlyCheck(cmd), cmd).toBe(true);
    }
  });

  it("every command in the not-read-only table fails", () => {
    for (const cmd of NOT_READ_ONLY("projects/a.md")) {
      expect(isReadOnlyCheck(cmd), cmd).toBe(false);
    }
  });

  it("resolveCheckCwd moves nothing in the not-read-only table onto the KB root, and moves everything in the read-only table", () => {
    const kb = new Set(["/x/kb/projects/a.md", "/x/kb/projects/b.md"]);
    const deps = { kbRoot: "/x/kb", processCwd: "/x/repo", exists: (p: string) => kb.has(p) };
    for (const cmd of NOT_READ_ONLY("projects/a.md")) {
      expect(resolveCheckCwd(cmd, deps), cmd).toBeUndefined();
    }
    for (const cmd of READ_ONLY("projects/a.md", "projects/b.md")) {
      expect(resolveCheckCwd(cmd, deps), cmd).toBe("/x/kb");
    }
  });
  it("a grammar-accepted check that names a write verb as an argument is NOT moved or rewritten (second guard, accepted false refusal, qa R4 W3)", () => {
    const kb = new Set(["/x/kb/projects/a.md"]);
    const deps = { kbRoot: "/x/kb", processCwd: "/x/repo", exists: (p: string) => kb.has(p), kbTopDirs: ["projects"] };
    expect(isReadOnlyCheck("grep -c mv projects/a.md")).toBe(true);
    expect(resolveCheckCwd("grep -c mv projects/a.md", deps)).toBeUndefined();
    expect(resolveCheckCwd("grep -c x projects/a.md", deps)).toBe("/x/kb");
    expect(resolveCheckCommand("grep -c mv /x/projects/a.md", deps)).toEqual({
      cwd: undefined,
      command: "grep -c mv /x/projects/a.md",
      rewritten: [],
    });
    expect(resolveCheckCommand("grep -c x /x/projects/a.md", deps).rewritten).toEqual(["/x/projects/a.md"]);
  });
});

describe("evaluateLedger — rewritten checks run on the KB path with [cwd=kb-rewrite] evidence (queue 4d)", () => {
  let kbRoot: string;
  let savedKb: string | undefined;
  beforeEach(() => {
    kbRoot = mkdtempSync(join(tmpdir(), "gate-rw-kb-"));
    mkdirSync(join(kbRoot, "zz4drw/bet-book"), { recursive: true });
    writeFileSync(join(kbRoot, "zz4drw/bet-book/README.md"), "# Uno\n");
    writeFileSync(join(kbRoot, "zz4drw/bet-book/notes.md"), "x\n");
    savedKb = process.env.JARVIS_KB_MIRROR_DIR;
    process.env.JARVIS_KB_MIRROR_DIR = kbRoot;
  });
  afterEach(() => {
    if (savedKb === undefined) delete process.env.JARVIS_KB_MIRROR_DIR;
    else process.env.JARVIS_KB_MIRROR_DIR = savedKb;
    rmSync(kbRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("runs the rewritten command, logs the token once per gate, prefixes the evidence once even when the cwd also moved", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const guessed = join(dirname(kbRoot), "zz4drw/bet-book/README.md");
    const real = join(kbRoot, "zz4drw/bet-book/README.md");
    const cmd1 = `grep -c '^# ' ${guessed}`;
    const cmd2 = `cat zz4drw/bet-book/notes.md ${guessed} ${guessed} | wc -l`;
    declareGates(
      "t-rw",
      [
        { criterion: "headings", check: cmd1, expect: "gte 1" },
        { criterion: "both files", check: cmd2, expect: "gte 1" },
      ],
      "plan",
    );
    const seen: Array<[string, string | undefined]> = [];
    const exec: CheckExecutor = async (cmd, opts) => {
      seen.push([cmd, opts.cwd]);
      return { output: "1\n", exitCode: 0, timedOut: false };
    };
    const v = await evaluateLedger({ taskId: "t-rw", exec, timeoutMs: 1000 });
    expect(v.verdict).toBe("met");
    expect(seen).toEqual([
      [`grep -c '^# ' ${real}`, undefined],
      [`cat zz4drw/bet-book/notes.md ${real} ${real} | wc -l`, kbRoot],
    ]);
    const rows = Object.fromEntries(listGates("t-rw").map((r) => [r.gate_id, r]));
    expect(rows["G1"]).toMatchObject({ state: "met", evidence: "[cwd=kb-rewrite] 1" });
    expect(rows["G2"]).toMatchObject({ state: "met", evidence: "[cwd=kb-rewrite] 1" });
    // The stored criterion and command are untouched — the ledger is additions only.
    expect(rows["G1"]!.check_cmd).toBe(cmd1);
    const logged = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("rewritten to the KB root"));
    expect(logged).toEqual([
      `[gates] t-rw G1: absolute KB path rewritten to the KB root: ${guessed}`,
      `[gates] t-rw G2: absolute KB path rewritten to the KB root: ${guessed}`,
    ]);
  });

  it("a plan gate refused at declaration is skipped by evaluation and never FAILS", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const specs = gateSpecsFromGoal("g-1", {
      gates: [
        {
          criterion: "README written",
          check: `grep -c '^# ' ${join(dirname(kbRoot), "zz4drw/bet-book/README.md")}`,
          expect: "gte 1",
        },
      ],
    });
    declareGates("t-rw-ab", specs, "plan");
    const exec: CheckExecutor = async () => {
      throw new Error("must not spawn");
    };
    const v = await evaluateLedger({ taskId: "t-rw-ab", exec, timeoutMs: 1000 });
    expect(v).toMatchObject({ ran: 0, failed: 0, abandoned: 1 });
    expect(listGates("t-rw-ab")[0]).toMatchObject({ state: "abandoned", check_kind: "manual" });
  });
});

describe("ledgerBudgetMs", () => {
  it("default, env override, and junk values fall back to the default", () => {
    expect(ledgerBudgetMs({})).toBe(DEFAULT_LEDGER_BUDGET_MS);
    expect(DEFAULT_LEDGER_BUDGET_MS).toBe(120_000);
    expect(ledgerBudgetMs({ TASK_GATES_LEDGER_BUDGET_MS: "30000" })).toBe(
      30_000,
    );
    for (const junk of ["-5", "0", "NaN", "abc", ""]) {
      expect(ledgerBudgetMs({ TASK_GATES_LEDGER_BUDGET_MS: junk })).toBe(
        DEFAULT_LEDGER_BUDGET_MS,
      );
    }
  });
});
