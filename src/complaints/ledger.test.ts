import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TRACE_RETENTION_DAYS } from "../observability/task-trace.js";
import type { TaskRow } from "./digest.js";
import { asciiEscape, checkRow, LEDGER_DAYS, parseLedger, renderLedger, type Prediction } from "./ledger.js";
import { buildVerdict } from "./verdict.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** Gains rows and pasted closures over time: tests of it hold for every legal state, read at the real clock. */
const COMMITTED = join(REPO, "docs", "planning", "predictions.jsonl");
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

const sqlAt = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const at = (i: number): string => sqlAt(Date.parse(SINCE) + i * 3_600_000);

/** One run per hour from S on, each finished a minute later; calls[i] = that run's guard-counted "exa" calls (null: no trace rows). */
function runs(letters: string, calls: (number | null)[] = []): TaskRow[] {
  return [...letters].map((c, i) =>
    row({
      task_id: `t${String(i).padStart(2, "0")}`,
      status: STATUS[c],
      created_at: at(i),
      completed_at: c === "R" ? null : sqlAt(Date.parse(SINCE) + i * 3_600_000 + 60_000),
      guard_tools: calls[i] === undefined ? '{"exa":5}' : calls[i] === null ? null : JSON.stringify({ exa: calls[i] }),
    }),
  );
}

const BASE = { id: "a", type: TYPE, since: SINCE, maxComplaints: 2, runs: 7, change: "a change", baseline: "a baseline" };
const ANSWER_NOTE = `record it with the operator's answer to "do the outputs since the change read worse, the same or better": "answer", text whose last word is worse, same or better`;
const exa = (min: number, maxBelow: number) => ({ tool: "exa", min, maxBelow });
const file = (...objs: object[]): string => objs.map((o) => JSON.stringify(o)).join("\n") + "\n";
const reasons = (src: string): string[] => parseLedger(src, NOW).problems.map((p) => `${p.line}: ${p.reason}`);

function pred(o: object): Prediction {
  const { predictions, problems } = parseLedger(file({ ...BASE, ...o }), NOW);
  expect(problems).toEqual([]);
  return predictions[0];
}
const check = (o: object, rows: TaskRow[], now = NOW, replay = false) => checkRow(pred(o), rows, now, replay);
const state = (o: object, rows: TaskRow[]) => check(o, rows).state;

describe("parseLedger", () => {
  it("the committed docs/planning/predictions.jsonl parses with no problem at the real clock", () => {
    expect(parseLedger(readFileSync(COMMITTED, "utf8"), new Date().toISOString()).problems).toEqual([]);
  });

  it("the committed file stays clean when a row is appended or its first started open row's closure is pasted", () => {
    // Rows are written and closures printed at the real time `real`; `clock` is the time the file is parsed at.
    const real = Date.now();
    const clock = new Date(real).toISOString();
    const lines = readFileSync(COMMITTED, "utf8").trimEnd().split("\n");
    const { predictions } = parseLedger(`${lines.join("\n")}\n`, clock);
    // (i) A new open row on a type no committed row uses, committed before its window opens.
    const added = { ...BASE, id: "lifecycle-new", type: "ritual:lifecycle-new", since: new Date(real + 300_000).toISOString(), guards: [exa(1, 0)] };
    expect(predictions.map((p) => p.id)).not.toContain(added.id);
    expect(predictions.map((p) => p.type)).not.toContain(added.type);
    expect(parseLedger(`${[...lines, JSON.stringify(added)].join("\n")}\n`, clock).problems).toEqual([]);
    // (ii) A closure pasted into the first row with none whose since is not after the real time, at the
    // latest time the parser allows it: not after the real time and under 30 days after since.
    const open = predictions.find((p) => p.closed === null && Date.parse(p.since) <= real);
    if (!open) return console.warn("lifecycle (ii) skipped: no committed row has started without a closure");
    const at = Math.min(real, Date.parse(open.since) + LEDGER_DAYS * 86_400_000 - 1000);
    const closed = { state: "CONFIRMED", checkedAt: new Date(at).toISOString(), line: "pasted" };
    const i = open.line - 1;
    lines[i] = `${lines[i].slice(0, -1)},"closed":${JSON.stringify(closed)}}`;
    const pasted = parseLedger(`${lines.join("\n")}\n`, clock);
    expect(pasted.problems).toEqual([]);
    expect(pasted.predictions.find((p) => p.id === open.id)?.closed).toEqual(closed);
  });

  it("the window equals the trace retention", () => {
    expect(LEDGER_DAYS).toBe(TRACE_RETENTION_DAYS);
  });

  it("malformed line, array and trailing comma are named by line; the other lines are still reported", () => {
    const src = ["{not json", "[1,2]", '{"id":"a",}', JSON.stringify({ ...BASE, id: "d", extra: 1 }), JSON.stringify({ ...BASE, id: "e" })].join("\n");
    expect(reasons(src)).toEqual(["1: not a JSON object", "2: not a JSON object", "3: not a JSON object", '4: unknown key "extra"']);
    expect(reasons("\n")).toEqual(["1: not a JSON object"]);
    expect(parseLedger("", NOW).problems).toEqual([]);
  });

  it("unknown, missing and wrongly typed keys are refused, never defaulted", () => {
    const misspelled: Record<string, unknown> = { ...BASE, maxcomplaints: 2 };
    delete misspelled.maxComplaints;
    expect(reasons(file(misspelled))).toEqual(['1: unknown key "maxcomplaints"', '1: missing key "maxComplaints"']);
    expect(reasons(file({ ...BASE, runs: "7" }))).toEqual(['1: "runs" must be a whole number from 1 to 100']);
    expect(reasons(file({ ...BASE, maxComplaints: 1.5 }))).toEqual(['1: "maxComplaints" must be a whole number from 0 to 6 (below "runs")']);
    expect(reasons(file({ ...BASE, change: "  " }))).toEqual(['1: "change" must be non-empty text']);
    expect(reasons(file({ ...BASE, baseline: 3 }))).toEqual(['1: "baseline" must be non-empty text']);
    expect(reasons(file({ ...BASE, answer: 3 }))).toEqual(['1: "answer" must be text whose last word (after its last space) is "worse", "same" or "better"']);
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
    expect(parseLedger(file({ ...BASE, maxComplaints: 6, since: "2026-11-15T12:00:00.900Z" }), NOW).predictions[0].since).toBe(SINCE);
  });

  it("bad guards: min 0, maxBelow >= runs, unknown guard key, 0 or 4 guards, not an object", () => {
    expect(reasons(file({ ...BASE, guards: [exa(0, 0)] }))).toEqual(['1: "min" in guard 1 must be a whole number of at least 1']);
    expect(reasons(file({ ...BASE, guards: [exa(1, 0), exa(1, 7)] }))).toEqual(['1: "maxBelow" in guard 2 must be a whole number from 0 to 6 (below "runs")']);
    expect(reasons(file({ ...BASE, guards: [{ ...exa(1, 0), max: 1 }] }))).toEqual(['1: unknown key "max" in guard 1']);
    expect(reasons(file({ ...BASE, guards: [{ tool: "", min: 1 }] }))).toEqual(['1: missing key "maxBelow" in guard 1', '1: "tool" in guard 1 must be text matching ^[A-Za-z0-9_.:-]{1,64}$']);
    expect(reasons(file({ ...BASE, guards: [] }))).toEqual(['1: "guards" must be an array of 1 to 3 guards']);
    expect(reasons(file({ ...BASE, guards: [exa(1, 0), exa(1, 0), exa(1, 0), exa(1, 0)] }))).toEqual(['1: "guards" must be an array of 1 to 3 guards']);
    expect(reasons(file({ ...BASE, guards: ["exa"] }))).toEqual(["1: guard 1 must be an object"]);
  });

  it("closed.state must be a closed state; closed needs its three keys", () => {
    const closed = (state: string) => ({ ...BASE, closed: { state, checkedAt: NOW, line: "x" } });
    for (const s of ["COUNTING", "CONFIRMED, guard pending", "confirmed"]) {
      expect(reasons(file(closed(s)))).toEqual(['1: "state" in "closed" must be a closed state: "REFUTED", "CONFIRMED", "CONFIRMED, guard broken", "EXPIRED"']);
    }
    for (const s of ["REFUTED", "CONFIRMED", "CONFIRMED, guard broken"]) expect(reasons(file(closed(s)))).toEqual([]);
    expect(reasons(file({ ...closed("EXPIRED"), since: "2026-10-01T00:00:00Z" }))).toEqual([]);
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
      `a COUNTING | ritual:pred since ${SINCE}: counted 3/7, complaints 1 (limit 2), unknown 4 [.C.?]; guard exa >= 1 calls: 0 run(s) below (limit 0) pending`,
    );
  });

  it("a type with no runs: COUNTING 0/N, guards pending, the no-run note", () => {
    const c = check({ guards: [exa(1, 0)] }, [row({ ritual_id: "other" })]);
    expect(c.text).toBe(
      `a COUNTING | ritual:pred since ${SINCE}: counted 0/7, complaints 0 (limit 2), unknown 7 []; guard exa >= 1 calls: 0 run(s) below (limit 0) pending; no run of this type in 30 days`,
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
    expect(broken.text).toContain("guard exa >= 1 calls: 1 run(s) below (limit 0) broken");
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
      row({ task_id: "before", created_at: "2026-11-15 11:59:59", guard_tools: zero }),
      ...runs("...X...", [1, 1, 1, 0, 1, 1, 1]),
      row({ task_id: "flight", status: "running", created_at: at(8), guard_tools: zero }),
      row({ task_id: "afterN", created_at: at(9), guard_tools: zero }),
      row({ task_id: "inNow", created_at: "2026-11-20 18:00:00", guard_tools: zero }),
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
    expect(c.notes).toEqual([`"closed":${JSON.stringify({ state: "CONFIRMED", checkedAt: NOW, line: c.text })}`, ANSWER_NOTE]);
    expect(JSON.parse(`{${c.notes[0]}}`).closed.line).toBe(c.text);
    expect(check({ guards: [exa(1, 0)] }, runs("......R")).notes).toEqual([]);
  });

  it("a recorded closure rechecks as agreeing at a later now", () => {
    const rows = runs(".......");
    const first = check({}, rows);
    const later = [...rows, row({ task_id: "late", status: "failed", created_at: "2026-11-21 12:00:00" })];
    const c = check({ closed: { state: first.state, checkedAt: NOW, line: first.text } }, later, "2026-11-22T00:00:00.000Z");
    expect([c.state, c.mismatch, c.notes]).toEqual(["CONFIRMED", false, [`recorded CONFIRMED at ${NOW}; recheck agrees; operator's read: OWED`]]);
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
      `a REFUTED | ritual:pred since ${edge}: recorded REFUTED at 2026-10-25T00:00:00.000Z; not rechecked (since is outside the 30-day window); operator's read: OWED`,
    ]);
    expect(check({ since: "2026-10-21T18:00:01Z" }, []).state).toBe("COUNTING");
  });

  it("two files differing only in answer give byte-identical output while the row is still open and cannot close", () => {
    const out = (answer?: string) => {
      const { predictions } = parseLedger(file({ ...BASE, guards: [exa(1, 0)], ...(answer === undefined ? {} : { answer }) }), NOW);
      return renderLedger("f.jsonl", NOW, predictions.map((p) => checkRow(p, runs("..."), NOW, false)), false);
    };
    expect(out("held up, see the runs: same")).toBe(out());
    expect(out()).toMatch(/^Ledger f\.jsonl checked at 2026-11-20T18:00:00\.000Z over the 30 days before it: 1 row\(s\); a guard counts a tool's calls with no did-not-run gate row \(errored calls and some refusals included\)\na COUNTING \| /);
  });
});

describe("audit folds", () => {
  const closedAt = (checkedAt: string, state = "CONFIRMED", line = "x") => ({ closed: { state, checkedAt, line } });

  it("missing baseline is refused (and change)", () => {
    const noBaseline: Record<string, unknown> = { ...BASE };
    delete noBaseline.baseline;
    expect(reasons(file(noBaseline))).toEqual(['1: missing key "baseline"']);
    const noChange: Record<string, unknown> = { ...BASE };
    delete noChange.change;
    expect(reasons(file(noChange))).toEqual(['1: missing key "change"']);
  });

  it("problems come out in line order: a two-open-rows problem before a later line's own problem", () => {
    const src = file(BASE, { ...BASE, id: "b" }, { ...BASE, id: "c", type: "ritual:other", runs: 0 });
    expect(reasons(src)).toEqual(['2: rows "a" (line 1) and "b" are both open on ritual:pred', '3: "runs" must be a whole number from 1 to 100']);
  });

  it("each line must be canonical: duplicate keys, spaces, padding and 7.0 are refused, without echoing the line", () => {
    const canon = (o: object) => JSON.stringify(o);
    const ok = canon(BASE);
    const cases: [string, string][] = [
      [ok.replace('"id":"a"', '"id":"z","id":"a"'), ok],
      [ok.replace('"runs":7', '"runs":7.0'), ok],
      [`${ok} `, ok],
      [` ${ok}`, ok],
      [`${ok}\r`, ok],
      [ok.replace('{"id"', '{ "id"'), ok],
      [ok.replace(',"type"', ', "type"'), ok],
    ];
    for (const [line] of cases) expect(reasons(`${line}\n`)).toEqual(["1: not in canonical form (one JSON object, no spaces, no duplicate keys, as JSON.stringify writes it)"]);
    const g = canon({ ...BASE, guards: [exa(1, 0)] });
    const gDup = g.replace('"min":1', '"min":3,"min":1');
    expect(reasons(`${gDup}\n`)).toEqual(["1: not in canonical form (one JSON object, no spaces, no duplicate keys, as JSON.stringify writes it)"]);
    const c1 = canon({ ...BASE, ...closedAt("2026-11-16T00:00:00.000Z") });
    const twoClosed = c1.replace('"closed":', '"closed":{"state":"REFUTED","checkedAt":"2026-11-16T00:00:00.000Z","line":"y"},"closed":');
    expect(reasons(`${twoClosed}\n`)).toEqual(["1: not in canonical form (one JSON object, no spaces, no duplicate keys, as JSON.stringify writes it)"]);
  });

  it("the committed rows are canonical, and a pasted closure keeps the row canonical and rechecks as agreeing", () => {
    const lines = readFileSync(COMMITTED, "utf8").trimEnd().split("\n");
    for (const l of lines) expect(JSON.stringify(JSON.parse(l))).toBe(l);
    const rows = runs(".......");
    const raw = JSON.stringify({ ...BASE, guards: [exa(1, 0)] });
    const c = checkRow(parseLedger(`${raw}\n`, NOW).predictions[0], rows, NOW, false);
    expect(c.notes).toHaveLength(2);
    const pasted = `${raw.slice(0, -1)},${c.notes[0]}}`;
    const later = "2026-11-21T00:00:00.000Z";
    const { predictions, problems } = parseLedger(`${pasted}\n`, later);
    expect(problems).toEqual([]);
    expect(checkRow(predictions[0], rows, later, false).notes).toEqual([`recorded CONFIRMED at ${NOW}; recheck agrees; operator's read: OWED`]);
    // Every paste offered (expired rows too) is canonical once inserted.
    const old = JSON.stringify({ ...BASE, since: "2026-10-01T00:00:00Z" });
    const e = checkRow(parseLedger(`${old}\n`, NOW).predictions[0], [], NOW, false);
    expect(parseLedger(`${old.slice(0, -1)},${e.notes[0]}}\n`, NOW).problems).toEqual([]);
  });

  it("closed.checkedAt: the ISO pattern, at or after since, under 30 days after it, not after the check", () => {
    const must = '1: "checkedAt" in "closed" must be an ISO time at or after "since" and not later than the current time: less than 30 days after "since", or at least that for EXPIRED';
    for (const t of ["2026-11-16", "yesterday", "2026-11-15T11:59:59Z", "2026-12-15T12:00:00Z", "2026-11-20T18:00:01Z"]) {
      expect([t, reasons(file({ ...BASE, ...closedAt(t) }))]).toEqual([t, [must]]);
    }
    for (const t of ["2026-11-15T12:00:00Z", "2026-11-20T18:00:00Z", "2026-11-20T12:00:00-06:00"]) {
      expect([t, reasons(file({ ...BASE, ...closedAt(t) }))]).toEqual([t, []]);
    }
    // Just under 30 days after S is accepted when the check is later still;
    // EXPIRED is the other way round: only at or after S + 30 days.
    const late = "2026-12-20T00:00:00Z";
    expect(parseLedger(file({ ...BASE, ...closedAt("2026-12-15T11:59:59Z") }), late).problems).toEqual([]);
    expect(parseLedger(file({ ...BASE, ...closedAt("2026-12-15T12:00:00Z", "EXPIRED") }), late).problems).toEqual([]);
    expect(reasons(file({ ...BASE, ...closedAt("2026-11-16T00:00:00Z", "EXPIRED") }))).toEqual([must]);
  });

  it("no printed field can carry a line break; change and baseline are never printed, answer only by its last word", () => {
    expect(reasons(file({ ...BASE, id: "a\nb" }))).toEqual(['1: "id" must be text matching ^[A-Za-z0-9_-]{1,40}$']);
    expect(reasons(file({ ...BASE, type: "ritual:a\nb CONFIRMED" }))).toEqual(['1: "type" must be text matching ^(ritual|schedule):[A-Za-z0-9_-]+$']);
    expect(reasons(file({ ...BASE, type: "ritual:a\n" }))).toEqual(['1: "type" must be text matching ^(ritual|schedule):[A-Za-z0-9_-]+$']);
    for (const tool of ["exa\nb CONFIRMED |", "exa\n", "a b", "x".repeat(65), ""]) {
      expect(reasons(file({ ...BASE, guards: [{ tool, min: 1, maxBelow: 0 }] }))).toEqual(['1: "tool" in guard 1 must be text matching ^[A-Za-z0-9_.:-]{1,64}$']);
    }
    for (const tool of ["web_search", "mcp__x.y:z-1", "x".repeat(64)]) expect(reasons(file({ ...BASE, guards: [{ tool, min: 1, maxBelow: 0 }] }))).toEqual([]);
    expect(reasons(file({ ...BASE, ...closedAt("2026-11-16T00:00:00Z", "CONFIRMED", "one\ntwo") }))).toEqual(['1: "line" in "closed" must be single-line text']);
    expect(reasons(file({ ...BASE, ...closedAt("2026-11-16T00:00:00Z", "CONFIRMED", "one two") }))).toEqual(['1: "line" in "closed" must be single-line text']);
    expect(reasons(file({ ...BASE, ...closedAt("2026-11-16T00:00:00Z\n") }))).toHaveLength(1);
    const forged = "x\nb CONFIRMED | forged";
    const { predictions } = parseLedger(file({ ...BASE, change: forged, baseline: forged, answer: `${forged} better` }), NOW);
    const out = renderLedger("f", NOW, predictions.map((p) => checkRow(p, runs("......."), NOW, false)), false);
    expect(out).not.toContain("forged");
    expect(out.split("\n")).toHaveLength(4);
  });

  it("one broken guard and one pending guard: CONFIRMED, guard broken", () => {
    const c = check({ guards: [{ tool: "web", min: 1, maxBelow: 0 }, exa(1, 0)] }, runs("......R"));
    expect([c.verdict?.verdict, c.guards.map((g) => g.word), c.state]).toEqual(["CONFIRMED", ["broken", "pending"], "CONFIRMED, guard broken"]);
    expect(check({ guards: [exa(1, 0), { tool: "web", min: 1, maxBelow: 0 }] }, runs("......R")).state).toBe("CONFIRMED, guard broken");
  });

  it("the guard reads guard_tools (calls with no did-not-run gate row), never the digest's tools column", () => {
    const rows = runs(".......").map((r) => ({ ...r, tools: '{"exa":9}', guard_tools: '{"exa":0}' }));
    expect(check({ guards: [exa(1, 6)] }, rows).guards[0].below).toBe(7);
  });

  it("replay: a recorded closure is not rechecked and cannot mismatch; no closure is offered; the header says so", () => {
    const rec = check({ maxComplaints: 3, ...closedAt("2026-11-16T00:00:00.000Z", "REFUTED") }, runs("CCC...."), NOW, true);
    expect([rec.state, rec.mismatch, rec.notes]).toEqual(["CONFIRMED", false, ["recorded REFUTED at 2026-11-16T00:00:00.000Z; not rechecked (replay); operator's read: OWED"]]);
    expect(check({}, runs("......."), NOW, true).notes).toEqual([]);
    expect(check({ since: "2026-10-01T00:00:00Z" }, [], NOW, true).notes).toEqual([]);
    const out = renderLedger("f", NOW, [rec], true);
    expect(out.split("\n")[0]).toBe(
      "Ledger f replayed at 2026-11-20T18:00:00.000Z (a replay, not a recheck) over the 30 days before it: 1 row(s); a guard counts a tool's calls with no did-not-run gate row (errored calls and some refusals included)",
    );
  });

  it("a guard judges only runs finished in a second strictly before the check's; one finished in it is pending", () => {
    // N=2, K=0, guard exa >= 1 maxBelow 0; both runs clean with one exa call; t01 finished at F.
    const rows = runs("..", [1, 1]);
    const F = rows[1].completed_at as string;
    const iso = (ms: number): string => new Date(Date.parse(`${F.replace(" ", "T")}Z`) + ms).toISOString();
    const o = { runs: 2, maxComplaints: 0, guards: [exa(1, 0)] };
    for (const now of [iso(0), iso(900)]) {
      const c = check(o, rows, now);
      expect([c.state, c.guards[0].word, c.guards[0].unsettled, c.notes]).toEqual(["CONFIRMED, guard pending", "pending", 1, []]);
      expect(c.text).toMatch(/; 1 counted run\(s\) not yet judged$/);
    }
    expect(check(o, rows, iso(1000)).state).toBe("CONFIRMED");
    // A gate row written at F.900 (t01 now at 0 calls) lands before the F+1 check: every later check agrees.
    const landed = rows.map((r, i) => (i === 1 ? { ...r, guard_tools: '{"exa":0}' } : r));
    expect([iso(1000), iso(60_000), iso(86_400_000)].map((now) => check(o, landed, now).text)).toEqual(
      Array(3).fill(`a CONFIRMED, guard broken | ritual:pred since ${SINCE}: counted 2/2, complaints 0 (limit 0), unknown 0 [..]; guard exa >= 1 calls: 1 run(s) below (limit 0) broken`),
    );
    // No completed_at: never judged.
    const open = rows.map((r, i) => (i === 1 ? { ...r, completed_at: null } : r));
    expect(check(o, open, iso(86_400_000)).guards.map((g) => [g.word, g.unsettled])).toEqual([["pending", 1]]);
  });

  it("no message or printed line carries raw file text: NEL, LS, RLO and DEL in a key name or any field", () => {
    const printable = /^[\x20-\x7e\n]*$/;
    const ok = { state: "CONFIRMED", checkedAt: "2026-11-16T00:00:00Z", line: "x" };
    for (const ch of ["\u0085", "\u2028", "\u202e", "\u007f"]) {
      const v = `a${ch}b`;
      const esc = `a\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}b`;
      expect(reasons(file({ ...BASE, [v]: 1 }))).toEqual([`1: unknown key "${esc}"`]);
      expect(reasons(file({ ...BASE, guards: [{ ...exa(1, 0), [v]: 1 }] }))).toEqual([`1: unknown key "${esc}" in guard 1`]);
      expect(reasons(file({ ...BASE, closed: { ...ok, [v]: 1 } }))).toEqual([`1: unknown key "${esc}" in "closed"`]);
      if (ch === "\u0085" || ch === "\u2028") expect(reasons(file({ ...BASE, closed: { ...ok, line: v } }))).toEqual(['1: "line" in "closed" must be single-line text']);
      const variants: object[] = [
        { ...BASE, id: v },
        { ...BASE, type: `ritual:${v}` },
        { ...BASE, since: `2026-11-15T12:00:00Z${v}` },
        { ...BASE, change: v },
        { ...BASE, baseline: v },
        { ...BASE, answer: v },
        { ...BASE, guards: [{ tool: v, min: 1, maxBelow: 0 }] },
        { ...BASE, closed: { ...ok, state: v } },
        { ...BASE, closed: { ...ok, checkedAt: `2026-11-16T00:00:00Z${v}` } },
        { ...BASE, closed: { ...ok, line: v } },
      ];
      for (const o of variants) {
        for (const src of [file(o), ` ${file(o)}`]) {
          const { predictions, problems } = parseLedger(src, NOW);
          expect(predictions.length + problems.length).toBeGreaterThan(0);
          for (const p of problems) expect(p.reason).toMatch(printable);
          expect(renderLedger("f", NOW, predictions.map((p) => checkRow(p, runs("......."), NOW, false)), false)).toMatch(printable);
        }
      }
    }
  });

  it("replay: a closure after the replayed time but not after the real clock is marked, not refused; at the clock it is refused", () => {
    const o = { ...BASE, maxComplaints: 3, ...closedAt("2026-11-20T12:00:00.000Z") };
    const early = "2026-11-18T00:00:00.000Z";
    expect(parseLedger(file(o), early).problems.map((p) => p.reason)).toEqual([
      '"checkedAt" in "closed" must be an ISO time at or after "since" and not later than the current time: less than 30 days after "since", or at least that for EXPIRED',
    ]);
    // In a replay the CLI passes the real clock (here NOW) as the latest time a closure may carry.
    const { predictions, problems } = parseLedger(file(o), NOW);
    expect(problems).toEqual([]);
    const c = checkRow(predictions[0], runs("......."), early, true);
    expect([c.mismatch, c.notes]).toEqual([false, ["recorded CONFIRMED at 2026-11-20T12:00:00.000Z, after this time; not rechecked (replay); operator's read: OWED"]]);
    // Still refused in a replay: before since, or 30 days or more after it.
    expect(parseLedger(file({ ...o, ...closedAt("2026-11-15T11:00:00Z") }), NOW).problems).toHaveLength(1);
    expect(parseLedger(file({ ...o, ...closedAt("2026-12-15T12:00:00Z") }), NOW).problems).toHaveLength(1);
    // Later than the real clock: refused in a replay too.
    expect(parseLedger(file({ ...o, ...closedAt("2026-11-20T18:00:01Z") }), NOW).problems).toHaveLength(1);
  });

  it("the file name prints ASCII-escaped in the header; a printable ASCII name exactly as given", () => {
    const out = renderLedger("f\n\u001b[2Jb CONFIRMED | x", NOW, [], false);
    expect(out).toBe(`Ledger f\\u000a\\u001b[2Jb CONFIRMED | x checked at ${NOW} over the 30 days before it: 0 row(s); a guard counts a tool's calls with no did-not-run gate row (errored calls and some refusals included)\n`);
    expect(renderLedger("docs/planning/predictions.jsonl", NOW, [], false).split(" ")[1]).toBe("docs/planning/predictions.jsonl");
    expect(asciiEscape(' !~az09"\\')).toBe(' !~az09"\\');
  });
});

describe("a guard naming a set of equivalent tools", () => {
  const set = (tools: unknown, min = 1, maxBelow = 0) => ({ tools, min, maxBelow });
  /** Seven clean runs; calls[i] = that run's guard_tools object. */
  const seven = (calls: Record<string, number>[]): TaskRow[] => runs(".......").map((r, i) => ({ ...r, guard_tools: JSON.stringify(calls[i]) }));

  it("a run's count is the sum over the set; printed with the names joined by |", () => {
    const c = check({ guards: [set(["file_read", "jarvis_file_read"])] }, seven([{ jarvis_file_read: 1 }, { file_read: 1 }, { file_read: 1, jarvis_file_read: 2 }, { jarvis_file_read: 1 }, { file_read: 3 }, { jarvis_file_read: 1 }, { file_read: 1 }]));
    expect([c.guards[0].below, c.guards[0].word, c.state]).toEqual([0, "holds", "CONFIRMED"]);
    expect(c.text).toBe(
      `a CONFIRMED | ritual:pred since ${SINCE}: counted 7/7, complaints 0 (limit 2), unknown 0 [.......]; guard file_read|jarvis_file_read >= 1 calls: 0 run(s) below (limit 0) holds`,
    );
    // The same runs under the single-tool guard: the runs that used only the other tool are below.
    expect(check({ guards: [{ tool: "jarvis_file_read", min: 1, maxBelow: 0 }] }, seven([{ jarvis_file_read: 1 }, { file_read: 1 }, { file_read: 1, jarvis_file_read: 2 }, { jarvis_file_read: 1 }, { file_read: 3 }, { jarvis_file_read: 1 }, { file_read: 1 }])).guards[0].below).toBe(3);
  });

  it("each tool alone below min, the sum not: not below; one short of min in sum: below", () => {
    const g = { guards: [set(["exa", "web"], 4, 0)] };
    const each = Array.from({ length: 7 }, () => ({ exa: 2, web: 2 }));
    expect(check(g, seven(each)).guards[0].below).toBe(0);
    expect(check({ guards: [exa(4, 0)] }, seven(each)).guards[0].below).toBe(7);
    const short = check(g, seven([{ exa: 2, web: 1 }, ...each.slice(1)]));
    expect([short.guards[0].below, short.guards[0].word]).toEqual([1, "broken"]);
    // A name the runs never use adds nothing; a prototype member name is still 0 calls.
    expect(check({ guards: [set(["constructor", "exa", "nosuch"], 3, 0)] }, seven(each)).guards[0].below).toBe(7);
  });

  it("three and four names are accepted; the did-not-run and no-trace rules are the single tool's", () => {
    expect(reasons(file({ ...BASE, guards: [set(["a", "b", "c"]), set(["a", "b", "c", "d"])] }))).toEqual([]);
    expect(check({ guards: [set(["exa", "web"], 1, 6)] }, runs(".", [null])).guards[0].below).toBe(1);
  });

  it("a single-tool guard prints exactly as before", () => {
    expect(check({ guards: [exa(1, 0)] }, runs("...")).text).toBe(
      `a COUNTING | ritual:pred since ${SINCE}: counted 3/7, complaints 0 (limit 2), unknown 4 [...]; guard exa >= 1 calls: 0 run(s) below (limit 0) pending`,
    );
  });

  it("a malformed set: 1 or 5 names, a duplicate, unsorted, a bad name, not an array; both or neither of tool and tools", () => {
    const must = '1: "tools" in guard 1 must be an array of 2 to 4 tool names, each text matching ^[A-Za-z0-9_.:-]{1,64}$, distinct and in ascending order';
    for (const tools of [["a"], [], ["a", "b", "c", "d", "e"], ["a", "a"], ["b", "a"], ["a", "c", "b"], ["B", "a", "a"], ["a", "b c"], ["a", "b\n"], ["a", 7], "a|b", null]) {
      expect([tools, reasons(file({ ...BASE, guards: [set(tools)] }))]).toEqual([tools, [must]]);
    }
    // Ascending is by code unit: upper case sorts before lower case.
    expect(reasons(file({ ...BASE, guards: [set(["B", "a"])] }))).toEqual([]);
    const one = '1: guard 1 must have exactly one of "tool" and "tools"';
    expect(reasons(file({ ...BASE, guards: [{ tool: "exa", tools: ["a", "b"], min: 1, maxBelow: 0 }] }))).toEqual([one]);
    expect(reasons(file({ ...BASE, guards: [{ min: 1, maxBelow: 0 }] }))).toEqual([one]);
    expect(reasons(file({ ...BASE, guards: [exa(1, 0), { tools: ["a b"], min: 1 }] }))).toEqual([
      '1: missing key "maxBelow" in guard 2',
      '1: "tools" in guard 2 must be an array of 2 to 4 tool names, each text matching ^[A-Za-z0-9_.:-]{1,64}$, distinct and in ascending order',
    ]);
  });
});

describe("the operator's read: the last word of answer, beside a recorded closure", () => {
  const LATER = "2026-11-22T00:00:00.000Z";
  const rec = (state: string, answer?: string, over: object = {}) => ({ ...over, closed: { state, checkedAt: NOW, line: "x" }, ...(answer === undefined ? {} : { answer }) });
  const BAD = '1: "answer" must be text whose last word (after its last space) is "worse", "same" or "better"';
  /** The recorded line of a closure that rechecks as agreeing at LATER. */
  const agrees = (state: string, rows: TaskRow[], answer?: string, over: object = {}) => check(rec(state, answer, over), rows, LATER).notes;

  it("each of the three words is the read; text before the last space is free; no space: the whole text", () => {
    for (const word of ["worse", "same", "better"]) {
      expect(pred({ answer: `asked whether the outputs read worse, the same or better: ${word}` }).read).toBe(word);
      expect(pred({ answer: word }).read).toBe(word);
    }
    expect(pred({}).read).toBeNull();
  });

  it("any other ending is a file problem, quoting nothing from the answer", () => {
    for (const answer of ["", " ", "better.", "Better", "better ", "worse\tbetter x", "it read BETTER", "x better\n", "x\u00a0better", "best", "OWED"]) {
      expect([answer, reasons(file({ ...BASE, answer }))]).toEqual([answer, [BAD]]);
    }
    expect(reasons(file({ ...BASE, answer: "x\nbetter" }))).toEqual([BAD]);
    expect(reasons(file({ ...BASE, answer: "x\n better" }))).toEqual([]);
  });

  it("an open row may carry an answer (accepted, as before); nothing of it is printed", () => {
    const rows = runs("...");
    expect(check({ answer: "early: worse" }, rows)).toEqual({ ...check({}, rows), prediction: pred({ answer: "early: worse" }) });
  });

  it("OWED without an answer, on the agreeing, replay and outside-the-window lines; never an error", () => {
    expect(agrees("CONFIRMED", runs("......."))).toEqual([`recorded CONFIRMED at ${NOW}; recheck agrees; operator's read: OWED`]);
    const replay = check(rec("CONFIRMED"), runs("......."), NOW, true);
    expect([replay.mismatch, replay.notes]).toEqual([false, [`recorded CONFIRMED at ${NOW}; not rechecked (replay); operator's read: OWED`]]);
    const outside = (answer?: string) => check({ since: "2026-10-21T18:00:00Z", ...rec("REFUTED", answer), closed: { state: "REFUTED", checkedAt: "2026-10-25T00:00:00.000Z", line: "x" } }, []);
    const head = "a REFUTED | ritual:pred since 2026-10-21T18:00:00.000Z: recorded REFUTED at 2026-10-25T00:00:00.000Z; not rechecked (since is outside the 30-day window)";
    expect([outside().mismatch, outside().notes, outside().text]).toEqual([false, [], `${head}; operator's read: OWED`]);
    expect(outside("a: better").text).toBe(`${head}; operator's read: better (differs from the count)`);
  });

  it("differs from the count: CONFIRMED (any) read worse, REFUTED read better; every other pairing does not", () => {
    const confirmed = runs(".......");
    const refuted = runs("CCC....");
    const line = (state: string, word: string) => `recorded ${state} at ${NOW}; recheck agrees; operator's read: ${word}`;
    expect(agrees("REFUTED", refuted, "a: better")).toEqual([`${line("REFUTED", "better")} (differs from the count)`]);
    expect(agrees("CONFIRMED", confirmed, "a: worse")).toEqual([`${line("CONFIRMED", "worse")} (differs from the count)`]);
    const broken = { guards: [{ tool: "web", min: 1, maxBelow: 0 }] };
    expect(agrees("CONFIRMED, guard broken", confirmed, "a: worse", broken)).toEqual([`${line("CONFIRMED, guard broken", "worse")} (differs from the count)`]);
    expect(agrees("REFUTED", refuted, "a: worse")).toEqual([line("REFUTED", "worse")]);
    expect(agrees("REFUTED", refuted, "a: same")).toEqual([line("REFUTED", "same")]);
    expect(agrees("CONFIRMED", confirmed, "a: better")).toEqual([line("CONFIRMED", "better")]);
    expect(agrees("CONFIRMED", confirmed, "a: same")).toEqual([line("CONFIRMED", "same")]);
    expect(agrees("CONFIRMED, guard broken", confirmed, "a: better", broken)).toEqual([line("CONFIRMED, guard broken", "better")]);
    // In a replay the same pairing rule holds.
    expect(check(rec("REFUTED", "a: better"), refuted, NOW, true).notes).toEqual([`recorded REFUTED at ${NOW}; not rechecked (replay); operator's read: better (differs from the count)`]);
  });

  it("an EXPIRED closure gets no read text, with or without an answer", () => {
    const since = "2026-10-01T00:00:00Z";
    for (const answer of [undefined, "a: better"]) {
      const c = check({ since, closed: { state: "EXPIRED", checkedAt: "2026-10-31T00:00:00.000Z", line: "x" }, ...(answer ? { answer } : {}) }, []);
      expect(c.text).toBe("a EXPIRED | ritual:pred since 2026-10-01T00:00:00.000Z: recorded EXPIRED at 2026-10-31T00:00:00.000Z; not rechecked (since is outside the 30-day window)");
    }
    // A replay early enough to put since back inside the window: the replay line, still no read.
    const o = { ...BASE, closed: { state: "EXPIRED", checkedAt: "2026-12-15T12:00:00.000Z", line: "x" }, answer: "a: worse" };
    const { predictions, problems } = parseLedger(file(o), "2026-12-20T00:00:00.000Z");
    expect(problems).toEqual([]);
    expect(checkRow(predictions[0], runs("......."), NOW, true).notes).toEqual(["recorded EXPIRED at 2026-12-15T12:00:00.000Z, after this time; not rechecked (replay)"]);
  });

  it("a MISMATCH line is unchanged: no read beside a closure the recheck disputes", () => {
    expect(check(rec("REFUTED", "a: better"), runs("......."), LATER).notes).toEqual([`MISMATCH: recorded REFUTED at ${NOW}, recheck says CONFIRMED`]);
  });

  it("the paste offer is followed by one line asking for the answer; an EXPIRED paste is not", () => {
    for (const [letters, st] of [[".......", "CONFIRMED"], ["CCC", "REFUTED"]]) {
      const c = check({}, runs(letters));
      expect([c.state, c.notes]).toEqual([st, [`"closed":${JSON.stringify({ state: st, checkedAt: NOW, line: c.text })}`, ANSWER_NOTE]]);
      const out = renderLedger("f", NOW, [c], false).split("\n");
      expect(out.slice(2)).toEqual([`  ${c.notes[0]}`, `  ${ANSWER_NOTE}`, ""]);
    }
    expect(check({ since: "2026-10-01T00:00:00Z" }, []).notes).toHaveLength(1);
    expect(check({}, runs("......."), NOW, true).notes).toEqual([]);
  });

  it("an open row that can close and already carries an answer gets the paste line only; without one, both lines", () => {
    const rows = runs(".......");
    const without = check({}, rows);
    const paste = `"closed":${JSON.stringify({ state: "CONFIRMED", checkedAt: NOW, line: without.text })}`;
    expect(without.notes).toEqual([paste, ANSWER_NOTE]);
    for (const answer of ["read: worse", "same", "a: better"]) {
      const c = check({ answer }, rows);
      expect([answer, c.state, c.notes]).toEqual([answer, "CONFIRMED", [paste]]);
      expect(renderLedger("f", NOW, [c], false).split("\n").slice(2)).toEqual([`  ${paste}`, ""]);
    }
  });

  it("the committed row 2 closure reads better, which differs from its REFUTED count", () => {
    const row2 = readFileSync(COMMITTED, "utf8").split("\n").map((l) => (l ? JSON.parse(l) : null)).find((o) => o?.id === "2");
    expect(row2?.closed?.state).toBe("REFUTED");
    expect(pred({ answer: row2.answer }).read).toBe("better");
  });
});
