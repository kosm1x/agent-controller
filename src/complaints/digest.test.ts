import { describe, expect, it } from "vitest";
import { buildDigest, renderDigest, type DigestOptions, type TaskRow } from "./digest.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { complaintsSql, GATED_NOT_RUN } from "./query.js";

const OPTS: DigestOptions = { now: "2026-11-20T12:00:00.000Z", days: 30, last: 7, min: 5 };

let seq = 0;
function row(over: Partial<TaskRow> = {}): TaskRow {
  seq++;
  return {
    task_id: `task${String(seq).padStart(4, "0")}-rest`,
    status: "completed",
    created_at: `2026-11-${String(1 + (seq % 28)).padStart(2, "0")} 12:00:00`,
    ritual_id: "r1",
    schedule_id: null,
    schedule_name: null,
    tools: "{}",
    has_audit: 0,
    unverified: null,
    concern_detail: null,
    reply_tail: null,
    ...over,
  };
}

/** Runs of one ritual from a status string, one per day starting 2026-11-01. */
function runs(statuses: string, over: Partial<TaskRow> = {}): TaskRow[] {
  const map: Record<string, string> = { ".": "completed", C: "completed_with_concerns", F: "failed", "?": "running" };
  return [...statuses].map((s, i) =>
    row({ status: map[s], created_at: `2026-11-${String(i + 1).padStart(2, "0")} 12:00:00`, ...over }),
  );
}

const only = (rows: TaskRow[], opts: Partial<DigestOptions> = {}) => {
  const d = buildDigest(rows, { ...OPTS, ...opts });
  expect(d.types).toHaveLength(1);
  return d.types[0];
};

describe("grouping", () => {
  it("groups by ritual id and by schedule tag; a task with neither is ignored", () => {
    const d = buildDigest(
      [
        row({ ritual_id: "a" }),
        row({ ritual_id: "a" }),
        row({ ritual_id: null, schedule_id: "s1", schedule_name: "Daily report" }),
        row({ ritual_id: null, schedule_id: null }),
      ],
      OPTS,
    );
    expect(d.types.map((t) => [t.key, t.name, t.runs])).toEqual([
      ["ritual:a", "a", 2],
      ["schedule:s1", "Daily report", 1],
    ]);
  });

  it("a task with both a ritual id and a schedule tag counts once, under the ritual", () => {
    const d = buildDigest([row({ ritual_id: "a", schedule_id: "s1", schedule_name: "S" })], OPTS);
    expect(d.types.map((t) => [t.key, t.runs])).toEqual([["ritual:a", 1]]);
  });

  it("--type keeps one type only", () => {
    const d = buildDigest([row({ ritual_id: "a" }), row({ ritual_id: "b" })], { ...OPTS, type: "ritual:b" });
    expect(d.types.map((t) => t.key)).toEqual(["ritual:b"]);
  });

  it("types sort by complaints in the last N, then by key", () => {
    const d = buildDigest(
      [...runs("CC", { ritual_id: "z" }), ...runs("C", { ritual_id: "b" }), ...runs("C", { ritual_id: "a" })],
      OPTS,
    );
    expect(d.types.map((t) => t.key)).toEqual(["ritual:z", "ritual:a", "ritual:b"]);
  });
});

describe("strip and trigger", () => {
  it("the strip shows the last N runs, oldest left, one character per status", () => {
    const t = only(runs("CCC.CF?.C"));
    expect(t.strip).toBe("C.CF?.C");
    expect([t.runs, t.concerns, t.failed]).toEqual([9, 5, 1]);
  });

  it("K-1 complaints in the last N do not trigger", () => {
    const t = only(runs("CCCC..."));
    expect([t.complaintsLastN, t.trigger, t.tooFewRuns]).toEqual([4, false, false]);
  });

  it("exactly K complaints trigger", () => {
    const t = only(runs("CCCCC.."));
    expect([t.complaintsLastN, t.trigger]).toEqual([5, true]);
  });

  it("failed runs count toward the trigger", () => {
    const t = only(runs("CCFFC.."));
    expect([t.complaintsLastN, t.trigger]).toEqual([5, true]);
  });

  it("fewer than N runs cannot trigger, and the text says too few runs", () => {
    const d = buildDigest(runs("CCCCCC"), OPTS);
    expect([d.types[0].tooFewRuns, d.types[0].trigger]).toEqual([true, false]);
    expect(renderDigest(d)).toContain("TRIGGER no (too few runs: 6 < 7)");
  });
});

describe("unverified figures", () => {
  it("counts runs with a figure over audited runs; a figure in 2 runs is not shown, in 3 it is", () => {
    const rs = runs(".......", { has_audit: 1, unverified: "[]" });
    rs[0].unverified = '["$5 M", "12%"]';
    rs[1].unverified = '[" $5 M ", "12%"]';
    rs[2].unverified = '["$5 M", "$5 M"]';
    rs[3].has_audit = 0;
    rs[3].unverified = null;
    const t = only(rs);
    expect([t.unverified.runsWithUnverified, t.unverified.runsWithAudit]).toEqual([3, 6]);
    expect(t.unverified.recurring).toEqual([{ figure: "$5 M", runs: 3 }]);
  });
});

describe("tool profile", () => {
  const profile = (cleanTools: string[], concernTools: string[]) =>
    only([
      ...cleanTools.map((tools, i) => row({ tools, created_at: `2026-11-${String(i + 1).padStart(2, "0")} 12:00:00` })),
      ...concernTools.map((tools, i) =>
        row({ tools, status: "completed_with_concerns", created_at: `2026-11-${15 + i} 12:00:00` }),
      ),
    ]).tools;

  it("a difference of 1.0 is shown, 0.9 is not", () => {
    const shown = profile(
      ['{"exa":4}', '{"exa":4}', '{"exa":4}'],
      ['{"exa":3}', '{"exa":3}', '{"exa":3}'],
    );
    expect(shown.diffs).toEqual([{ tool: "exa", clean: 4, concern: 3 }]);
    const hidden = profile(
      Array(10).fill('{"exa":4}'),
      [...Array(9).fill('{"exa":3}'), '{"exa":4}'],
    );
    expect(hidden.diffs).toEqual([]);
  });

  it("a tool missing from a run counts as 0 calls", () => {
    const p = profile(['{"exa":1}', '{"exa":1}', '{"exa":1}'], ["{}", "{}", "{}"]);
    expect(p.diffs).toEqual([{ tool: "exa", clean: 1, concern: 0 }]);
  });

  it("the text calls it calls attempted (tool.called events), not calls made", () => {
    const text = renderDigest(
      buildDigest(
        [
          ...runs("...", { tools: '{"exa":4}' }),
          ...runs("CCC", { tools: '{"exa":1}', created_at: "2026-11-20 12:00:00" }),
        ],
        OPTS,
      ),
    );
    expect(text).toContain("  tools, mean calls attempted per run (clean n=3 / concern n=3):\n    exa 4.0 / 1.0\n");
  });

  it("a group of 2 runs is not shown", () => {
    const p = profile(['{"exa":9}', '{"exa":9}'], ['{"exa":1}', '{"exa":1}', '{"exa":1}']);
    expect(p.diffs).toEqual([]);
  });

  it("a concern group of 2 runs is not shown", () => {
    const p = profile(['{"exa":1}', '{"exa":1}', '{"exa":1}'], ['{"exa":9}', '{"exa":9}']);
    expect(p.diffs).toEqual([]);
  });

  it("failed runs are in neither group", () => {
    const t = only([...runs("...CCC", { tools: '{"exa":1}' }), ...runs("FFF", { tools: '{"exa":9}' })]).tools;
    expect([t.cleanRuns, t.concernRuns, t.diffs]).toEqual([3, 3, []]);
  });
});

describe("evidence", () => {
  it("lists the 3 most recent complaint runs, newest first, with Mexico City dates", () => {
    const rs = runs("C.CCFC.");
    rs[5].created_at = "2026-11-06 03:00:00"; // 21:00 on the 5th in Mexico City
    const t = only(rs);
    expect(t.evidence.map((e) => [e.date, e.id])).toEqual([
      ["2026-11-05", rs[5].task_id.slice(0, 8)],
      ["2026-11-05", rs[4].task_id.slice(0, 8)],
      ["2026-11-04", rs[3].task_id.slice(0, 8)],
    ]);
  });

  it("05:30 UTC is still the previous day in Mexico City (UTC-6, not UTC-5)", () => {
    const t = only([row({ status: "failed", created_at: "2026-11-10 05:30:00" })]);
    expect(t.evidence[0].date).toBe("2026-11-09");
  });

  it("prefers stored concern text over the reply tail; the tail is whitespace-collapsed, last 500 chars", () => {
    const tail = `${"x".repeat(100)}\n\n  ${"y".repeat(498)}  end`;
    const t = only([
      row({ status: "completed_with_concerns", concern_detail: "  data\n source  down ", reply_tail: "ignored" }),
      row({ status: "failed", concern_detail: "   ", reply_tail: tail }),
    ]);
    const bySource = Object.fromEntries(t.evidence.map((e) => [e.source, e.text]));
    expect(bySource.concern).toBe("data source down");
    expect(bySource.reply).toBe(`${"y".repeat(496)} end`);
    expect(bySource.reply).toHaveLength(500);
  });
});

describe("robustness and determinism", () => {
  it("malformed tools / unverified JSON does not throw and the row is still counted", () => {
    const rs = runs("C..", { has_audit: 1 });
    rs[0].tools = "{not json";
    rs[0].unverified = "[oops";
    rs[1].tools = "[1,2]";
    rs[1].unverified = '{"a":1}';
    const t = only(rs);
    expect([t.runs, t.concerns, t.unverified.runsWithAudit, t.unverified.runsWithUnverified]).toEqual([3, 1, 3, 0]);
  });

  it("shuffled input order gives byte-identical text and JSON", () => {
    const rs = [
      ...runs("CC.CCFC.CC", { ritual_id: "a", tools: '{"exa":4,"web":1}', has_audit: 1, unverified: '["9%"]' }),
      ...runs("..C..C..", { ritual_id: null, schedule_id: "s1", schedule_name: "Report", tools: '{"exa":1}' }),
      ...runs("CCCCCCC", { ritual_id: "b", reply_tail: "reply  text" }),
    ];
    rs[8].created_at = rs[7].created_at; // a "." and a "C" tie on created_at: task_id decides
    const expected = buildDigest(rs, OPTS);
    let s = 7;
    const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = 0; i < 5; i++) {
      const shuffled = [...rs];
      for (let j = shuffled.length - 1; j > 0; j--) {
        const k = Math.floor(rand() * (j + 1));
        [shuffled[j], shuffled[k]] = [shuffled[k], shuffled[j]];
      }
      const got = buildDigest(shuffled, OPTS);
      expect(renderDigest(got)).toBe(renderDigest(expected));
      expect(JSON.stringify(got)).toBe(JSON.stringify(expected));
    }
  });
});

describe("builds (rows from the task_completion_facts SQL)", () => {
  it("rows without a build field: no build anywhere, the same text and JSON as rows of the old SQL", () => {
    const rs = runs("C.CF.C", { reply_tail: "tail" });
    const d = buildDigest(rs, OPTS);
    expect(Object.keys(d.types[0]).sort()).toEqual(
      ["complaintsLastN", "concerns", "evidence", "failed", "key", "name", "runs", "strip", "tooFewRuns", "tools", "trigger", "unverified"],
    );
    expect(Object.keys(d.types[0].evidence[0]).sort()).toEqual(["date", "id", "source", "text"]);
    expect(renderDigest(d)).not.toMatch(/builds|@/);
  });

  it("distinct builds among the runs, oldest first; unknown builds are left out of the list", () => {
    const rs = runs("..C.?F", { ritual_id: "a" });
    ["bbb", "aaa", null, "bbb", "ccc", null].forEach((b, i) => (rs[i].build = b));
    const t = only([...rs].reverse());
    expect(t.builds).toEqual(["bbb", "aaa", "ccc"]);
    expect(t.evidence.map((e) => [e.id, e.build])).toEqual([
      [rs[5].task_id.slice(0, 8), null],
      [rs[2].task_id.slice(0, 8), null],
    ]);
  });

  it("text: @build after each evidence id (@- when unknown) and one builds line; none recorded when no run has one", () => {
    const rs = runs("C.F", { reply_tail: "tail", build: null });
    rs[0].build = "abc1234";
    const text = renderDigest(buildDigest(rs, OPTS));
    expect(text).toContain("  builds, oldest first: abc1234 1 run / 1 concern / 0 failed · no build 2 runs / 0 concern / 1 failed\n");
    expect(text).toContain(`    2026-11-03 ${rs[2].task_id.slice(0, 8)} @- [reply] tail\n`);
    expect(text).toContain(`    2026-11-01 ${rs[0].task_id.slice(0, 8)} @abc1234 [reply] tail\n`);
    expect(renderDigest(buildDigest(runs("C", { build: null }), OPTS))).toContain("  builds, oldest first: none recorded\n");
  });
});

describe("builds: runs, concerns and failed per build, over the strip's runs", () => {
  // 9 runs, last 7 counted: zzz (2, outside the strip), aaa . C C C, bbb F C, no build C.
  const rows = () => {
    const rs = runs("CC.CCCFCC");
    ["zzz", "zzz", "aaa", "aaa", "aaa", "aaa", "bbb", "bbb", null].forEach((b, i) => (rs[i].build = b));
    return rs;
  };

  it("counts the strip's runs per build; a run outside --last N is not counted; F is failed, not concern", () => {
    const t = only(rows());
    expect(t.strip).toBe(".CCCFCC");
    expect(t.builds).toEqual(["aaa", "bbb"]);
    expect(t.buildRuns).toEqual([
      { build: "aaa", runs: 4, concern: 3, failed: 0 },
      { build: "bbb", runs: 2, concern: 1, failed: 1 },
      { build: null, runs: 1, concern: 1, failed: 0 },
    ]);
    expect(renderDigest(buildDigest(rows(), OPTS))).toContain(
      "  builds, oldest first: aaa 4 runs / 3 concern / 0 failed · bbb 2 runs / 1 concern / 1 failed · no build 1 run / 1 concern / 0 failed\n",
    );
  });

  it("the no-build item comes last even when its runs are the oldest", () => {
    const rs = runs("C.C");
    [null, "aaa", "bbb"].forEach((b, i) => (rs[i].build = b));
    expect(only(rs).buildRuns).toEqual([
      { build: "aaa", runs: 1, concern: 0, failed: 0 },
      { build: "bbb", runs: 1, concern: 1, failed: 0 },
      { build: null, runs: 1, concern: 1, failed: 0 },
    ]);
  });

  it("no build on any counted run: none recorded in the text, the counts still in JSON", () => {
    const rs = runs("C.");
    rs.forEach((r) => (r.build = null));
    const d = buildDigest(rs, OPTS);
    expect(d.types[0].buildRuns).toEqual([{ build: null, runs: 2, concern: 1, failed: 0 }]);
    expect(renderDigest(d)).toContain("  builds, oldest first: none recorded\n");
  });

  it("over the strip's runs, concern + failed per build sums to the strip's complaints count", () => {
    const statuses = ".CF?";
    let s = 11;
    const rand = (n: number) => (s = (s * 1103515245 + 12345) % 2147483648) % n;
    for (let k = 0; k < 40; k++) {
      const rs = runs(Array.from({ length: 1 + rand(12) }, () => statuses[rand(4)]).join(""));
      rs.forEach((r) => (r.build = ["aaa", "bbb", null, ""][rand(4)]));
      const t = only(rs);
      const per = t.buildRuns ?? [];
      expect(per.reduce((n, b) => n + b.concern + b.failed, 0)).toBe(t.complaintsLastN);
      expect(per.reduce((n, b) => n + b.runs, 0)).toBe(t.strip.length);
    }
  });

  it("an empty-string build is no build: @- in the text, null in JSON, grouped under no build", () => {
    const rs = runs("CC");
    rs[0].build = "";
    rs[1].build = null;
    const d = buildDigest(rs, OPTS);
    expect(d.types[0].evidence.map((e) => e.build)).toEqual([null, null]);
    expect(d.types[0].buildRuns).toEqual([{ build: null, runs: 2, concern: 2, failed: 0 }]);
    expect(renderDigest(d)).toContain(`    2026-11-01 ${rs[0].task_id.slice(0, 8)} @- [reply] \n`);
  });

  it("a whitespace-only build is no build", () => {
    const rs = runs("C.");
    rs[0].build = " \t\n ";
    rs[1].build = "aaa";
    const t = only(rs);
    expect(t.evidence.map((e) => e.build)).toEqual([null]);
    expect(t.buildRuns).toEqual([
      { build: "aaa", runs: 1, concern: 0, failed: 0 },
      { build: null, runs: 1, concern: 1, failed: 0 },
    ]);
  });

  it("a build is whitespace-collapsed like concern text: a newline in it does not break a line", () => {
    const rs = runs("C");
    rs[0].build = " abc\n123  x ";
    const d = buildDigest(rs, OPTS);
    expect(d.types[0].evidence[0].build).toBe("abc 123 x");
    expect(d.types[0].builds).toEqual(["abc 123 x"]);
    const text = renderDigest(d);
    expect(text).toContain("  builds, oldest first: abc 123 x 1 run / 1 concern / 0 failed\n");
    expect(text).toContain(`    2026-11-01 ${rs[0].task_id.slice(0, 8)} @abc 123 x [reply] \n`);
    expect(text).not.toMatch(/abc\n/);
  });
});

describe("query", () => {
  it("only the facts SQL names task_completion_facts and selects build; neither reads its created_at", () => {
    expect(complaintsSql(false)).not.toMatch(/task_completion_facts|\bbuild\b/);
    expect(complaintsSql(true)).toContain("AS build");
    expect(complaintsSql(true)).not.toMatch(/f\.created_at/);
  });

  // The digest and verdict SQL as the ledger change found it on main: the
  // guard column is ledger-only, so these never move with it.
  const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
  it("without guards the SQL is byte-identical to main's, with or without facts", () => {
    expect([sha(complaintsSql(false)), sha(complaintsSql(true))]).toEqual([
      "cc6596190a36c7d18ff694fc865456b5f0cc19293c628b883573cb727da2c81a",
      "01c54fe396901604b1955a18c0a3f3ccc09ba6afead9850df5cdd5e9023c6c63",
    ]);
    expect([complaintsSql(false, false), complaintsSql(true, false)]).toEqual([complaintsSql(false), complaintsSql(true)]);
  });

  it("guards add exactly completed_at (in base and out) and the guard_tools column, bounded by completed_at, gate decisions as literals", () => {
    for (const facts of [false, true]) {
      const g = complaintsSql(facts, true);
      const column = g.slice(g.indexOf(",\n  (SELECT json_group_object(c.tool, c.n) FROM (\n     SELECT e.tool, max(0,"), g.indexOf(" AS guard_tools") + " AS guard_tools".length);
      expect(g.replace(", t.completed_at", "").replace(",\n  b.completed_at", "").replace(column, "")).toBe(complaintsSql(facts));
      expect(column).toContain("replace(substr(e.ts, 1, 19), 'T', ' ') <= b.completed_at");
      expect(column).toContain(`IN (${GATED_NOT_RUN.map((d) => `'${d}'`).join(", ")})`);
    }
    for (const d of GATED_NOT_RUN) expect(d).toMatch(/^[a-z_]+$/);
  });

  // Gate decisions after which the call does run: a guard counts those calls,
  // so they stay out of GATED_NOT_RUN. None today.
  const DECISIONS_THAT_RUN: string[] = [];
  it("every tool.gated decision literal in the two files that write them is in GATED_NOT_RUN or DECISIONS_THAT_RUN", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const files = ["src/inference/claude-sdk.ts", "src/tools/task-executor.ts"];
    const known = new Set([...GATED_NOT_RUN, ...DECISIONS_THAT_RUN]);
    const todo = (what: string, where: string) =>
      `a gate decision literal was ${what} in ${where}: add it to GATED_NOT_RUN in src/complaints/query.ts only if that decision means the call did not run; ` +
      "otherwise add it to the test's list of decisions that run (DECISIONS_THAT_RUN in src/complaints/digest.test.ts)" +
      (what === "removed" ? "; for a removed one, take it out of whichever list holds it" : "");
    const problems: string[] = GATED_NOT_RUN.filter((d) => DECISIONS_THAT_RUN.includes(d)).map((d) => `${d} is in both lists`);
    const seen = new Set<string>();
    for (const f of files) {
      for (const m of readFileSync(join(root, "..", f), "utf8").matchAll(/"((?:refused|queued)_[a-z_]+|confirmation_required)"/g)) {
        seen.add(m[1]);
        if (!known.has(m[1])) problems.push(`${m[1]}: ${todo("added", f)}`);
      }
    }
    for (const d of known) if (!seen.has(d)) problems.push(`${d}: ${todo("removed", files.join(" or "))}`);
    expect([...new Set(problems)]).toEqual([]);
  });
});
