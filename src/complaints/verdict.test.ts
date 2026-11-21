import { describe, expect, it } from "vitest";
import type { TaskRow } from "./digest.js";
import { buildVerdict, renderVerdict, type VerdictOptions } from "./verdict.js";

const TYPE = "ritual:pred";
const NOW = "2026-11-20T18:00:00.000Z";
const SINCE = "2026-11-15T12:00:00.000Z";
const STATUS: Record<string, string> = {
  ".": "completed",
  C: "completed_with_concerns",
  F: "failed",
  X: "cancelled",
  R: "running",
  Q: "queued",
  P: "pending",
  N: "needs_context",
  B: "blocked",
  U: "some_new_status",
};
const IN_FLIGHT = "RQPNBU";

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

const at = (i: number): string => {
  const d = new Date(Date.parse("2026-11-15T12:00:00Z") + i * 3_600_000);
  return d.toISOString().slice(0, 19).replace("T", " ");
};

/** One run per hour from S on, in the letters above. */
function runs(letters: string, over: Partial<TaskRow> = {}): TaskRow[] {
  return [...letters].map((c, i) =>
    row({ task_id: `t${String(i).padStart(2, "0")}`, status: STATUS[c], created_at: at(i), ...over }),
  );
}

const verdict = (rows: TaskRow[], o: Partial<VerdictOptions> = {}) =>
  buildVerdict(rows, { now: NOW, type: TYPE, since: SINCE, maxComplaints: 2, runs: 7, ...o });
const word = (letters: string, o: Partial<VerdictOptions> = {}) => verdict(runs(letters), o).verdict;

describe("buildVerdict", () => {
  it("fewer than N runs and still undecided: COUNTING", () => {
    const v = verdict(runs(".C"));
    expect([v.verdict, v.counted, v.complaints, v.unknown, v.strip]).toEqual(["COUNTING", 2, 1, 5, ".C"]);
  });

  it("REFUTED as soon as complaints exceed K (K+1); K complaints alone is not refuted", () => {
    expect(word("CCC")).toBe("REFUTED");
    expect(verdict(runs("CCC")).counted).toBe(3);
    expect(word("CC")).toBe("COUNTING");
  });

  it("CONFIRMED as soon as complaints plus unknown slots cannot exceed K", () => {
    // 0 complaints, 2 empty slots, K = 2: confirmed after 5 runs, not after 4.
    expect(word(".....")).toBe("CONFIRMED");
    expect(word("....")).toBe("COUNTING");
    expect(word("C....")).toBe("COUNTING");
    expect(word("C.....")).toBe("CONFIRMED");
  });

  it("exactly K complaints in N runs is CONFIRMED", () => {
    const v = verdict(runs("C.C...."));
    expect([v.verdict, v.counted, v.complaints, v.unknown]).toEqual(["CONFIRMED", 7, 2, 0]);
  });

  it("K = 0: one complaint refutes, N clean runs confirm, fewer keep counting", () => {
    expect(word("C", { maxComplaints: 0 })).toBe("REFUTED");
    expect(word(".......", { maxComplaints: 0 })).toBe("CONFIRMED");
    expect(word("......", { maxComplaints: 0 })).toBe("COUNTING");
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

  it("S is floored to the second: a run stamped in that second is at or after it", () => {
    const rows = [
      row({ task_id: "prev-second", created_at: "2026-11-15 11:59:59" }),
      row({ task_id: "same-second", created_at: "2026-11-15 12:00:00" }),
    ];
    expect(verdict(rows, { since: "2026-11-15T12:00:00.500Z" }).runList.map((r) => r.taskId)).toEqual(["same-second"]);
  });

  it("runs queued in the second of now wait for a later check; the second before counts", () => {
    const rows = [
      row({ task_id: "b", status: STATUS.C, created_at: "2026-11-20 17:59:59" }),
      row({ task_id: "a", status: STATUS.C, created_at: "2026-11-20 18:00:00" }),
    ];
    const v = verdict(rows, { maxComplaints: 0 });
    expect([v.runList.map((r) => r.taskId), v.deferred]).toEqual([["b"], 1]);
    expect(renderVerdict(v)).toContain("  queued in the second of the check, left for the next check: 1\n");
  });

  it("in-flight runs hold a slot as unknown, every in-flight status alike", () => {
    for (const s of IN_FLIGHT) {
      const v = verdict(runs(`.${s}.`));
      expect([s, v.counted, v.unknown, v.strip, v.inFlight.map((r) => r.status)]).toEqual([s, 2, 5, ".?.", [STATUS[s]]]);
    }
    // N = 2, K = 0: the clean run and the in-flight one fill both slots; the
    // later clean run does not take the in-flight run's place.
    expect(word(".R.", { runs: 2, maxComplaints: 0 })).toBe("COUNTING");
  });

  it("needs_context and blocked are not complaints: once they finish clean the verdict closes", () => {
    expect(word("N.", { runs: 2, maxComplaints: 0 })).toBe("COUNTING");
    expect(word("..", { runs: 2, maxComplaints: 0 })).toBe("CONFIRMED");
    expect(verdict(runs("NB")).complaints).toBe(0);
  });

  it("cancelled runs never take a slot: before, between and after the counted runs", () => {
    for (const letters of ["X..C", ".X.C", "..CX", "X.X.X."]) {
      const v = verdict(runs(letters), { runs: 3, maxComplaints: 0 });
      expect([letters, v.strip.includes("X"), v.counted, v.cancelled.length]).toEqual([letters, false, 3, (letters.match(/X/g) ?? []).length]);
    }
    expect(word("X..C", { runs: 3, maxComplaints: 0 })).toBe("REFUTED");
    expect(word("..CX", { runs: 3, maxComplaints: 0 })).toBe("REFUTED");
    expect(word("..X.C", { runs: 3, maxComplaints: 0 })).toBe("CONFIRMED");
    expect(verdict(runs("..X.C"), { runs: 3, maxComplaints: 0 }).ignoredAfterN).toBe(1);
  });

  it("only the first N slots count: a complaint in run N+1 changes nothing", () => {
    const v = verdict(runs("...C"), { runs: 3, maxComplaints: 0 });
    expect([v.verdict, v.counted, v.complaints, v.ignoredAfterN]).toEqual(["CONFIRMED", 3, 0, 1]);
    const w = verdict(runs(".R..C"), { runs: 3, maxComplaints: 0 });
    expect([w.verdict, w.counted, w.inFlight.length, w.ignoredAfterN]).toEqual(["COUNTING", 2, 1, 2]);
  });

  it("queue order is created_at, then task_id: same-second runs sort by id, not by input order", () => {
    const rows = [
      row({ task_id: "b", status: STATUS["."], created_at: "2026-11-16 12:00:00" }),
      row({ task_id: "a", status: STATUS.C, created_at: "2026-11-16 12:00:00" }),
    ];
    const v = verdict(rows, { runs: 1, maxComplaints: 0 });
    expect([v.verdict, v.runList.map((r) => r.taskId)]).toEqual(["REFUTED", ["a"]]);
  });

  it("orders by queue time, not by input order, and ignores other types", () => {
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
    expect([v.verdict, v.counted, v.runs, v.complaints, v.unknown, v.builds]).toEqual(["COUNTING", 0, 7, 0, 7, []]);
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

describe("a closed verdict never flips", () => {
  // The audit's fixtures (now NOW, S SINCE, K 1, N 2): before, the rule must
  // not print a closed verdict that the later state contradicts.
  const o = { maxComplaints: 1, runs: 2 };
  const day = (d: number, s: string, id: string) => row({ task_id: id, status: s, created_at: `2026-11-${d} 12:00:00` });

  it("[running, concerns, clean] then the running run is reaped to failed", () => {
    expect(verdict([day(16, "running", "a"), day(17, STATUS.C, "b"), day(18, STATUS["."], "c")], o).verdict).toBe("COUNTING");
    expect(verdict([day(16, "failed", "a"), day(17, STATUS.C, "b"), day(18, STATUS["."], "c")], o).verdict).toBe("REFUTED");
  });

  it("[needs_context, concerns, concerns] then the first completes clean", () => {
    expect(verdict([day(16, "needs_context", "a"), day(17, STATUS.C, "b"), day(18, STATUS.C, "c")], o).verdict).toBe("COUNTING");
    expect(verdict([day(16, "completed", "a"), day(17, STATUS.C, "b"), day(18, STATUS.C, "c")], o).verdict).toBe("CONFIRMED");
  });

  it("[queued, running, clean] then both are reaped to failed", () => {
    const before = verdict([day(16, "queued", "a"), day(17, "running", "b"), day(18, STATUS["."], "c")], o);
    expect([before.verdict, before.counted]).toEqual(["COUNTING", 0]);
    expect(verdict([day(16, "failed", "a"), day(17, "failed", "b"), day(18, STATUS["."], "c")], o).verdict).toBe("REFUTED");
  });

  it("property: random legal transitions never change a closed verdict", () => {
    let seed = 20261121;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return Math.floor((seed / 2147483648) * n);
    };
    const pick = (s: string): string => s[rand(s.length)];
    let closedSeen = 0;
    for (let trial = 0; trial < 3000; trial++) {
      const N = 1 + rand(5);
      const K = rand(N);
      const seq: TaskRow[] = [];
      // Some runs share a second, so the task_id tiebreak is exercised too.
      const add = (letter: string) => {
        const i = seq.length;
        const sec = rand(3) === 0 && i > 0 ? seq[i - 1].created_at : at(i);
        seq.push(row({ task_id: `t${String(i).padStart(3, "0")}`, status: STATUS[letter], created_at: sec }));
      };
      for (let i = rand(9); i > 0; i--) add(pick(".CFX" + IN_FLIGHT));
      let closed: string | null = null;
      for (let step = 0; step < 15; step++) {
        const v = verdict(seq, { runs: N, maxComplaints: K }).verdict;
        if (closed !== null) expect([trial, step, v]).toEqual([trial, step, closed]);
        else if (v !== "COUNTING") closed = v;
        const open = seq.filter((r) => IN_FLIGHT.split("").some((c) => STATUS[c] === r.status));
        if (open.length > 0 && rand(3) > 0) open[rand(open.length)].status = STATUS[pick(".CFXRQN")];
        else add(pick(".CFX" + IN_FLIGHT));
      }
      if (closed !== null) closedSeen++;
    }
    expect(closedSeen).toBeGreaterThan(1000);
  });

  it("property: checks at an advancing clock, appends in the second of the check with any task id (lower ones too)", () => {
    let seed = 777;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return Math.floor((seed / 2147483648) * n);
    };
    const pick = (s: string): string => s[rand(s.length)];
    const base = Date.parse("2026-11-15T12:00:00Z");
    const iso = (k: number): string => new Date(base + k * 1000).toISOString();
    let closedSeen = 0;
    let sameSecondLower = 0;
    for (let trial = 0; trial < 3000; trial++) {
      const N = 1 + rand(5);
      const K = rand(N);
      let clock = 3 + rand(5);
      const seq: TaskRow[] = [];
      const add = (letter: string, k: number) => {
        const created = iso(k).slice(0, 19).replace("T", " ");
        const id = `${rand(65536).toString(16).padStart(4, "0")}-${seq.length}`;
        if (seq.some((r) => r.created_at === created && r.task_id > id)) sameSecondLower++;
        seq.push(row({ task_id: id, status: STATUS[letter], created_at: created }));
      };
      for (let i = rand(9); i > 0; i--) add(pick(".CFX" + IN_FLIGHT), rand(clock));
      let closed: string | null = null;
      for (let step = 0; step < 25; step++) {
        const v = verdict(seq, { now: iso(clock), runs: N, maxComplaints: K }).verdict;
        if (closed !== null) expect([trial, step, v]).toEqual([trial, step, closed]);
        else if (v !== "COUNTING") closed = v;
        const open = seq.filter((r) => IN_FLIGHT.split("").some((c) => STATUS[c] === r.status));
        const move = rand(4);
        if (move === 0) clock += 1 + rand(2);
        else if (move === 1 || open.length === 0) add(pick(".CFX" + IN_FLIGHT), clock);
        else open[rand(open.length)].status = STATUS[pick(".CFXRQN")];
      }
      if (closed !== null) closedSeen++;
    }
    expect(closedSeen).toBeGreaterThan(1000);
    expect(sameSecondLower).toBeGreaterThan(1000);
  });
});

describe("renderVerdict", () => {
  it("header, verdict line, slots, counted runs, then in flight, cancelled and after-N lines", () => {
    const rows = runs(".CXR.").map((r) => ({ ...r, build: "aaa1111", concern_detail: "x".repeat(600) }));
    const text = renderVerdict(verdict(rows, { runs: 3, maxComplaints: 1 }));
    expect(text.split("\n")).toEqual([
      `Prediction: ${TYPE} has at most 1 complaint(s) (concerns+failed) in its first 3 runs queued at or after ${SINCE}; checked at ${NOW}`,
      "verdict: COUNTING  counted 2/3  unknown 1  complaints 1 (limit 1)",
      "  slots, oldest left: [.C?]",
      "  to close: 1 more complaint(s) would refute it; 1 more clean result(s) would confirm it",
      "  waiting for 1 run(s) still in flight",
      "    2026-11-15 12:00:00 completed @aaa1111",
      `    2026-11-15 13:00:00 completed_with_concerns @aaa1111 [concern] ${"x".repeat(500)}`,
      "  in flight, holding a slot: 1",
      "    2026-11-15 15:00:00 running t03",
      "  cancelled, ignored: 1",
      "    2026-11-15 14:00:00 cancelled t02",
      "  after the first 3: 1",
      "  queued in the second of the check, left for the next check: 0",
      "",
    ]);
  });

  it("COUNTING with only empty slots: the closing line, no waiting line", () => {
    const text = renderVerdict(verdict(runs(".C")));
    expect(text).toContain("verdict: COUNTING  counted 2/7  unknown 5  complaints 1 (limit 2)\n");
    expect(text).toContain("  to close: 2 more complaint(s) would refute it; 4 more clean result(s) would confirm it\n");
    expect(text).not.toContain("waiting");
  });

  it("closed verdicts print no closing line; the verdict line carries unknown", () => {
    expect(renderVerdict(verdict(runs("CCC")))).toContain("verdict: REFUTED  counted 3/7  unknown 4  complaints 3 (limit 2)\n");
    expect(renderVerdict(verdict(runs("CCC")))).not.toContain("to close");
    expect(renderVerdict(verdict(runs("....."))).split("\n")[1]).toBe("verdict: CONFIRMED  counted 5/7  unknown 2  complaints 0 (limit 2)");
  });

  it("needs_context and blocked are named; no waiting line once the verdict is closed", () => {
    const text = renderVerdict(verdict(runs(".NB"), { runs: 3, maxComplaints: 2 }));
    expect(text).toContain("  needs_context and blocked: not a complaint; holds its slot until it resolves\n");
    expect(text).not.toContain("waiting");
    expect(text).not.toContain("to close");
    expect(text).toContain("verdict: CONFIRMED");
    expect(renderVerdict(verdict(runs(".R"), { runs: 3 }))).not.toContain("not a complaint");
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
