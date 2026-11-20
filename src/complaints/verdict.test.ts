import { describe, expect, it } from "vitest";
import type { TaskRow } from "./digest.js";
import { buildVerdict, renderVerdict, type VerdictOptions } from "./verdict.js";

const TYPE = "ritual:pred";
const SINCE = "2026-11-15T12:00:00.000Z";
const STATUS: Record<string, string> = {
  ".": "completed",
  C: "completed_with_concerns",
  F: "failed",
  R: "running",
  X: "cancelled",
};

function row(over: Partial<TaskRow> = {}): TaskRow {
  return {
    task_id: "t",
    status: "completed",
    created_at: "2026-11-15 12:00:00",
    ritual_id: "pred",
    schedule_id: null,
    schedule_name: null,
    tools: null,
    has_audit: 0,
    unverified: null,
    concern_detail: null,
    reply_tail: null,
    ...over,
  };
}

/** One run per hour from S on, in the letters above. */
function runs(letters: string, over: Partial<TaskRow> = {}): TaskRow[] {
  return [...letters].map((c, i) =>
    row({
      task_id: `t${String(i).padStart(2, "0")}`,
      status: STATUS[c],
      created_at: `2026-11-15 ${String(12 + i).padStart(2, "0")}:00:00`,
      ...over,
    }),
  );
}

const verdict = (rows: TaskRow[], o: Partial<VerdictOptions> = {}) =>
  buildVerdict(rows, { now: "2026-11-20T18:00:00.000Z", type: TYPE, since: SINCE, maxComplaints: 2, runs: 7, ...o });

describe("buildVerdict", () => {
  it("fewer than N runs and still undecided: COUNTING", () => {
    const v = verdict(runs(".C"));
    expect([v.verdict, v.counted, v.complaints, v.strip]).toEqual(["COUNTING", 2, 1, ".C"]);
  });

  it("REFUTED as soon as complaints exceed K (K+1); K complaints alone is not refuted", () => {
    expect(verdict(runs("CCC")).verdict).toBe("REFUTED");
    expect(verdict(runs("CCC")).counted).toBe(3);
    expect(verdict(runs("CC")).verdict).toBe("COUNTING");
  });

  it("CONFIRMED as soon as the runs left cannot push complaints past K", () => {
    // 0 complaints, 2 runs left, K = 2: confirmed after 5 runs, not after 4.
    expect(verdict(runs(".....")).verdict).toBe("CONFIRMED");
    expect(verdict(runs("....")).verdict).toBe("COUNTING");
    expect(verdict(runs("C....")).verdict).toBe("COUNTING");
    expect(verdict(runs("C.....")).verdict).toBe("CONFIRMED");
  });

  it("exactly K complaints in N runs is CONFIRMED", () => {
    const v = verdict(runs("C.C...."));
    expect([v.verdict, v.counted, v.complaints]).toEqual(["CONFIRMED", 7, 2]);
  });

  it("K = 0: one complaint refutes, N clean runs confirm, fewer keep counting", () => {
    expect(verdict(runs("C"), { maxComplaints: 0 }).verdict).toBe("REFUTED");
    expect(verdict(runs("......."), { maxComplaints: 0 }).verdict).toBe("CONFIRMED");
    expect(verdict(runs("......"), { maxComplaints: 0 }).verdict).toBe("COUNTING");
    expect(verdict([], { maxComplaints: 0 }).verdict).toBe("COUNTING");
  });

  it("a failed run is a complaint", () => {
    const v = verdict(runs("F"), { maxComplaints: 0 });
    expect([v.verdict, v.complaints, v.strip]).toEqual(["REFUTED", 1, "F"]);
  });

  it("runs before S are excluded and a run at S itself is included", () => {
    const rows = [
      row({ task_id: "before", status: STATUS.C, created_at: "2026-11-15 11:59:59" }),
      row({ task_id: "at", status: STATUS.C, created_at: "2026-11-15 12:00:00" }),
    ];
    const v = verdict(rows, { maxComplaints: 0 });
    expect([v.verdict, v.counted, v.complaints]).toEqual(["REFUTED", 1, 1]);
    expect(v.runList.map((r) => r.taskId)).toEqual(["at"]);
  });

  it("an S with milliseconds: a run earlier in the same second is before S", () => {
    const rows = [
      row({ task_id: "same-second", created_at: "2026-11-15 12:00:00" }),
      row({ task_id: "next-second", created_at: "2026-11-15 12:00:01" }),
    ];
    expect(verdict(rows, { since: "2026-11-15T12:00:00.500Z" }).runList.map((r) => r.taskId)).toEqual(["next-second"]);
  });

  it("unfinished runs are not counted, and are reported", () => {
    const v = verdict(runs(".R.X"));
    expect([v.counted, v.unfinished, v.strip]).toEqual([2, 2, ".."]);
  });

  it("only the first N finished runs count: a complaint in run N+1 changes nothing", () => {
    const v = verdict(runs("...C"), { runs: 3, maxComplaints: 0 });
    expect([v.verdict, v.counted, v.complaints, v.ignoredAfterN]).toEqual(["CONFIRMED", 3, 0, 1]);
    // An unfinished run inside the first N does not take a place.
    const w = verdict(runs(".R..C"), { runs: 3, maxComplaints: 0 });
    expect([w.verdict, w.counted, w.unfinished, w.ignoredAfterN]).toEqual(["CONFIRMED", 3, 1, 1]);
  });

  it("orders by start time, not by input order, and ignores other types", () => {
    const rows = [
      ...runs("C.."),
      row({ task_id: "other", status: STATUS.C, ritual_id: "else" }),
      row({ task_id: "sched", status: STATUS.C, ritual_id: null, schedule_id: "pred" }),
    ].reverse();
    const v = verdict(rows, { runs: 2, maxComplaints: 0 });
    expect([v.strip, v.verdict, v.ignoredAfterN]).toEqual(["C.", "REFUTED", 1]);
  });

  it("a type with no runs: COUNTING 0/N", () => {
    const v = verdict(runs("CC", { ritual_id: "else" }));
    expect([v.verdict, v.counted, v.runs, v.complaints, v.builds]).toEqual(["COUNTING", 0, 7, 0, []]);
  });

  it("builds: distinct, oldest first, no build counted as one", () => {
    const rows = runs("...").map((r, i) => ({ ...r, build: ["aaa1111", null, "aaa1111"][i] }));
    expect(verdict(rows).builds).toEqual(["aaa1111", null]);
    expect(verdict(runs("..", { build: " bbb2222 " })).builds).toEqual(["bbb2222"]);
  });

  it("run list: evidence text for complaints, none for clean runs", () => {
    const rows = runs(".CF").map((r, i) => ({ ...r, concern_detail: ["", "  the  concern ", null][i], reply_tail: "tail" }));
    expect(verdict(rows).runList.map((r) => [r.status, r.source, r.text])).toEqual([
      ["completed", null, null],
      ["completed_with_concerns", "concern", "the concern"],
      ["failed", "reply", "tail"],
    ]);
  });
});

describe("renderVerdict", () => {
  it("header, verdict line, strip, not-counted line, one line per run", () => {
    const rows = runs(".CR.").map((r) => ({ ...r, build: "aaa1111", concern_detail: "x".repeat(600) }));
    const text = renderVerdict(verdict(rows, { runs: 2 }));
    expect(text.split("\n")).toEqual([
      `Prediction: ${TYPE} has at most 2 complaint(s) (concerns+failed) in its first 2 finished runs started at or after ${SINCE}; checked at 2026-11-20T18:00:00.000Z`,
      "verdict: CONFIRMED  counted 2/2  complaints 1 (limit 2)",
      "  counted runs, oldest left: [.C]",
      "  not counted: 1 unfinished, 1 after the first 2",
      "    2026-11-15 12:00:00 completed @aaa1111",
      `    2026-11-15 13:00:00 completed_with_concerns @aaa1111 [concern] ${"x".repeat(500)}`,
      "",
    ]);
  });

  it("a caveat line only when the counted runs span more than one build", () => {
    const two = runs("..").map((r, i) => ({ ...r, build: i === 0 ? "aaa1111" : null }));
    const text = renderVerdict(verdict(two));
    expect(text).toContain("    2026-11-15 13:00:00 completed @-\n");
    expect(text).toContain("  caveat: the counted runs span 2 builds, oldest first: aaa1111 · no build\n");
    expect(renderVerdict(verdict(runs("..", { build: "aaa1111" })))).not.toContain("caveat");
    expect(renderVerdict(verdict(runs("..")))).not.toContain("caveat");
  });
});
