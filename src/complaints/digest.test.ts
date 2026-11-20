import { describe, expect, it } from "vitest";
import { buildDigest, renderDigest, type DigestOptions, type TaskRow } from "./digest.js";

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
        row({ ritual_id: null, schedule_id: "s1", schedule_name: "Daily pharma" }),
        row({ ritual_id: null, schedule_id: null }),
      ],
      OPTS,
    );
    expect(d.types.map((t) => [t.key, t.name, t.runs])).toEqual([
      ["ritual:a", "a", 2],
      ["schedule:s1", "Daily pharma", 1],
    ]);
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

  it("a group of 2 runs is not shown", () => {
    const p = profile(['{"exa":9}', '{"exa":9}'], ['{"exa":1}', '{"exa":1}', '{"exa":1}']);
    expect(p.diffs).toEqual([]);
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
      ...runs("..C..C..", { ritual_id: null, schedule_id: "s1", schedule_name: "Pharma", tools: '{"exa":1}' }),
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
