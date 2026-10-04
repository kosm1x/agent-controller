/**
 * V9 W1 — grader gate specs + declaration: mode/budget parsing, where specs
 * live per mode, the GR- namespace reservation, the model having no writer
 * for a grade row (ABANDON ignored, Stop hook does not wall), the harness
 * setter's guards, and the trace attrs shape. Real in-memory DB.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StopHookInput } from "@anthropic-ai/claude-agent-sdk";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import {
  declareGates,
  formatLedgerBlock,
  listGates,
  recordGateResult,
  renderGatesBlock,
} from "./gates.js";
import { evaluateLedger } from "./gate-check.js";
import { GRADE_PREFIX, isGradeCheck } from "./ledger-lines.js";
import { _resetStopHookState, makeGatesStopHook } from "./stop-hook.js";
import {
  DEFAULT_GRADER_BUDGET_MS,
  GRADE_ID_PREFIX,
  _peekShadowGradeSpecs,
  _resetShadowGradeSpecs,
  abandonPendingGradeRows,
  buildGradedAttrs,
  collectGradeSpecs,
  effectiveGraderMode,
  gradeGateId,
  graderBudgetMs,
  graderMode,
  newGradeSpecPlan,
  TRACE_ATTRS_MAX_CHARS,
  proseGradeSpecsFromGoal,
  recordGradeVerdict,
  registerGradeSpecs,
  syncGradeSpecs,
  takeShadowGradeSpecs,
  withdrawGradeSpecs,
  withdrawGradeSpecsForGoals,
  type GradeSpec,
} from "./grade-specs.js";
import {
  ATTRS_MAX_CHARS,
  emitTraceEvent,
} from "../../observability/task-trace.js";

const COMPLEX = "Compare the payment providers end to end and recommend one";
const SIMPLE = "fix the typo in the README";
const SPECS: GradeSpec[] = [
  { id: "GR-g-1.1", criterion: "every provider is listed", origin: "prose" },
  { id: "GR-g-1.2", criterion: "a recommendation is stated", origin: "prose" },
];
const SHADOW = { TASK_GATES_GRADER: "shadow" };
const ENFORCE = { TASK_GATES_GRADER: "enforce", TASK_GATES_MODE: "enforce" };

function traces(taskId: string) {
  return (
    getDatabase()
      .prepare(
        `SELECT name, attrs FROM task_trace_events WHERE task_id = ? ORDER BY id`,
      )
      .all(taskId) as Array<{ name: string; attrs: string | null }>
  ).map((r) => ({ name: r.name, attrs: r.attrs ? JSON.parse(r.attrs) : {} }));
}

beforeEach(() => {
  initDatabase(":memory:");
  _resetShadowGradeSpecs();
  _resetStopHookState();
});
afterEach(() => closeDatabase());

describe("mode + budget", () => {
  it("graderMode: off by default and for unknown values; shadow / enforce case-insensitive", () => {
    expect(graderMode({})).toBe("off");
    expect(graderMode({ TASK_GATES_GRADER: "on" })).toBe("off");
    expect(graderMode({ TASK_GATES_GRADER: "true" })).toBe("off");
    expect(graderMode({ TASK_GATES_GRADER: " Shadow " })).toBe("shadow");
    expect(graderMode({ TASK_GATES_GRADER: "ENFORCE" })).toBe("enforce");
  });

  it("effectiveGraderMode: enforce without a ledger consumer (TASK_GATES_MODE off) is off; shadow is independent", () => {
    expect(effectiveGraderMode({ TASK_GATES_GRADER: "enforce" })).toBe("off");
    expect(
      effectiveGraderMode({
        TASK_GATES_GRADER: "enforce",
        TASK_GATES_MODE: "shadow",
      }),
    ).toBe("enforce");
    expect(effectiveGraderMode(ENFORCE)).toBe("enforce");
    expect(effectiveGraderMode(SHADOW)).toBe("shadow");
  });

  it("graderBudgetMs: default 90 s, clamped to [5 s, 10 min], junk ⇒ default", () => {
    expect(DEFAULT_GRADER_BUDGET_MS).toBe(90_000);
    expect(graderBudgetMs({})).toBe(90_000);
    expect(graderBudgetMs({ TASK_GATES_GRADER_BUDGET_MS: "" })).toBe(90_000);
    expect(graderBudgetMs({ TASK_GATES_GRADER_BUDGET_MS: "abc" })).toBe(90_000);
    expect(graderBudgetMs({ TASK_GATES_GRADER_BUDGET_MS: "-5" })).toBe(90_000);
    expect(graderBudgetMs({ TASK_GATES_GRADER_BUDGET_MS: "100" })).toBe(5_000);
    expect(graderBudgetMs({ TASK_GATES_GRADER_BUDGET_MS: "30000" })).toBe(
      30_000,
    );
    expect(graderBudgetMs({ TASK_GATES_GRADER_BUDGET_MS: "9999999" })).toBe(
      600_000,
    );
  });
});

describe("spec construction", () => {
  it("gradeGateId: GR-<sanitized goal ≤20>.<n>, valid as a gate id", () => {
    expect(GRADE_ID_PREFIX).toBe("GR-");
    expect(gradeGateId("g-1", 2)).toBe("GR-g-1.2");
    expect(gradeGateId("goal with spaces/and:colons-and-more-text", 1)).toBe(
      "GR-goal-with-spaces-and.1",
    );
    // Swarm namespace (R1 W7): never the planner's id for the same goal.
    expect(gradeGateId("g-1", 1, "swarm")).toBe("GR-sw.g-1.1");
    expect(
      proseGradeSpecsFromGoal("g-1", ["a"], undefined, "swarm")[0]!.id,
    ).toBe("GR-sw.g-1.1");
  });

  it("proseGradeSpecsFromGoal: criteria minus runnable plan gates, trimmed, de-duplicated, numbered", () => {
    const specs = proseGradeSpecsFromGoal(
      "g-1",
      ["prose a", " runnable b ", "", "prose a", "prose c"],
      {
        gates: [
          { criterion: "runnable b", check: "npm test" },
          null,
          { criterion: 3 },
        ],
      },
    );
    expect(specs).toEqual([
      { id: "GR-g-1.1", criterion: "prose a", origin: "prose" },
      { id: "GR-g-1.2", criterion: "prose c", origin: "prose" },
    ]);
    expect(proseGradeSpecsFromGoal("g-2", undefined, undefined)).toEqual([]);
    expect(
      proseGradeSpecsFromGoal("g-3", ["x".repeat(900)], {})[0]!.criterion,
    ).toHaveLength(500);
  });
});

describe("registerGradeSpecs — per mode", () => {
  it("off: nothing stored, nothing declared, no trace", () => {
    expect(registerGradeSpecs("t1", SPECS, COMPLEX, { env: {} })).toEqual({
      mode: "off",
      registered: 0,
    });
    expect(_peekShadowGradeSpecs("t1")).toEqual([]);
    expect(listGates("t1")).toEqual([]);
    expect(traces("t1")).toEqual([]);
    // enforce with the ledger off resolves to off too.
    expect(
      registerGradeSpecs("t1", SPECS, COMPLEX, {
        env: { TASK_GATES_GRADER: "enforce" },
      }).mode,
    ).toBe("off");
    expect(listGates("t1")).toEqual([]);
  });

  it("shadow: specs wait in the in-memory registry (no ledger rows); merge without duplicates; take frees", () => {
    expect(registerGradeSpecs("t1", SPECS, COMPLEX, { env: SHADOW })).toEqual({
      mode: "shadow",
      registered: 2,
    });
    expect(
      registerGradeSpecs(
        "t1",
        [SPECS[0]!, { id: "GR-g-2.1", criterion: "c", origin: "prose" }],
        COMPLEX,
        { env: SHADOW },
      ).registered,
    ).toBe(1);
    expect(listGates("t1")).toEqual([]);
    expect(_peekShadowGradeSpecs("t1").map((s) => s.id)).toEqual([
      "GR-g-1.1",
      "GR-g-1.2",
      "GR-g-2.1",
    ]);
    expect(takeShadowGradeSpecs("t1")).toHaveLength(3);
    expect(takeShadowGradeSpecs("t1")).toEqual([]);
  });

  it("shadow registry is bounded (oldest task evicted)", () => {
    for (let i = 0; i < 501; i++) {
      registerGradeSpecs(`t${i}`, SPECS, COMPLEX, { env: SHADOW });
    }
    expect(_peekShadowGradeSpecs("t0")).toEqual([]);
    expect(_peekShadowGradeSpecs("t500")).toHaveLength(2);
  });

  it("enforce: specs become harness manual GR rows with a grade:<origin> check", () => {
    expect(registerGradeSpecs("t1", SPECS, COMPLEX, { env: ENFORCE })).toEqual({
      mode: "enforce",
      registered: 2,
    });
    const rows = listGates("t1");
    expect(
      rows.map((r) => [
        r.gate_id,
        r.source,
        r.check_kind,
        r.check_cmd,
        r.state,
      ]),
    ).toEqual([
      ["GR-g-1.1", "harness", "manual", "grade:prose", "pending"],
      ["GR-g-1.2", "harness", "manual", "grade:prose", "pending"],
    ]);
    expect(rows.every((r) => isGradeCheck(r.check_kind, r.check_cmd))).toBe(
      true,
    );
    expect(_peekShadowGradeSpecs("t1")).toEqual([]);
  });

  it("SIMPLE-class task: nothing stored, one gates.graded trace with reason skipped_simple", () => {
    expect(registerGradeSpecs("t1", SPECS, SIMPLE, { env: ENFORCE })).toEqual({
      mode: "enforce",
      registered: 0,
      skipped: "simple",
    });
    expect(listGates("t1")).toEqual([]);
    const t = traces("t1");
    expect(t).toHaveLength(1);
    expect(t[0]!.name).toBe("gates.graded");
    expect(t[0]!.attrs).toMatchObject({
      mode: "enforce",
      iteration: 1,
      model: null,
      reason: "skipped_simple",
      status_before: "planned",
      criteria_total: 2,
      latency_ms: 0,
      usage: null,
    });
    expect(t[0]!.attrs.criteria[0]).toEqual({
      id: "GR-g-1.1",
      verdict: "pending",
      evidence: "not graded — simple-class task",
    });
  });

  it("empty spec list is a no-op in every mode", () => {
    expect(
      registerGradeSpecs("t1", [], COMPLEX, { env: ENFORCE }).registered,
    ).toBe(0);
    expect(traces("t1")).toEqual([]);
  });

  it("never throws: a declare failure (invalid id) is swallowed, reported as 0 and traced as an error (R1 I6)", () => {
    const bad = [
      { id: "GR-has space", criterion: "x", origin: "prose" as const },
    ];
    expect(registerGradeSpecs("t1", bad, COMPLEX, { env: ENFORCE })).toEqual({
      mode: "enforce",
      registered: 0,
    });
    const t = traces("t1");
    expect(t).toHaveLength(1);
    expect(t[0]!.name).toBe("gates.grade_specs");
    expect(t[0]!.attrs).toMatchObject({
      mode: "enforce",
      action: "error",
      total: 1,
      ids: ["GR-has space"],
    });
    expect(t[0]!.attrs.error).toEqual(expect.any(String));
  });

  it("registration is traced (gates.grade_specs): shadow + enforce; an id already on the ledger is reported as dropped, never silent (R1 I6)", () => {
    registerGradeSpecs("t1", SPECS, COMPLEX, { env: SHADOW });
    expect(traces("t1")).toEqual([
      {
        name: "gates.grade_specs",
        attrs: {
          mode: "shadow",
          action: "registered",
          total: 2,
          ids: ["GR-g-1.1", "GR-g-1.2"],
          // R2 W3: shadow's only copy of the criterion text, for labelling.
          criteria: [
            { id: "GR-g-1.1", criterion: "every provider is listed" },
            { id: "GR-g-1.2", criterion: "a recommendation is stated" },
          ],
          registered: 2,
        },
      },
    ]);
    registerGradeSpecs("t2", SPECS, COMPLEX, { env: ENFORCE });
    registerGradeSpecs("t2", SPECS.slice(0, 1), COMPLEX, { env: ENFORCE });
    const t = traces("t2");
    expect(t.map((e) => e.attrs)).toEqual([
      {
        mode: "enforce",
        action: "registered",
        total: 2,
        ids: ["GR-g-1.1", "GR-g-1.2"],
        criteria: [
          { id: "GR-g-1.1", criterion: "every provider is listed" },
          { id: "GR-g-1.2", criterion: "a recommendation is stated" },
        ],
        registered: 2,
      },
      {
        mode: "enforce",
        action: "registered",
        total: 1,
        ids: ["GR-g-1.1"],
        criteria: [{ id: "GR-g-1.1", criterion: "every provider is listed" }],
        registered: 0,
        dropped: 1,
      },
    ]);
  });

  it("the registration trace shrinks criterion text, then the criteria list, to stay under the attrs cap — never {truncated} (R2 W3)", () => {
    const many: GradeSpec[] = Array.from({ length: 30 }, (_, i) => ({
      id: `GR-goal-number-${String(i).padStart(3, "0")}.${i + 1}`,
      criterion: `criterion ${i} ${"long prose ".repeat(50)}`,
      origin: "prose",
    }));
    registerGradeSpecs("t1", many, COMPLEX, { env: SHADOW });
    const a = traces("t1")[0]!.attrs;
    expect(a.truncated).toBeUndefined();
    expect(a.action).toBe("registered");
    expect(a.total).toBe(30);
    expect(a.ids).toHaveLength(30);
    expect(a.criteria.length).toBeGreaterThan(0);
    expect(a.criteria.length).toBeLessThanOrEqual(30);
    expect(a.criteria[0].id).toBe(many[0]!.id);
    expect(a.criteria[0].criterion).toMatch(/^criterion 0 long prose/);
    expect(a.criteria[0].criterion.length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(a).length).toBeLessThanOrEqual(ATTRS_MAX_CHARS);
    // Small sets keep the full text (up to 200 chars).
    registerGradeSpecs(
      "t2",
      [{ id: "GR-g-1.1", criterion: "x".repeat(150), origin: "prose" }],
      COMPLEX,
      { env: SHADOW },
    );
    expect(traces("t2")[0]!.attrs.criteria[0].criterion).toHaveLength(150);
  });

  it("swarm and planner specs for the same goal id coexist on one task (R1 W7)", () => {
    // A swarm child routed to heavy: the swarm registers its goal's prose,
    // then the child's own planner registers its goals — both start at g-1.
    registerGradeSpecs(
      "child",
      proseGradeSpecsFromGoal("g-1", ["swarm-level criterion"], undefined, "swarm"),
      COMPLEX,
      { env: ENFORCE },
    );
    const r = registerGradeSpecs(
      "child",
      proseGradeSpecsFromGoal("g-1", ["planner-level criterion"], undefined),
      COMPLEX,
      { env: ENFORCE },
    );
    expect(r.registered).toBe(1);
    expect(listGates("child").map((g) => [g.gate_id, g.criterion])).toEqual([
      ["GR-sw.g-1.1", "swarm-level criterion"],
      ["GR-g-1.1", "planner-level criterion"],
    ]);
    expect(
      traces("child").some((e) => e.attrs.dropped !== undefined),
    ).toBe(false);
  });
});

describe("plan lifecycle — withdraw / sync (R1 W4 + W5)", () => {
  const goals = (
    g1: string[],
    g2: string[] | null,
    g3?: string[],
  ): Array<{ id: string; completionCriteria?: string[] }> => [
    { id: "g-1", completionCriteria: g1 },
    ...(g2 ? [{ id: "g-2", completionCriteria: g2 }] : []),
    ...(g3 ? [{ id: "g-3", completionCriteria: g3 }] : []),
  ];

  it("off: sync and withdraw are no-ops (nothing stored, declared or traced)", () => {
    const plan = newGradeSpecPlan();
    expect(
      syncGradeSpecs("t1", plan, goals(["a"], ["b"]), COMPLEX, { env: {} }),
    ).toEqual({ registered: 0, withdrawn: 0 });
    expect(
      withdrawGradeSpecsForGoals("t1", plan, ["g-1"], "x", { env: {} }),
    ).toBe(0);
    expect(listGates("t1")).toEqual([]);
    expect(traces("t1")).toEqual([]);
  });

  it("enforce: a replan keeps unchanged criteria, ABANDONS removed / rewritten ones with the reason, and declares new ones under fresh (never reused) ids", () => {
    const plan = newGradeSpecPlan();
    expect(
      syncGradeSpecs("t1", plan, goals(["keep", "drop"], ["old goal"]), COMPLEX, {
        env: ENFORCE,
      }),
    ).toEqual({ registered: 3, withdrawn: 0 });
    expect(
      syncGradeSpecs("t1", plan, goals(["keep", "rewritten"], null, ["new goal"]), COMPLEX, {
        env: ENFORCE,
        reason: "goal removed or rewritten by replan 1",
      }),
    ).toEqual({ registered: 2, withdrawn: 2 });
    const rows = listGates("t1").map((r) => [
      r.gate_id,
      r.criterion,
      r.state,
      r.abandon_reason,
    ]);
    expect(rows).toEqual([
      ["GR-g-1.1", "keep", "pending", null],
      ["GR-g-1.2", "drop", "abandoned", "goal removed or rewritten by replan 1"],
      ["GR-g-2.1", "old goal", "abandoned", "goal removed or rewritten by replan 1"],
      ["GR-g-1.3", "rewritten", "pending", null],
      ["GR-g-3.1", "new goal", "pending", null],
    ]);
    // Only the pending prose rows are graded at completion.
    expect(
      collectGradeSpecs("t1", listGates("t1"), "", "enforce").map((s) => s.id),
    ).toEqual(["GR-g-1.1", "GR-g-1.3", "GR-g-3.1"]);
    const w = traces("t1").find((e) => e.attrs.action === "withdrawn")!;
    expect(w.attrs).toMatchObject({
      mode: "enforce",
      total: 2,
      ids: ["GR-g-1.2", "GR-g-2.1"],
      withdrawn: 2,
      reason: "goal removed or rewritten by replan 1",
    });
  });

  it("shadow: the same diff lands in the registry (removed specs dropped, new ones added)", () => {
    const plan = newGradeSpecPlan();
    syncGradeSpecs("t1", plan, goals(["keep", "drop"], ["old goal"]), COMPLEX, {
      env: SHADOW,
    });
    syncGradeSpecs("t1", plan, goals(["keep", "rewritten"], null), COMPLEX, {
      env: SHADOW,
    });
    expect(_peekShadowGradeSpecs("t1")).toEqual([
      { id: "GR-g-1.1", criterion: "keep", origin: "prose" },
      { id: "GR-g-1.3", criterion: "rewritten", origin: "prose" },
    ]);
    expect(listGates("t1")).toEqual([]);
  });

  it("early exit: the unfinished goals' pending GR rows are ABANDONED with the exit reason; settled rows and finished goals untouched", () => {
    const plan = newGradeSpecPlan();
    syncGradeSpecs("t1", plan, goals(["done a"], ["never ran", "never ran 2"]), COMPLEX, {
      env: ENFORCE,
    });
    recordGradeVerdict("t1", { id: "GR-g-2.2", verdict: "failed", evidence: "x" });
    expect(
      withdrawGradeSpecsForGoals(
        "t1",
        plan,
        ["g-2"],
        "goal unfinished — orchestrator budget_exhausted",
        { env: ENFORCE },
      ),
    ).toBe(1);
    const byId = new Map(listGates("t1").map((r) => [r.gate_id, r]));
    expect(byId.get("GR-g-1.1")!.state).toBe("pending");
    expect(byId.get("GR-g-2.1")).toMatchObject({
      state: "abandoned",
      abandon_reason: "goal unfinished — orchestrator budget_exhausted",
    });
    expect(byId.get("GR-g-2.2")!.state).toBe("failed");
    expect(plan.byGoal.has("g-2")).toBe(false);
  });

  it("resume (enforce, fresh plan): pending rows are adopted (no duplicate), an early-exit-abandoned id is never reused, swarm rows are left alone", () => {
    const first = newGradeSpecPlan();
    syncGradeSpecs("t1", first, goals(["done a"], ["never ran"]), COMPLEX, {
      env: ENFORCE,
    });
    registerGradeSpecs(
      "t1",
      proseGradeSpecsFromGoal("g-1", ["swarm level"], undefined, "swarm"),
      COMPLEX,
      { env: ENFORCE },
    );
    withdrawGradeSpecsForGoals("t1", first, ["g-2"], "goal unfinished — orchestrator timeout", {
      env: ENFORCE,
    });
    // Restart → snapshot resume: a new plan object over the same graph.
    const resumed = newGradeSpecPlan();
    expect(
      syncGradeSpecs("t1", resumed, goals(["done a"], ["never ran"]), COMPLEX, {
        env: ENFORCE,
      }),
    ).toEqual({ registered: 1, withdrawn: 0 });
    expect(
      listGates("t1").map((r) => [r.gate_id, r.criterion, r.state]),
    ).toEqual([
      ["GR-g-1.1", "done a", "pending"],
      ["GR-g-2.1", "never ran", "abandoned"],
      ["GR-sw.g-1.1", "swarm level", "pending"],
      ["GR-g-2.2", "never ran", "pending"],
    ]);
    expect(
      traces("t1").some((e) => e.attrs.dropped !== undefined),
    ).toBe(false);
  });

  it("withdrawGradeSpecs never touches a non-grade row with the same id shape", () => {
    declareGates("t1", [{ id: "G1", criterion: "manual" }], "submission");
    expect(
      withdrawGradeSpecs(
        "t1",
        [{ id: "G1", criterion: "manual", origin: "manual" }],
        "x",
        { env: ENFORCE },
      ),
    ).toBe(0);
    expect(listGates("t1")[0]!.state).toBe("pending");
  });
});

describe("the model has no writer for a grade row", () => {
  it("GR- ids are reserved for source=harness", () => {
    for (const src of ["submission", "plan", "ritual"] as const) {
      expect(() =>
        declareGates("t1", [{ id: "GR-g-1.1", criterion: "x" }], src),
      ).toThrow(/reserved for harness grade gates/);
    }
    expect(
      declareGates(
        "t1",
        [{ id: "GR-g-1.1", criterion: "x", kind: "manual" }],
        "harness",
      ),
    ).toBe(1);
  });

  it("a grade: check is kept only on harness manual rows", () => {
    declareGates(
      "t1",
      [{ criterion: "sub", kind: "manual", check: `${GRADE_PREFIX}prose` }],
      "submission",
    );
    declareGates(
      "t1",
      [
        {
          id: "GR-x.1",
          criterion: "h",
          kind: "manual",
          check: `${GRADE_PREFIX}prose`,
        },
      ],
      "harness",
    );
    const rows = listGates("t1");
    expect(rows.find((r) => r.gate_id === "G1")!.check_cmd).toBeNull();
    expect(rows.find((r) => r.gate_id === "GR-x.1")!.check_cmd).toBe(
      "grade:prose",
    );
  });

  it("an ABANDON line naming a GR row is ignored by evaluateLedger; a submission manual row still honors it", async () => {
    registerGradeSpecs("t1", SPECS.slice(0, 1), COMPLEX, { env: ENFORCE });
    declareGates("t1", [{ criterion: "manual one" }], "submission");
    const manualId = listGates("t1").find(
      (r) => r.source === "submission",
    )!.gate_id;
    const res = await evaluateLedger({
      taskId: "t1",
      outputText: `Done.\nABANDON: GR-g-1.1 too hard\nABANDON: ${manualId} not possible`,
    });
    const rows = listGates("t1");
    expect(rows.find((r) => r.gate_id === "GR-g-1.1")!.state).toBe("pending");
    expect(rows.find((r) => r.gate_id === manualId)!.state).toBe("abandoned");
    expect(res.abandonedNow).toBe(1);
  });

  it("Stop hook: a ledger with only GR rows is not walled (no evaluate); a failed GR row never blocks", async () => {
    const env = { TASK_GATES_STOP_HOOK: "true", TASK_GATES_MODE: "shadow" };
    const stop: StopHookInput = {
      hook_event_name: "Stop",
      session_id: "s",
      transcript_path: "/dev/null",
      cwd: "/",
      stop_hook_active: false,
      last_assistant_message: "Listo.",
    };
    registerGradeSpecs("t1", SPECS.slice(0, 1), COMPLEX, { env: ENFORCE });
    let evaluated = 0;
    const hook = makeGatesStopHook("t1", {
      env,
      evaluate: async () => {
        evaluated++;
        throw new Error("should not run");
      },
    })!;
    expect(
      await hook(stop, undefined, { signal: new AbortController().signal }),
    ).toEqual({});
    expect(evaluated).toBe(0);

    // Mixed ledger: a runnable gate that passes + a stale FAILED grade row.
    declareGates("t2", [{ criterion: "ok", check: "true" }], "submission");
    registerGradeSpecs("t2", SPECS.slice(0, 1), COMPLEX, { env: ENFORCE });
    recordGradeVerdict("t2", {
      id: "GR-g-1.1",
      verdict: "failed",
      evidence: "missing",
    });
    const hook2 = makeGatesStopHook("t2", {
      env,
      evaluate: async () => {
        const rows = listGates("t2");
        const failedRows = rows.filter((r) => r.state === "failed");
        return {
          verdict: "failed",
          total: rows.length,
          met: 1,
          failed: failedRows.length,
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
    const out = await hook2(stop, undefined, {
      signal: new AbortController().signal,
    });
    expect(out).toEqual({});
    expect(traces("t2").map((t) => t.name)).toContain("gates.hook_allowed");
  });
});

describe("collectGradeSpecs", () => {
  it("enforce: pending GR rows (prose) + pending manual rows; skips read-backs, shell rows, settled rows and ABANDON-targeted manual rows", () => {
    registerGradeSpecs("t1", SPECS, COMPLEX, { env: ENFORCE });
    declareGates(
      "t1",
      [
        { id: "G1", criterion: "operator confirmed" },
        { id: "G2", criterion: "surrendered one" },
        { id: "G3", criterion: "shell", check: "true" },
        { id: "G4", criterion: "already met" },
      ],
      "submission",
    );
    declareGates(
      "t1",
      [
        {
          id: "RB-w1",
          criterion: "write landed",
          kind: "manual",
          check: "readback:{}",
        },
      ],
      "harness",
    );
    recordGradeVerdict("t1", {
      id: "GR-g-1.2",
      verdict: "met",
      evidence: "stated",
    });
    recordGateResult("t1", "G4", { state: "met", evidence: "x" });
    const specs = collectGradeSpecs(
      "t1",
      listGates("t1"),
      "Report\nABANDON: G2 cannot",
      "enforce",
    );
    expect(specs).toEqual([
      {
        id: "GR-g-1.1",
        criterion: "every provider is listed",
        origin: "prose",
      },
      { id: "G1", criterion: "operator confirmed", origin: "manual" },
    ]);
  });

  it("shadow: prose specs come from the registry (and are freed); manual rows read, not written", () => {
    registerGradeSpecs("t1", SPECS, COMPLEX, { env: SHADOW });
    declareGates("t1", [{ criterion: "operator confirmed" }], "submission");
    const specs = collectGradeSpecs("t1", listGates("t1"), "Report", "shadow");
    expect(specs.map((s) => [s.id, s.origin])).toEqual([
      ["GR-g-1.1", "prose"],
      ["GR-g-1.2", "prose"],
      ["G1", "manual"],
    ]);
    expect(_peekShadowGradeSpecs("t1")).toEqual([]);
    expect(listGates("t1")[0]!.state).toBe("pending");
  });
});

describe("harness writers", () => {
  beforeEach(() => {
    registerGradeSpecs("t1", SPECS, COMPLEX, { env: ENFORCE });
    declareGates(
      "t1",
      [{ id: "G1", criterion: "shell", check: "true" }],
      "submission",
    );
    declareGates(
      "t1",
      [
        {
          id: "RB-w1",
          criterion: "write landed",
          kind: "manual",
          check: "readback:{}",
        },
      ],
      "harness",
    );
  });

  it("recordGradeVerdict: met needs evidence; failed / pending recorded; shell + read-back rows untouchable; settled rows not re-graded", () => {
    expect(
      recordGradeVerdict("t1", {
        id: "GR-g-1.1",
        verdict: "met",
        evidence: "  ",
      }),
    ).toBe(false);
    expect(listGates("t1").find((r) => r.gate_id === "GR-g-1.1")!.state).toBe(
      "pending",
    );

    expect(
      recordGradeVerdict("t1", {
        id: "GR-g-1.1",
        verdict: "failed",
        evidence: "no recommendation",
      }),
    ).toBe(true);
    expect(
      recordGradeVerdict("t1", {
        id: "GR-g-1.1",
        verdict: "met",
        evidence: "retry",
      }),
    ).toBe(false);
    expect(
      recordGradeVerdict("t1", {
        id: "GR-g-1.2",
        verdict: "pending",
        evidence: "cannot tell",
      }),
    ).toBe(true);
    expect(
      recordGradeVerdict("t1", { id: "G1", verdict: "met", evidence: "x" }),
    ).toBe(false);
    expect(
      recordGradeVerdict("t1", { id: "RB-w1", verdict: "met", evidence: "x" }),
    ).toBe(false);

    const rows = listGates("t1");
    expect(rows.find((r) => r.gate_id === "GR-g-1.1")).toMatchObject({
      state: "failed",
      evidence: "no recommendation",
    });
    expect(rows.find((r) => r.gate_id === "GR-g-1.2")).toMatchObject({
      state: "pending",
      evidence: "cannot tell",
    });
    expect(rows.find((r) => r.gate_id === "G1")!.state).toBe("pending");
    expect(rows.find((r) => r.gate_id === "RB-w1")!.state).toBe("pending");
  });

  it("abandonPendingGradeRows: only pending harness grade rows, with the reason", () => {
    recordGradeVerdict("t1", {
      id: "GR-g-1.2",
      verdict: "met",
      evidence: "ok",
    });
    expect(abandonPendingGradeRows("t1", "interrupted — failed: boom")).toBe(1);
    const rows = listGates("t1");
    expect(rows.find((r) => r.gate_id === "GR-g-1.1")).toMatchObject({
      state: "abandoned",
      abandon_reason: "interrupted — failed: boom",
    });
    expect(rows.find((r) => r.gate_id === "GR-g-1.2")!.state).toBe("met");
    expect(rows.find((r) => r.gate_id === "RB-w1")!.state).toBe("pending");
    expect(rows.find((r) => r.gate_id === "G1")!.state).toBe("pending");
  });
});

describe("rendering", () => {
  it("renderGatesBlock tells the runner a GR row is graded by an independent reviewer", () => {
    registerGradeSpecs("t1", SPECS.slice(0, 1), COMPLEX, { env: ENFORCE });
    declareGates("t1", [{ id: "G1", criterion: "manual" }], "submission");
    const block = renderGatesBlock(listGates("t1"));
    expect(block).toContain(
      "- GR-g-1.1: every provider is listed [graded after you finish by an independent reviewer — state the evidence in your report]",
    );
    expect(block).toContain(
      "- G1: manual [manual — state the evidence in your report]",
    );
  });

  it("the ABANDON invitation names only gates it can act on: none with GR rows only; a GR caveat when mixed (R1 I3)", () => {
    registerGradeSpecs("t1", SPECS, COMPLEX, { env: ENFORCE });
    const onlyGraded = renderGatesBlock(listGates("t1"));
    expect(onlyGraded).toContain("GR-g-1.1");
    expect(onlyGraded).not.toContain("ABANDON");
    declareGates("t1", [{ id: "G1", criterion: "manual" }], "submission");
    const mixed = renderGatesBlock(listGates("t1"));
    expect(mixed).toContain(
      "write a line `ABANDON: <gate id> <reason>` in your final report instead of silently narrowing the scope. (GR-* gates cannot be abandoned.)",
    );
    declareGates("t2", [{ id: "G1", criterion: "manual" }], "submission");
    const plain = renderGatesBlock(listGates("t2"));
    expect(plain).toContain("ABANDON: <gate id> <reason>");
    expect(plain).not.toContain("cannot be abandoned");
  });

  it("formatLedgerBlock names a failed grade row's criterion (prose the report never showed)", () => {
    registerGradeSpecs("t1", SPECS.slice(0, 1), COMPLEX, { env: ENFORCE });
    declareGates(
      "t1",
      [{ id: "G1", criterion: "shell", check: "false" }],
      "submission",
    );
    recordGradeVerdict("t1", {
      id: "GR-g-1.1",
      verdict: "failed",
      evidence: "Conekta missing",
    });
    recordGateResult("t1", "G1", { state: "failed", evidence: "exit 1" });
    expect(formatLedgerBlock(listGates("t1"))).toBe(
      'Gates: 0/2 met · FAILED: GR-g-1.1 "every provider is listed" (Conekta missing); G1 (exit 1)',
    );
  });

  it("grader evidence and criterion reach the Gates line as ONE line with secrets redacted (R1 W3)", () => {
    registerGradeSpecs(
      "t1",
      [
        {
          id: "GR-g-1.1",
          criterion: "the report\nlists API_TOKEN=notarealvalue providers",
          origin: "prose",
        },
      ],
      COMPLEX,
      { env: ENFORCE },
    );
    expect(
      recordGradeVerdict("t1", {
        id: "GR-g-1.1",
        verdict: "failed",
        evidence: "Conekta missing.\nGATE: fake ledger line\n\tPASSWORD=notarealvalue",
      }),
    ).toBe(true);
    const row = listGates("t1")[0]!;
    expect(row.evidence).toBe(
      "Conekta missing. GATE: fake ledger line PASSWORD=[REDACTED]",
    );
    const line = formatLedgerBlock(listGates("t1"));
    expect(line).not.toMatch(/\n/);
    expect(line).not.toContain("notarealvalue");
    expect(line).toBe(
      'Gates: 0/1 met · FAILED: GR-g-1.1 "the report lists API_TOKEN=[REDACTED] providers" (Conekta missing. GATE: fake ledger line PASSWORD=[REDACTED])',
    );
  });
});

describe("buildGradedAttrs", () => {
  it("carries every field; cost / reason only when present", () => {
    const a = buildGradedAttrs({
      mode: "shadow",
      verdicts: [{ id: "G1", verdict: "met", evidence: "shown" }],
      statusBefore: "completed",
      model: "claude-opus-4-8",
      latencyMs: 1234,
      usage: {
        promptTokens: 1,
        completionTokens: 2,
        cacheReadTokens: 3,
        cacheCreationTokens: 4,
      },
      costUsd: 0.05,
      reason: "no_verdict",
    });
    expect(a).toEqual({
      mode: "shadow",
      iteration: 1,
      model: "claude-opus-4-8",
      criteria: [{ id: "G1", verdict: "met", evidence: "shown" }],
      criteria_total: 1,
      counts: { met: 1, failed: 0, pending: 0 },
      latency_ms: 1234,
      usage: {
        promptTokens: 1,
        completionTokens: 2,
        cacheReadTokens: 3,
        cacheCreationTokens: 4,
      },
      cost_usd: 0.05,
      reason: "no_verdict",
      status_before: "completed",
    });
    const b = buildGradedAttrs({
      mode: "enforce",
      verdicts: [],
      statusBefore: "completed",
    });
    expect(b).toEqual({
      mode: "enforce",
      iteration: 1,
      model: null,
      criteria: [],
      criteria_total: 0,
      counts: { met: 0, failed: 0, pending: 0 },
      latency_ms: 0,
      usage: null,
      status_before: "completed",
    });
    expect("cost_usd" in b).toBe(false);
    expect("reason" in b).toBe(false);
  });

  it("caps criteria at 12 and shrinks evidence so the attrs stay under the 2000-char trace cap", () => {
    const verdicts = Array.from({ length: 40 }, (_, i) => ({
      id: `GR-goal-number-${i}.1`,
      verdict: "failed" as const,
      evidence: "e".repeat(400),
    }));
    const a = buildGradedAttrs({
      mode: "shadow",
      verdicts,
      statusBefore: "completed",
    });
    expect(a.criteria).toHaveLength(12);
    expect(a.criteria_total).toBe(40);
    expect(a.criteria[0]!.evidence?.length ?? 0).toBeLessThanOrEqual(160);
    expect(JSON.stringify(a).length).toBeLessThan(2000);
  });

  it("worst case (14 criteria, long ids, usage, model, cost, 300-char escaped reason): stays under the cap through emitTraceEvent — evidence dropped first, then criteria; counts survive (R1 W2)", () => {
    const verdicts = Array.from({ length: 14 }, (_, i) => ({
      id: `GR-sw.goal-number-${String(i).padStart(4, "0")}xx.${i + 10}`,
      verdict: (["met", "failed", "pending"] as const)[i % 3]!,
      evidence: `"quoted" \\ evidence ${"é".repeat(150)}`,
    }));
    const args = {
      mode: "shadow" as const,
      verdicts,
      statusBefore: "completed_with_concerns",
      model: "claude-opus-4-8-20260901",
      latencyMs: 89_999,
      usage: {
        promptTokens: 123_456,
        completionTokens: 7_890,
        cacheReadTokens: 45_678,
        cacheCreationTokens: 9_876,
      },
      costUsd: 0.123456789,
      reason: `interrupted — failed: ${'"'.repeat(400)}` as const,
    };
    const a = buildGradedAttrs(args);
    expect(TRACE_ATTRS_MAX_CHARS).toBe(ATTRS_MAX_CHARS);
    // Pre-fix this serialized well past 2000 and the trace became {truncated}.
    expect(JSON.stringify(a).length).toBeLessThanOrEqual(2000);
    expect(a.counts).toEqual({ met: 5, failed: 5, pending: 4 });
    expect(a.criteria_total).toBe(14);
    expect(a.model).toBe(args.model);
    expect(a.usage).toEqual(args.usage);
    expect(a.cost_usd).toBe(args.costUsd);
    expect(a.reason).toHaveLength(300);
    expect(a.criteria.every((c) => c.evidence === undefined)).toBe(true);

    emitTraceEvent({ taskId: "t-w2", name: "gates.graded", attrs: { ...a } });
    const stored = traces("t-w2")[0]!.attrs;
    expect(stored.truncated).toBeUndefined();
    expect(stored.counts).toEqual({ met: 5, failed: 5, pending: 4 });
    expect(stored.mode).toBe("shadow");
  });

  it("a modest set keeps per-criterion evidence (shrinks only as needed)", () => {
    const a = buildGradedAttrs({
      mode: "enforce",
      verdicts: Array.from({ length: 3 }, (_, i) => ({
        id: `GR-g-${i}.1`,
        verdict: "met" as const,
        evidence: "x".repeat(200),
      })),
      statusBefore: "completed",
    });
    expect(a.criteria.map((c) => c.evidence?.length)).toEqual([160, 160, 160]);
  });
});
