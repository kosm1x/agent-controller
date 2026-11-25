import { describe, expect, it } from "vitest";
import type { TaskRow } from "./digest.js";
import { parseLedger, type Prediction } from "./ledger.js";
import { guardCandidates, instructionText, PREDICTION, proposalTypes, renderPackets, SELF_KEY, type NewestRun } from "./proposals.js";

const NOW = "2026-11-25T12:00:00.000Z";
const STATUS: Record<string, string> = { ".": "completed", C: "completed_with_concerns", F: "failed", R: "running" };

function row(over: Partial<TaskRow> = {}): TaskRow {
  return {
    task_id: "t",
    status: "completed",
    created_at: "2026-11-10 12:00:00",
    ritual_id: "alpha",
    schedule_id: null,
    schedule_name: null,
    tools: "{}",
    completed_at: "2026-11-10 12:01:00",
    guard_tools: '{"tool_a":1}',
    has_audit: 0,
    unverified: null,
    concern_detail: null,
    reply_tail: null,
    ...over,
  };
}

/** One run of `ritual` per day from 2026-11-10 on; counts[i] = that run's guard_tools (null: none). */
function runs(ritual: string, letters: string, counts: (Record<string, number> | null)[] = []): TaskRow[] {
  return [...letters].map((c, i) => {
    const day = String(10 + i).padStart(2, "0");
    return row({
      task_id: `${ritual}-${String(i).padStart(2, "0")}`,
      ritual_id: ritual,
      status: STATUS[c],
      created_at: `2026-11-${day} 12:00:00`,
      completed_at: c === "R" ? null : `2026-11-${day} 12:01:00`,
      guard_tools: counts[i] === undefined ? '{"tool_a":1}' : counts[i] === null ? null : JSON.stringify(counts[i]),
      concern_detail: c === "C" ? `concern text ${i}` : null,
    });
  });
}

const BASE = { id: "p1", type: "ritual:alpha", since: "2026-11-01T00:00:00Z", maxComplaints: 2, runs: 7, change: "ask for one report  per run", baseline: "a baseline" };
const CLOSED = { state: "REFUTED", checkedAt: "2026-11-05T00:00:00Z", line: "p1 REFUTED" };
const ledgerOf = (...objs: object[]): { src: string; predictions: Prediction[] } => {
  const src = objs.map((o) => JSON.stringify(o)).join("\n") + "\n";
  const { predictions, problems } = parseLedger(src, NOW);
  expect(problems).toEqual([]);
  return { src, predictions };
};
const NEWEST: NewestRun = { description: "Do the thing.\nThen report.", tools: ["tool_b", "tool_a"] };

describe("eligible types", () => {
  it("a triggered type with an open ledger row is not eligible", () => {
    const { predictions } = ledgerOf(BASE);
    expect(proposalTypes(runs("alpha", "CCCCCCC"), predictions, NOW)).toEqual({ covered: [], notCovered: [] });
  });

  it("a triggered type whose rows are all closed is eligible; a type under the trigger is not", () => {
    const { predictions } = ledgerOf({ ...BASE, closed: CLOSED, answer: "the outputs read worse" });
    const rows = [...runs("alpha", "CCCCCCC"), ...runs("beta", "CCCC...")];
    expect(proposalTypes(rows, predictions, NOW)).toEqual({ covered: [{ key: "ritual:alpha", newestTaskId: "alpha-06" }], notCovered: [] });
  });

  it("this ritual's own type is never eligible", () => {
    expect(SELF_KEY).toBe("ritual:complaints-proposals");
    const rows = [...runs("complaints-proposals", "CCCCCCC"), ...runs("alpha", "CCCCC..")];
    expect(proposalTypes(rows, [], NOW)).toEqual({ covered: [{ key: "ritual:alpha", newestTaskId: "alpha-06" }], notCovered: [] });
  });

  it("orders by complaints in the last 7, then by key, and covers 3", () => {
    const rows = [
      ...runs("delta", "CCCCC.."),
      ...runs("beta", "CCCCCCC"),
      ...runs("gamma", "CCCCCC."),
      ...runs("alpha", "CCCCCC."),
      ...runs("epsilon", "...."),
    ];
    expect(proposalTypes(rows, [], NOW)).toEqual({
      covered: [
        { key: "ritual:beta", newestTaskId: "beta-06" },
        { key: "ritual:alpha", newestTaskId: "alpha-06" },
        { key: "ritual:gamma", newestTaskId: "gamma-06" },
      ],
      notCovered: ["ritual:delta"],
    });
    expect(renderPackets(rows, [], "", {}, NOW).map((p) => p.key)).toEqual(["ritual:beta", "ritual:alpha", "ritual:gamma"]);
  });
});

describe("instruction text", () => {
  it("is cut before the first line that starts a data fence", () => {
    const d = 'Step one.\nA line quoting "⟦BEGIN" mid-line stays.\n\n⟦BEGIN DAY-LOG x — p — 3 chars, complete⟧\ndata\n⟦END DAY-LOG x⟧';
    expect(instructionText(d)).toBe('Step one.\nA line quoting "⟦BEGIN" mid-line stays.');
  });

  it("is cut at the cap with one marker line, and left whole at the cap", () => {
    expect(instructionText("x".repeat(6_000))).toBe("x".repeat(6_000));
    expect(instructionText("x".repeat(6_001))).toBe(`${"x".repeat(6_000)}\n[cut at 6,000 characters: the rest of the instruction text is not shown]`);
  });
});

describe("guard candidates", () => {
  const ten = (c: Record<string, number>) => Array.from({ length: 10 }, () => c);

  it("a tool called in every run is a candidate; a tool missing from one run is not", () => {
    const counts = ten({ tool_a: 2, tool_b: 1 });
    counts[4] = { tool_a: 1 };
    const g = guardCandidates(runs("alpha", "CCCCC.CCCC", counts), "ritual:alpha", NOW);
    expect(g.guards).toEqual([{ tool: "tool_a", min: 1, maxBelow: 0 }]);
    expect(g.ranges).toEqual([{ tool: "tool_a", min: 1, max: 2 }, { tool: "tool_b", min: 0, max: 1 }]);
    expect(g.runs).toBe(10);
  });

  it("the read pair is one set guard when neither tool is in every run but their sum is", () => {
    const counts = Array.from({ length: 6 }, (_, i): Record<string, number> => (i % 2 ? { file_read: 1 } : { jarvis_file_read: 2 }));
    expect(guardCandidates(runs("alpha", "CCCCCC", counts), "ritual:alpha", NOW).guards).toEqual([
      { tools: ["file_read", "jarvis_file_read"], min: 1, maxBelow: 0 },
    ]);
    // One of the pair in every run alone: that tool, and no set.
    const both = Array.from({ length: 6 }, (_, i): Record<string, number> => (i % 2 ? { file_read: 1, jarvis_file_read: 1 } : { jarvis_file_read: 1 }));
    expect(guardCandidates(runs("alpha", "CCCCCC", both), "ritual:alpha", NOW).guards).toEqual([{ tool: "jarvis_file_read", min: 1, maxBelow: 0 }]);
  });

  it("needs 5 finished runs with counts; in-flight runs, runs without counts and older runs are left out", () => {
    // 4 finished with counts, 1 without counts, 1 in flight: no candidates.
    expect(guardCandidates(runs("alpha", "CCCCCR", [{ x: 1 }, { x: 1 }, { x: 1 }, { x: 1 }, null]), "ritual:alpha", NOW))
      .toEqual({ runs: 4, ranges: [{ tool: "x", min: 1, max: 1 }], guards: [] });
    // 12 runs: only the last 10 count, so the two early runs without tool_b do not matter.
    const twelve = [{ tool_a: 1 }, { tool_a: 1 }, ...ten({ tool_a: 1, tool_b: 3 })];
    expect(guardCandidates(runs("alpha", "CCCCCCCCCCCC", twelve), "ritual:alpha", NOW).guards).toEqual([
      { tool: "tool_a", min: 1, maxBelow: 0 },
      { tool: "tool_b", min: 1, maxBelow: 0 },
    ]);
    // A run that finished in the second of `now` is not judged yet.
    const late = runs("alpha", "CCCCC").map((r, i) => (i === 4 ? { ...r, completed_at: "2026-11-25 12:00:00" } : r));
    expect(guardCandidates(late, "ritual:alpha", NOW).runs).toBe(4);
  });

  it("candidates round-trip through parseLedger as a row's guards", () => {
    const counts = Array.from({ length: 5 }, (_, i): Record<string, number> => (i % 2 ? { file_read: 1, tool_a: 1 } : { jarvis_file_read: 1, tool_a: 4 }));
    const { guards } = guardCandidates(runs("alpha", "CCCCC", counts), "ritual:alpha", NOW);
    expect(guards).toHaveLength(2);
    const { predictions } = ledgerOf({ ...BASE, guards });
    expect(predictions[0].guards).toEqual(guards);
  });
});

describe("packets", () => {
  const rows = [
    ...runs("alpha", ".FCCCCCC", [...Array.from({ length: 7 }, () => ({ tool_a: 1, tool_b: 2 })), { tool_a: 3 }]),
    ...runs("beta", "CCCCCCC"),
  ];
  const ledger = ledgerOf(
    { ...BASE, closed: CLOSED, answer: "outputs since the change read worse" },
    { ...BASE, id: "p2", type: "ritual:beta" },
  );
  const newest = { "ritual:alpha": NEWEST };

  it("renders the parts in fixed order, prior rows with the read word only", () => {
    const [p] = renderPackets(rows, ledger.predictions, ledger.src, newest, NOW);
    expect(p.key).toBe("ritual:alpha");
    expect(p.text).toContain("- p1: closed REFUTED; operator's read: worse\n  change: ask for one report per run\n");
    expect(p.text).not.toContain("outputs since the change");
    const order = [
      "type ritual:alpha  name alpha",
      "== complaints digest (code output)\nComplaints digest: 30 days to 2026-11-25T12:00:00.000Z",
      "== earlier predictions on this type",
      "== instruction text the task receives on every run (newest run alpha-07)\nDo the thing.\nThen report.\n",
      "== tools the task is given\ntool_a, tool_b\n",
      "== calls per run: fewest-most over the last 8 finished run(s) with counts (calls with no did-not-run gate row)\ntool_a 1-3\ntool_b 0-2\n",
      `== computed prediction (copy unchanged)\nprediction: ${PREDICTION}\nbaseline: 6 of 8 runs ended with concerns and 1 failed in the 30 days to 2026-11-25; last 7: 7 of 7 ended with concerns or failed\n`,
      '== guard candidates (computed; copy unchanged)\n{"tool":"tool_a","min":1,"maxBelow":0}\n',
    ].map((s) => p.text.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(PREDICTION).toBe("at most 2 of the next 7 runs end as a complaint");
  });

  it("states the baseline without failed runs in the ledger's wording, and a run with no declared list", () => {
    const only = runs("gamma", "CCCCCCC");
    const [p] = renderPackets(only, [], "", { "ritual:gamma": { description: "x", tools: null } }, NOW);
    expect(p.text).toContain("baseline: 7 of 7 runs ended with concerns in the 30 days to 2026-11-25; last 7: 7 of 7\n");
    expect(p.text).toContain("== tools the task is given\nno list declared: the run is offered every tool that exists\n");
    expect(p.text).toContain("== earlier predictions on this type\nnone\n");
  });

  it("is byte-identical under shuffled rows", () => {
    const a = renderPackets(rows, ledger.predictions, ledger.src, newest, NOW);
    const b = renderPackets([...rows].reverse(), ledger.predictions, ledger.src, newest, NOW);
    const c = renderPackets([...rows.slice(3), ...rows.slice(0, 3)], ledger.predictions, ledger.src, newest, NOW);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });
});
