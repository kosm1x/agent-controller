import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TRACE_RETENTION_DAYS } from "../observability/task-trace.js";
import type { TaskRow } from "./digest.js";
import { checkRow, LEDGER_DAYS, parseLedger, renderLedger, type Prediction } from "./ledger.js";
import { buildVerdict } from "./verdict.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const NOW = "2026-11-20T18:00:00.000Z";
const SINCE = "2026-11-15T12:00:00.000Z";
const TYPE = "ritual:pred";
const STATUS: Record<string, string> = { ".": "completed", C: "completed_with_concerns", F: "failed", X: "cancelled", R: "running" };

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

const at = (i: number): string => new Date(Date.parse(SINCE) + i * 3_600_000).toISOString().slice(0, 19).replace("T", " ");

/** One run per hour from S on; calls[i] = that run's "exa" calls (null: no trace rows). */
function runs(letters: string, calls: (number | null)[] = []): TaskRow[] {
  return [...letters].map((c, i) =>
    row({
      task_id: `t${String(i).padStart(2, "0")}`,
      status: STATUS[c],
      created_at: at(i),
      tools: calls[i] === undefined ? '{"exa":5}' : calls[i] === null ? null : JSON.stringify({ exa: calls[i] }),
    }),
  );
}

const BASE = { id: "a", type: TYPE, since: SINCE, maxComplaints: 2, runs: 7, change: "a change", baseline: "a baseline" };
const exa = (min: number, maxBelow: number) => ({ tool: "exa", min, maxBelow });
const file = (...objs: object[]): string => objs.map((o) => JSON.stringify(o)).join("\n") + "\n";
const reasons = (src: string): string[] => parseLedger(src).problems.map((p) => `${p.line}: ${p.reason}`);

function pred(o: object): Prediction {
  const { predictions, problems } = parseLedger(file({ ...BASE, ...o }));
  expect(problems).toEqual([]);
  return predictions[0];
}
const check = (o: object, rows: TaskRow[], now = NOW) => checkRow(pred(o), rows, now);
const state = (o: object, rows: TaskRow[]) => check(o, rows).state;

describe("parseLedger", () => {
  it("the committed docs/planning/predictions.jsonl parses with no problem", () => {
    const { predictions, problems } = parseLedger(readFileSync(join(REPO, "docs", "planning", "predictions.jsonl"), "utf8"));
    expect(problems).toEqual([]);
    expect(predictions.map((p) => [p.id, p.runs, p.maxComplaints, p.guards.length, p.closed])).toEqual([
      ["2", 7, 2, 2, null],
      ["9", 7, 2, 2, null],
    ]);
  });

  it("the window equals the trace retention", () => {
    expect(LEDGER_DAYS).toBe(TRACE_RETENTION_DAYS);
  });

  it("malformed line, array and trailing comma are named by line; the other lines are still reported", () => {
    const src = ["{not json", "[1,2]", '{"id":"a",}', JSON.stringify({ ...BASE, id: "d", extra: 1 }), JSON.stringify({ ...BASE, id: "e" })].join("\n");
    expect(reasons(src)).toEqual(["1: not a JSON object", "2: not a JSON object", "3: not a JSON object", '4: unknown key "extra"']);
    expect(reasons("\n")).toEqual(["1: not a JSON object"]);
    expect(parseLedger("").problems).toEqual([]);
  });

  it("unknown, missing and wrongly typed keys are refused, never defaulted", () => {
    const misspelled: Record<string, unknown> = { ...BASE, maxcomplaints: 2 };
    delete misspelled.maxComplaints;
    expect(reasons(file(misspelled))).toEqual(['1: unknown key "maxcomplaints"', '1: missing key "maxComplaints"']);
    expect(reasons(file({ ...BASE, runs: "7" }))).toEqual(['1: "runs" must be a whole number from 1 to 100']);
    expect(reasons(file({ ...BASE, maxComplaints: 1.5 }))).toEqual(['1: "maxComplaints" must be a whole number from 0 to 6 (below "runs")']);
    expect(reasons(file({ ...BASE, change: "  " }))).toEqual(['1: "change" must be non-empty text']);
    expect(reasons(file({ ...BASE, baseline: 3 }))).toEqual(['1: "baseline" must be non-empty text']);
    expect(reasons(file({ ...BASE, answer: 3 }))).toEqual(['1: "answer" must be text']);
  });

  it("bad id, duplicate id, bad type, bad since, K >= N, runs 0 and 101", () => {
    for (const id of ["", "a b", "x".repeat(41), 7]) expect(reasons(file({ ...BASE, id }))).toEqual([`1: "id" must be text matching ^[A-Za-z0-9_-]{1,40}$`]);
    expect(reasons(file(BASE, { ...BASE, type: "ritual:other" }))).toEqual(['2: duplicate id "a" (first on line 1)']);
    for (const type of ["vr", "ritual:", "job:x"]) expect(reasons(file({ ...BASE, type }))).toEqual(["1: \"type\" must be text matching ^(ritual|schedule):[A-Za-z0-9_-]+$"]);
    for (const since of ["2026-11-15", "2026-11-15T12:00:00", "2026-13-45T12:00:00Z"]) {
      expect(reasons(file({ ...BASE, since }))).toEqual(['1: "since" must be an ISO time with Z or an offset, e.g. 2026-11-20T18:00:00Z']);
    }
    expect(reasons(file({ ...BASE, maxComplaints: 7 }))).toEqual(['1: "maxComplaints" must be a whole number from 0 to 6 (below "runs")']);
    expect(reasons(file({ ...BASE, maxComplaints: 0, runs: 0 }))).toEqual(['1: "runs" must be a whole number from 1 to 100']);
    expect(reasons(file({ ...BASE, runs: 101 }))).toEqual(['1: "runs" must be a whole number from 1 to 100']);
    expect(parseLedger(file({ ...BASE, maxComplaints: 6, since: "2026-11-15T12:00:00.900Z" })).predictions[0].since).toBe(SINCE);
  });

  it("bad guards: min 0, maxBelow >= runs, unknown guard key, 0 or 4 guards, not an object", () => {
    expect(reasons(file({ ...BASE, guards: [exa(0, 0)] }))).toEqual(['1: "min" in guard 1 must be a whole number of at least 1']);
    expect(reasons(file({ ...BASE, guards: [exa(1, 0), exa(1, 7)] }))).toEqual(['1: "maxBelow" in guard 2 must be a whole number from 0 to 6 (below "runs")']);
    expect(reasons(file({ ...BASE, guards: [{ ...exa(1, 0), max: 1 }] }))).toEqual(['1: unknown key "max" in guard 1']);
    expect(reasons(file({ ...BASE, guards: [{ tool: "", min: 1 }] }))).toEqual(['1: missing key "maxBelow" in guard 1', '1: "tool" in guard 1 must be non-empty text']);
    expect(reasons(file({ ...BASE, guards: [] }))).toEqual(['1: "guards" must be an array of 1 to 3 guards']);
    expect(reasons(file({ ...BASE, guards: [exa(1, 0), exa(1, 0), exa(1, 0), exa(1, 0)] }))).toEqual(['1: "guards" must be an array of 1 to 3 guards']);
    expect(reasons(file({ ...BASE, guards: ["exa"] }))).toEqual(["1: guard 1 must be an object"]);
  });

  it("closed.state must be a closed state; closed needs its three keys", () => {
    const closed = (state: string) => ({ ...BASE, closed: { state, checkedAt: NOW, line: "x" } });
    for (const s of ["COUNTING", "CONFIRMED, guard pending", "confirmed"]) {
      expect(reasons(file(closed(s)))).toEqual(['1: "state" in "closed" must be a closed state: "REFUTED", "CONFIRMED", "CONFIRMED, guard broken", "EXPIRED"']);
    }
    for (const s of ["REFUTED", "CONFIRMED", "CONFIRMED, guard broken", "EXPIRED"]) expect(reasons(file(closed(s)))).toEqual([]);
    expect(reasons(file({ ...BASE, closed: { state: "REFUTED" } }))).toEqual(['1: missing key "checkedAt" in "closed"', '1: missing key "line" in "closed"']);
    expect(reasons(file({ ...BASE, closed: "REFUTED" }))).toEqual(['1: "closed" must be an object']);
  });

  it("two open rows on one type are refused naming both ids; one closed and one open is accepted", () => {
    const b = { ...BASE, id: "b" };
    expect(reasons(file(BASE, { ...BASE, id: "x", type: "ritual:other" }, b))).toEqual(['3: rows "a" (line 1) and "b" are both open on ritual:pred']);
    const closedA = { ...BASE, closed: { state: "REFUTED", checkedAt: NOW, line: "x" } };
    expect(reasons(file(closedA, b))).toEqual([]);
  });
});

describe("checkRow", () => {
  it("the row's numbers are one direct buildVerdict call on the same rows", () => {
    const rows = [...runs(".C.R"), row({ task_id: "other", ritual_id: "other" })];
    const c = check({ guards: [exa(1, 0)] }, rows);
    const direct = buildVerdict(rows, { now: NOW, type: TYPE, since: SINCE, maxComplaints: 2, runs: 7 });
    expect(c.verdict).toEqual(direct);
    expect(c.text).toBe(
      `a COUNTING | ritual:pred since ${SINCE}: counted 3/7, complaints 1 (limit 2), unknown 4 [.C.?]; guard exa >= 1: 0 run(s) below (limit 0) pending`,
    );
  });

  it("a type with no runs: COUNTING 0/N, guards pending, the no-run note", () => {
    const c = check({ guards: [exa(1, 0)] }, [row({ ritual_id: "other" })]);
    expect(c.text).toBe(
      `a COUNTING | ritual:pred since ${SINCE}: counted 0/7, complaints 0 (limit 2), unknown 7 []; guard exa >= 1: 0 run(s) below (limit 0) pending; no run of this type in 30 days`,
    );
    expect(c.notes).toEqual([]);
    expect(check({}, []).text).toContain("; guard: none; no run of this type in 30 days");
  });

  it("a counted run with no trace rows is below for every tool", () => {
    const c = check({ guards: [exa(1, 6), { tool: "web", min: 1, maxBelow: 6 }] }, runs(".", [null]));
    expect(c.guards.map((g) => g.below)).toEqual([1, 1]);
  });

  it("a tool that never appears can never make a guard hold", () => {
    for (const tool of ["nosuch", "constructor", "toString", "__proto__"]) {
      const full = check({ guards: [{ tool, min: 1, maxBelow: 6 }] }, runs("......."));
      expect([tool, full.guards[0].below, full.guards[0].word, full.state]).toEqual([tool, 7, "broken", "CONFIRMED, guard broken"]);
      expect([tool, check({ guards: [{ tool, min: 1, maxBelow: 6 }] }, runs("...")).guards[0].word]).toEqual([tool, "pending"]);
    }
  });

  it("J = 0: one counted run at 0 breaks it; all N at >= min holds; N-1 plus one in flight is pending", () => {
    const g = { guards: [exa(1, 0)] };
    const broken = check(g, runs(".", [0]));
    expect([broken.state, broken.guards[0].word]).toEqual(["COUNTING", "broken"]);
    expect(broken.text).toContain("guard exa >= 1: 1 run(s) below (limit 0) broken");
    expect(state(g, runs(".......", [1, 1, 1, 1, 1, 1, 1]))).toBe("CONFIRMED");
    const pending = check(g, runs("......R", [1, 1, 1, 1, 1, 1, 0]));
    expect([pending.verdict?.verdict, pending.guards[0].word, pending.state]).toEqual(["CONFIRMED", "pending", "CONFIRMED, guard pending"]);
  });

  it("min 4, maxBelow 1: one run below of 7 is CONFIRMED, two is CONFIRMED, guard broken", () => {
    const g = { guards: [exa(4, 1)] };
    expect(state(g, runs(".......", [4, 6, 3, 5, 4, 4, 6]))).toBe("CONFIRMED");
    expect(state(g, runs(".......", [4, 6, 3, 5, 3, 4, 6]))).toBe("CONFIRMED, guard broken");
    // Exactly min is not below.
    expect(check(g, runs(".......", [4, 4, 4, 4, 4, 4, 4])).guards[0].below).toBe(0);
  });

  it("two guards, one holds and one is broken: broken", () => {
    const c = check({ guards: [exa(1, 0), { tool: "web", min: 1, maxBelow: 0 }] }, runs("......."));
    expect([c.guards.map((g) => g.word), c.state]).toEqual([["holds", "broken"], "CONFIRMED, guard broken"]);
  });

  it("the guard reads only the verdict's slots: runs before since, cancelled, after the first N and in the second of now are never below", () => {
    const zero = '{"exa":0}';
    const rows = [
      row({ task_id: "before", created_at: "2026-11-15 11:59:59", tools: zero }),
      ...runs("...X...", [1, 1, 1, 0, 1, 1, 1]),
      row({ task_id: "flight", status: "running", created_at: at(8), tools: zero }),
      row({ task_id: "afterN", created_at: at(9), tools: zero }),
      row({ task_id: "inNow", created_at: "2026-11-20 18:00:00", tools: zero }),
    ];
    const c = check({ guards: [exa(1, 0)] }, rows);
    expect([c.verdict?.counted, c.verdict?.unknown, c.guards[0].below, c.guards[0].word]).toEqual([6, 1, 0, "pending"]);
    expect(check({ guards: [exa(1, 1)] }, rows).guards[0].word).toBe("holds");
  });

  it("REFUTED wins over holding guards", () => {
    const c = check({ guards: [exa(1, 0)] }, runs("CCC...."));
    expect([c.guards[0].word, c.state]).toEqual(["holds", "REFUTED"]);
  });

  it("closed but not recorded: the paste object, its line equal to the row's line", () => {
    const c = check({ guards: [exa(1, 0)] }, runs("......."));
    expect(c.state).toBe("CONFIRMED");
    expect(c.notes).toEqual([`"closed":${JSON.stringify({ state: "CONFIRMED", checkedAt: NOW, line: c.text })}`]);
    expect(JSON.parse(`{${c.notes[0]}}`).closed.line).toBe(c.text);
    expect(check({ guards: [exa(1, 0)] }, runs("......R")).notes).toEqual([]);
  });

  it("a recorded closure rechecks as agreeing at a later now", () => {
    const rows = runs(".......");
    const first = check({}, rows);
    const later = [...rows, row({ task_id: "late", status: "failed", created_at: "2026-11-21 12:00:00" })];
    const c = check({ closed: { state: first.state, checkedAt: NOW, line: first.text } }, later, "2026-11-22T00:00:00.000Z");
    expect([c.state, c.mismatch, c.notes]).toEqual(["CONFIRMED", false, [`recorded CONFIRMED at ${NOW}; recheck agrees`]]);
  });

  it("a row edited after its closure is a MISMATCH", () => {
    const rec = (s: string) => ({ closed: { state: s, checkedAt: NOW, line: "x" } });
    const raised = check({ maxComplaints: 3, ...rec("REFUTED") }, runs("CCC...."));
    expect([raised.mismatch, raised.notes]).toEqual([true, [`MISMATCH: recorded REFUTED at ${NOW}, recheck says CONFIRMED`]]);
    const tightened = check({ guards: [exa(4, 0)], ...rec("CONFIRMED") }, runs(".......", [4, 4, 3]));
    expect(tightened.notes).toEqual([`MISMATCH: recorded CONFIRMED at ${NOW}, recheck says CONFIRMED, guard broken`]);
    expect(check(rec("CONFIRMED"), runs("..")).notes).toEqual([`MISMATCH: recorded CONFIRMED at ${NOW}, recheck says COUNTING`]);
  });

  it("outside the window: unrecorded is EXPIRED with its paste object; recorded is not rechecked", () => {
    const edge = "2026-10-21T18:00:00.000Z";
    const expired = check({ since: edge }, runs("CCC"));
    expect([expired.state, expired.verdict, expired.text]).toEqual(["EXPIRED", null, `a EXPIRED | ritual:pred since ${edge}: since is outside the 30-day window`]);
    expect(expired.notes).toEqual([`"closed":${JSON.stringify({ state: "EXPIRED", checkedAt: NOW, line: expired.text })}`]);
    const recorded = check({ since: edge, closed: { state: "REFUTED", checkedAt: "2026-10-25T00:00:00.000Z", line: "x" } }, []);
    expect([recorded.state, recorded.mismatch, recorded.notes, recorded.text]).toEqual([
      "REFUTED", false, [],
      `a REFUTED | ritual:pred since ${edge}: recorded REFUTED at 2026-10-25T00:00:00.000Z; not rechecked (since is outside the 30-day window)`,
    ]);
    expect(check({ since: "2026-10-21T18:00:01Z" }, []).state).toBe("COUNTING");
  });

  it("two files differing only in answer give byte-identical output", () => {
    const out = (answer?: string) => {
      const { predictions } = parseLedger(file({ ...BASE, guards: [exa(1, 0)], ...(answer === undefined ? {} : { answer }) }));
      return renderLedger("f.jsonl", NOW, predictions.map((p) => checkRow(p, runs("......."), NOW)));
    };
    expect(out("held up, see the runs")).toBe(out());
    expect(out()).toMatch(/^Ledger f\.jsonl checked at 2026-11-20T18:00:00\.000Z over the 30 days before it: 1 row\(s\)\na CONFIRMED \| /);
  });
});
