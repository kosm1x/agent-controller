/**
 * V8.4 consumer: what the ledger verdict DOES at completion, per mode.
 * off = passthrough · shadow = record only · enforce = demote + ledger block.
 * Plus: landing gate declared for sandboxed coding tasks; numbers audit
 * always; parent re-verification; never throws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import type { RunnerOutput } from "../../runners/types.js";
import {
  LANDING_GATE_ID,
  applyCompletionLedger,
  needsLandingGate,
  reverifyChildLedger,
  stripForwardedSiblingFindings,
} from "./consumer.js";
import { declareGates, listGates, recordGateResult } from "./gates.js";
import { _resetToolEvidence, recordToolEvidence } from "./numbers.js";
import { _resetCitationCache } from "./citations.js";
import { _setLandingExecForTests } from "./landing.js";

const ENV_KEYS = [
  "TASK_GATES_MODE",
  "TASK_GATES_NUMBERS_ANNOTATE",
  "CITATION_CHECK",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  initDatabase(":memory:");
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  _resetToolEvidence();
  // Deterministic remote for the landing probe: one head, no PRs, no network.
  _setLandingExecForTests(async (cmd, args) =>
    cmd === "git" && args[0] === "ls-remote"
      ? {
          stdout: "0abc\trefs/heads/main\n1abc\trefs/heads/feat/landed\n",
          exitCode: 0,
        }
      : { stdout: "", exitCode: 1 },
  );
});
afterEach(() => {
  _setLandingExecForTests(null);
  closeDatabase();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function traceNames(
  taskId: string,
): Array<{ name: string; attrs: Record<string, unknown> }> {
  return (
    getDatabase()
      .prepare(
        `SELECT name, attrs FROM task_trace_events WHERE task_id = ? ORDER BY id`,
      )
      .all(taskId) as Array<{ name: string; attrs: string | null }>
  ).map((r) => ({ name: r.name, attrs: r.attrs ? JSON.parse(r.attrs) : {} }));
}

const okResult = (output: RunnerOutput["output"]): RunnerOutput => ({
  success: true,
  status: "DONE",
  output,
  durationMs: 1,
});

function base(over: Partial<Parameters<typeof applyCompletionLedger>[0]> = {}) {
  return {
    taskId: "t1",
    runId: "r1",
    agentType: "fast" as const,
    tags: [] as string[],
    taskDescription: "do the thing",
    result: okResult({ text: "Listo. Hice todo." }),
    taskStatus: "completed",
    ...over,
  };
}

describe("applyCompletionLedger — modes", () => {
  it("mode off: passthrough even with a failing gate; nothing runs, no gates trace", async () => {
    declareGates("t1", [{ criterion: "c", check: "false" }], "submission");
    const out = await applyCompletionLedger(base());
    expect(out.taskStatus).toBe("completed");
    expect(out.gates).toBeNull();
    expect(listGates("t1")[0]!.state).toBe("pending");
    expect(traceNames("t1").map((t) => t.name)).not.toContain(
      "gates.evaluated",
    );
  });

  it("mode shadow: checks run and the verdict is recorded (output.gates + trace) but status is untouched", async () => {
    process.env.TASK_GATES_MODE = "shadow";
    declareGates(
      "t1",
      [
        { criterion: "passes", check: "echo 3/3 ok", expect: "3/3" },
        { criterion: "fails", check: "false" },
      ],
      "submission",
    );
    const out = await applyCompletionLedger(base());
    expect(out.taskStatus).toBe("completed");
    expect(out.gates?.verdict).toBe("failed");
    const output = out.output as Record<string, unknown>;
    expect(output.gates).toMatchObject({
      mode: "shadow",
      verdict: "failed",
      met: 1,
      failed: 1,
    });
    expect(output.text).toBe("Listo. Hice todo."); // no block appended in shadow
    const ev = traceNames("t1").find((t) => t.name === "gates.evaluated");
    expect(ev?.attrs).toMatchObject({
      mode: "shadow",
      verdict: "failed",
      status_before: "completed",
    });
  });

  it("mode enforce: FAILED demotes completed → completed_with_concerns and appends the ledger block", async () => {
    process.env.TASK_GATES_MODE = "enforce";
    declareGates(
      "t1",
      [{ criterion: "fails", check: "false" }, { criterion: "manual" }],
      "submission",
    );
    const out = await applyCompletionLedger(
      base({ result: okResult({ finalAnswer: "Report", text: "meta" }) }),
    );
    expect(out.taskStatus).toBe("completed_with_concerns");
    const output = out.output as Record<string, unknown>;
    expect(output.finalAnswer).toMatch(
      /^Report\n\nGates: 0\/2 met · FAILED: G1 \(.*exit 1\)\) · unverified: G2$/,
    );
    expect(output.text).toBe("meta"); // only the first deliverable field is annotated
  });

  it("mode enforce: a MET ledger keeps completed and still pastes the ledger (N of N)", async () => {
    process.env.TASK_GATES_MODE = "enforce";
    declareGates("t1", [{ criterion: "ok", check: "true" }], "submission");
    const out = await applyCompletionLedger(base());
    expect(out.taskStatus).toBe("completed");
    expect((out.output as { text: string }).text).toBe(
      "Listo. Hice todo.\n\nGates: 1/1 met",
    );
  });

  it("mode enforce: ABANDON lines in the report are honored and listed; a string output gets the block appended", async () => {
    process.env.TASK_GATES_MODE = "enforce";
    declareGates(
      "t1",
      [{ criterion: "impossible", check: "false" }],
      "submission",
    );
    const out = await applyCompletionLedger(
      base({
        result: okResult("Report body\nABANDON: G1 the sandbox has no network"),
      }),
    );
    expect(out.taskStatus).toBe("completed"); // abandoned ≠ failed
    expect(out.output).toBe(
      "Report body\nABANDON: G1 the sandbox has no network\n\nGates: 0/1 met · ABANDONED: G1 (the sandbox has no network)",
    );
    expect(listGates("t1")[0]).toMatchObject({ state: "abandoned" });
  });

  it("does not touch a task that has no ledger (beyond the numbers audit)", async () => {
    process.env.TASK_GATES_MODE = "enforce";
    const out = await applyCompletionLedger(base());
    expect(out.taskStatus).toBe("completed");
    expect(out.gates).toBeNull();
    expect((out.output as { text: string }).text).toBe("Listo. Hice todo.");
  });

  it("a failed task is never promoted by a met ledger", async () => {
    process.env.TASK_GATES_MODE = "enforce";
    declareGates("t1", [{ criterion: "ok", check: "true" }], "submission");
    const out = await applyCompletionLedger(
      base({
        result: {
          success: false,
          error: "boom",
          durationMs: 1,
          output: { text: "partial" },
        },
        taskStatus: "failed",
      }),
    );
    expect(out.taskStatus).toBe("failed");
  });
});

describe("applyCompletionLedger — landing gate", () => {
  it("needsLandingGate: nanoclaw non-messaging only", () => {
    expect(needsLandingGate("nanoclaw", [])).toBe(true);
    expect(needsLandingGate("nanoclaw", ["messaging"])).toBe(false);
    expect(needsLandingGate("fast", [])).toBe(false);
    expect(needsLandingGate("heavy", [])).toBe(false);
  });

  it("declares G-landing for a successful nanoclaw coding task when the mode is on, and evaluates it", async () => {
    process.env.TASK_GATES_MODE = "shadow";
    const out = await applyCompletionLedger(
      base({
        agentType: "nanoclaw",
        result: okResult({ finalAnswer: "Todo listo, sin cambios." }),
      }),
    );
    const rows = listGates("t1");
    expect(rows.map((r) => [r.gate_id, r.source, r.check_kind])).toEqual([
      [LANDING_GATE_ID, "harness", "landing"],
    ]);
    // No claim in the report → unverified, never met.
    expect(out.gates?.verdict).toBe("unverified");
    expect(out.taskStatus).toBe("completed");
    // A report naming a branch that IS on origin verifies; a ghost branch fails.
    const landed = await applyCompletionLedger(
      base({
        taskId: "t-landed",
        agentType: "nanoclaw",
        result: okResult({
          finalAnswer: "Pushed branch feat/landed with the fix.",
        }),
      }),
    );
    expect(landed.gates?.verdict).toBe("met");
    process.env.TASK_GATES_MODE = "enforce";
    const ghost = await applyCompletionLedger(
      base({
        taskId: "t-ghost",
        agentType: "nanoclaw",
        result: okResult({
          finalAnswer: "Pushed branch feat/ghost with the fix.",
        }),
      }),
    );
    expect(ghost.gates?.verdict).toBe("failed");
    expect(ghost.taskStatus).toBe("completed_with_concerns");
  });

  it("does NOT declare a landing gate when off, for messaging tags, or for a failed run", async () => {
    await applyCompletionLedger(base({ agentType: "nanoclaw" }));
    expect(listGates("t1")).toEqual([]);
    process.env.TASK_GATES_MODE = "shadow";
    await applyCompletionLedger(
      base({ taskId: "t2", agentType: "nanoclaw", tags: ["messaging"] }),
    );
    expect(listGates("t2")).toEqual([]);
    await applyCompletionLedger(
      base({
        taskId: "t3",
        agentType: "nanoclaw",
        result: { success: false, durationMs: 1 },
        taskStatus: "failed",
      }),
    );
    expect(listGates("t3")).toEqual([]);
  });
});

describe("applyCompletionLedger — numbers audit", () => {
  it("audits the deliverable against recorded tool evidence + task input, annotates inline, records a trace + output field", async () => {
    recordToolEvidence("t1", '{"count": 1741}');
    const out = await applyCompletionLedger(
      base({
        taskDescription: "Report on the 436 brands",
        result: okResult({
          text: "1,741 hallazgos en 436 marcas; 99 registros sin clasificar.",
        }),
      }),
    );
    expect(out.numbers).toMatchObject({
      found: ["1,741", "436", "99"],
      unverified: ["99"],
    });
    expect((out.output as Record<string, unknown>).numbers_audit).toEqual({
      found: 3,
      unverified: ["99"],
      annotated: 1,
    });
    expect(
      traceNames("t1").find((t) => t.name === "numbers.audited")?.attrs,
    ).toMatchObject({
      found: 3,
      unverified: 1,
      evidence_chunks: 1,
      annotated: 1,
    });
    // Phase 3: the doubt sits where the number is — inline, by default.
    expect((out.output as { text: string }).text).toBe(
      "1,741 hallazgos en 436 marcas; 99 registros (sin verificar) sin clasificar.",
    );
  });

  it("a figure forwarded from a sibling's '## Shared findings' is NOT evidence (memory plan v2.0 Track 3, R1 C3)", async () => {
    // The exact shape buildSubTaskDescription emits (swarm-runner.ts): goal
    // text + criteria, then the runner-authored sibling sections LAST — a
    // "— Result:" 200-char slice of a sibling's deliverable, the forwarded
    // block, the Coordination contract. Only the first part is evidence.
    const forwarded = [
      "Compare Clip vs Kustodia fees for 12 merchants",
      "",
      "## Completion Criteria",
      "- one row per provider",
      "",
      "## Sibling goals (for coordination, not your responsibility)",
      "- Research Kustodia [completed] — Result: Kustodia cobra 1.2% por escrow y tiene 5,412,891 usuarios.",
      "- Research Conekta [running]",
      "",
      "## Shared findings from completed siblings",
      "### Research Clip",
      "- Clip: 3.6% + IVA per transaction",
      "",
      "## Coordination",
      '- Do not research what a sibling owns ("owned by g-N").',
    ].join("\n");
    const out = await applyCompletionLedger(
      base({
        taskDescription: forwarded,
        result: okResult({
          text: "Clip cobra 3.6% + IVA; Kustodia 1.2% con 5,412,891 usuarios; 12 comercios.",
        }),
      }),
    );
    // 12 comes from the goal text (evidence); the three sibling figures do not.
    expect(out.numbers?.unverified).toEqual(["3.6%", "1.2%", "5,412,891"]);
    expect((out.output as { text: string }).text).toBe(
      "Clip cobra 3.6% (sin verificar) + IVA; Kustodia 1.2% (sin verificar) con 5,412,891 usuarios (sin verificar); 12 comercios.",
    );
    expect(stripForwardedSiblingFindings(forwarded)).toBe(
      "Compare Clip vs Kustodia fees for 12 merchants\n\n## Completion Criteria\n- one row per provider",
    );
  });

  it("TASK_GATES_NUMBERS_ANNOTATE=false disarms the annotation (audit still recorded)", async () => {
    process.env.TASK_GATES_NUMBERS_ANNOTATE = "false";
    recordToolEvidence("t1", "nothing numeric");
    const out = await applyCompletionLedger(
      base({ result: okResult({ text: "Ingresos: $12,500" }) }),
    );
    expect((out.output as { text: string }).text).toBe("Ingresos: $12,500");
    expect(out.numbers?.unverified).toEqual(["$12,500"]);
  });

  it("falls back to the footer when the carrier cannot be rewritten in place", async () => {
    const out = await applyCompletionLedger(
      base({ result: okResult(JSON.stringify({ text: "Ingresos: $12,500" })) }),
    );
    expect(out.output).toBe(
      '{"text":"Ingresos: $12,500"}\n\n⚠️ Cifras sin respaldo en las herramientas de esta corrida (no verificadas): $12,500',
    );
  });

  it("audits a chat turn with NO tool evidence — figures from memory are the case (#11265)", async () => {
    const out = await applyCompletionLedger(
      base({ result: okResult({ text: "BSX cotiza en $78.40 hoy." }) }),
    );
    expect(out.numbers?.unverified).toEqual(["$78.40"]);
    expect((out.output as { text: string }).text).toBe(
      "BSX cotiza en $78.40 (sin verificar) hoy.",
    );
    const sched = await applyCompletionLedger(
      base({
        taskId: "t2",
        tags: ["scheduled"],
        result: okResult({ text: "88 registros" }),
      }),
    );
    expect(sched.numbers).toMatchObject({ found: ["88"], unverified: ["88"] });
  });
});

describe("applyCompletionLedger — citations (usability Phase 3.3)", () => {
  it("drops a positively-missing reference from the deliverable and records a trace; shadow leaves the text", async () => {
    const fetchMock = vi.fn(async (url: string) => ({
      status: url.includes("gone") ? 404 : 200,
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const text =
        "Resumen [1][2].\n\n## Referencias\n[1] https://example.com/ok\n[2] https://example.com/gone";
      const out = await applyCompletionLedger(
        base({ result: okResult({ text }) }),
      );
      expect((out.output as { text: string }).text).toBe(
        "Resumen [1].\n\n## Referencias\n[1] https://example.com/ok\n\n⚠️ Quité 1 referencia que no existe (DOI/URL/Crossref sin registro): «https://example.com/gone».",
      );
      expect(
        traceNames("t1").find((t) => t.name === "citations.checked")?.attrs,
      ).toMatchObject({ total: 2, resolved: 1, missing: 1, mode: "enforce" });

      process.env.CITATION_CHECK = "shadow";
      _resetCitationCache();
      const shadow = await applyCompletionLedger(
        base({ taskId: "t2", result: okResult({ text }) }),
      );
      expect((shadow.output as { text: string }).text).toBe(text);
      expect(
        traceNames("t2").find((t) => t.name === "citations.checked")?.attrs,
      ).toMatchObject({ missing: 1, mode: "shadow" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("reverifyChildLedger", () => {
  it("null when off or the child has no ledger; re-runs the checks (fresh evidence) when on", async () => {
    declareGates("child", [{ criterion: "ok", check: "true" }], "plan");
    expect(
      await reverifyChildLedger("parent", "child", { text: "done" }),
    ).toBeNull();
    process.env.TASK_GATES_MODE = "shadow";
    expect(await reverifyChildLedger("parent", "no-ledger", "done")).toBeNull();
    // Child claimed met with stale evidence; parent re-run overwrites it.
    recordGateResult("child", "G1", { state: "met", evidence: "stale" });
    const v = await reverifyChildLedger("parent", "child", { text: "done" });
    expect(v?.verdict).toBe("met");
    expect(listGates("child")[0]!.evidence).not.toBe("stale");
    expect(
      traceNames("parent").find((t) => t.name === "gates.parent_reverified")
        ?.attrs,
    ).toMatchObject({
      child_task_id: "child",
      verdict: "met",
    });
  });
});

describe("qa W1 fold — shell gates are not run against the host tree for container tasks", () => {
  it("nanoclaw: a plan shell gate stays pending (shell_skipped) while the landing gate still runs", async () => {
    process.env.TASK_GATES_MODE = "enforce";
    declareGates("t1", [{ criterion: "typecheck", check: "true" }], "plan");
    const out = await applyCompletionLedger(
      base({
        agentType: "nanoclaw",
        result: okResult({
          finalAnswer: "Pushed branch feat/landed with the fix.",
        }),
      }),
    );
    const rows = listGates("t1");
    expect(rows.map((r) => [r.gate_id, r.state])).toEqual([
      ["G1", "pending"],
      [LANDING_GATE_ID, "met"],
    ]);
    expect(out.gates?.shellSkipped).toBe(1);
    expect(out.gates?.verdict).toBe("unverified");
    expect(out.taskStatus).toBe("completed"); // unverified never demotes
    const ev = traceNames("t1").find((t) => t.name === "gates.evaluated");
    expect(ev?.attrs).toMatchObject({ shell_skipped: 1, budget_exhausted: 0 });
  });

  it("reverifyChildLedger skips shell gates for a nanoclaw child (looked up from tasks.agent_type)", async () => {
    process.env.TASK_GATES_MODE = "shadow";
    getDatabase()
      .prepare(
        `INSERT INTO tasks (task_id, title, description, status, agent_type) VALUES ('child-nc', 'c', 'd', 'completed', 'nanoclaw')`,
      )
      .run();
    declareGates(
      "child-nc",
      [{ criterion: "typecheck", check: "true" }],
      "plan",
    );
    const v = await reverifyChildLedger("parent", "child-nc", { text: "done" });
    expect(v?.verdict).toBe("unverified");
    expect(listGates("child-nc")[0]!.state).toBe("pending");
    // A fast child DOES get its shell gates re-run.
    declareGates(
      "child-fast",
      [{ criterion: "typecheck", check: "true" }],
      "plan",
    );
    expect(
      (await reverifyChildLedger("parent", "child-fast", { text: "done" }))
        ?.verdict,
    ).toBe("met");
  });
});
