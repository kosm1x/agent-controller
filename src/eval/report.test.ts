/**
 * W3 step 2 report rendering over the synthetic fixture: n beside every
 * rate, "no population" at n = 0, the censoring note on every wall-clock /
 * tool-call figure, the asymmetry note on every delegated-side figure, and
 * no free text from any seeded row (or the labels file's note column) in
 * markdown or JSON.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOTE, SECRET, buildEvalFixture, writeEvalArchive, writeEvalLabels } from "../test-utils/w3-eval-fixture.js";
import { readW1Labels, type LabelsRead } from "./labels.js";
import { collectEval } from "./queries.js";
import {
  ASYM,
  CENSOR,
  LIVE_ONLY,
  NO_LINK_LINE,
  NO_POP,
  SMALL_N,
  buildReportModel,
  formatFigure,
  renderJson,
  renderMarkdown,
  type ReportModel,
} from "./report.js";

let dir: string;
let db: Database.Database;
let labels: LabelsRead;
let model: ReportModel;
let md: string;

const tag = (n: string) => `[${n}]`;
const render = (days: number, l: LabelsRead = labels) =>
  buildReportModel(collectEval(db, { days, now: new Date(), archiveDir: join(dir, "archive"), labels: l, liveDays: 90 }));

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "w3-eval-r-"));
  db = new Database(buildEvalFixture(dir), { readonly: true, fileMustExist: true });
  writeEvalArchive(dir);
  labels = readW1Labels(writeEvalLabels(dir));
  model = render(90);
  md = renderMarkdown(model);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("formatFigure", () => {
  it("n beside every value; n = 0 → no population (notes kept)", () => {
    expect(formatFigure({ value: 0.4, n: 5, unit: "rate", notes: [] })).toBe("40.0 % (n=5)");
    expect(formatFigure({ value: null, n: 0, unit: "rate", notes: [ASYM] })).toBe(`${NO_POP} ${tag(ASYM)}`);
    expect(formatFigure({ value: 0.75, n: 0, unit: "rate", notes: [] })).toBe(NO_POP);
    expect(formatFigure({ value: 0.5, p90: 6.667, n: 2, unit: "min", notes: [CENSOR] })).toBe(`p50 0.50 · p90 6.67 min (n=2) ${tag(CENSOR)}`);
    expect(formatFigure({ value: 3, p90: 4, n: 2, unit: "calls", notes: [] })).toBe("p50 3 · p90 4 calls (n=2)");
    expect(formatFigure({ value: 1, n: 2, unit: "usd", notes: [] })).toBe("$1.0000 (n=2)");
    expect(formatFigure({ value: 0.75, n: 4, unit: "share", notes: [] })).toBe("75.0 per 100 (n=4)");
  });
});

describe("notes ride on the right figures", () => {
  it("every wall-clock and tool-call figure carries the censoring note", () => {
    expect(model.sides.length).toBeGreaterThan(0);
    for (const r of model.sides) {
      expect(r.wallClock.notes, r.side).toContain(CENSOR);
      expect(r.toolCalls.notes, r.side).toContain(CENSOR);
      expect(r.finished.notes).not.toContain(CENSOR);
    }
    for (const h of model.horizon) for (const b of [...h.tool, ...h.wall]) expect(b.finished.notes).toContain(CENSOR);
    expect(md.match(/largest (tool-call|wall-clock) bucket[^\n]*/g)!.every((l) => l.includes(tag(CENSOR)))).toBe(true);
  });

  it("every delegated-side figure carries the asymmetry note; operator figures do not", () => {
    const delegated = model.sides.filter((r) => ["ritual", "scheduled", "swarm_child", "other_delegated", "delegated_pooled"].includes(r.side));
    expect(new Set(delegated.map((r) => r.side))).toEqual(new Set(["ritual", "scheduled", "swarm_child", "other_delegated", "delegated_pooled"]));
    for (const r of delegated) {
      for (const f of [r.finished, r.wallClock, r.toolCalls, r.unverifiedNumbers, r.costPerFinished]) expect(f.notes, r.side).toContain(ASYM);
    }
    for (const r of model.sides.filter((x) => x.side === "operator" || x.side === "unknown")) {
      for (const f of [r.finished, r.wallClock, r.toolCalls, r.unverifiedNumbers, r.costPerFinished]) expect(f.notes).not.toContain(ASYM);
    }
    for (const l of model.ledger) expect(l.allMet.notes.includes(ASYM)).toBe(l.side !== "operator" && l.side !== "unknown");
    for (const [, f] of [...model.q4.scheduleRuns, ...model.q4.ritualGates]) expect(f.notes).toContain(ASYM);
    // Rendered: each delegated table row shows the tag once per figure column (5).
    const rows = md.split("\n").filter((l) => /^\| (ritual|scheduled|swarm_child|other_delegated|delegated_pooled) \| \w+ \| \d+ \|/.test(l));
    expect(rows.length).toBe(delegated.length);
    for (const l of rows) expect(l.split(tag(ASYM)).length - 1).toBe(5);
  });

  it("horizon: the pooled 'all' and 'delegated' groups carry ASYM, 'operator' does not", () => {
    for (const h of model.horizon) {
      for (const b of [...h.tool, ...h.wall]) expect(b.finished.notes.includes(ASYM), h.group).toBe(h.group !== "operator");
    }
  });

  it("buckets with 0 < n < 5 carry the n<5 note", () => {
    const all = model.horizon.find((h) => h.group === "all")!;
    const notes = Object.fromEntries([...all.tool, ...all.wall].map((b) => [b.bucket, b.finished.notes.includes(SMALL_N)]));
    expect(notes).toMatchObject({ "0-2": true, "6-10": false, "<1 min": false, "1-5 min": true });
  });
});

describe("rendered sections", () => {
  it("prints figures with n and no population where n = 0", () => {
    expect(md).toContain("| operator | fast | 7 | 42.9 % (n=7) |");
    expect(md).toMatch(/\| 6-10 \| no population \[censored/);
    expect(md).toContain(`- overridden (operator_override_kind vetoed / accepted_with_modification): ${NO_POP}`);
    expect(md).toContain("- vetoed (decisions.status): 1");
    expect(md).toContain(`- reverted: ${NO_POP}`);
    expect(md).toContain("largest tool-call bucket still ≥ 50 % (contiguous from the lowest, n ≥ 5 each): none; run stops at 0-2 (n<5)");
    expect(md).toContain("largest wall-clock bucket still ≥ 50 % (contiguous from the lowest, n ≥ 5 each): none; run stops at <1 min (<50 %)");
    expect(md).toContain("beyond 16 min: 1; wall-clock unknown: 2 (no timestamps or completed_at < started_at)");
    expect(md).toContain("- confirmed: 60.0 per 100 (n=5)");
    expect(md).toContain("- (other): 20.0 per 100 (n=5)");
    expect(md).toContain(`- ${NO_LINK_LINE}`);
    expect(md).toContain("1 files, 3 lines");
    expect(md).toContain("- tune_eval_results: 0 rows");
    expect(md).toContain("- commit_tasks: table absent");
    expect(md).toContain("cost_ledger rows in window with no task row: 1 rows · 1 task ids · $2.0000");
    expect(md).toContain("live retention 90 d (default), TASKS_RETENTION_DAYS); archive not read (window ≤ 90 d)");
    expect(md).toContain("earliest event (other);");
    expect(md).toContain("## Ledger per gate source (all rows incl. manual, grade rows excluded — see W1; task-level: failed > abandoned > all met; the finished verdict uses runnable rows only)");
    expect(md).not.toContain(LIVE_ONLY);
  });

  it("W1 section: operator label, grader-vs-label, grader-vs-runnable-gates", () => {
    expect(md).toContain("5 labelled task ids (3 table rows skipped), 4 in window");
    expect(md).toContain("- labelled in window: 4 (really done 3, not done 1); label overrides of the gate-only verdict: 2");
    expect(md).toContain("never decides finished): 4 (met 3, failed 1)");
    expect(md).toContain(
      "- grader-vs-label agreement (labelled tasks with a grader verdict): 33.3 % (n=3) [trace 30 d]; grader met / label not done: 1; grader failed / label really done: 1",
    );
    expect(md).toContain("- grader-vs-runnable-gates agreement (graded tasks with ≥ 1 runnable gate): 66.7 % (n=3) [trace 30 d]");
  });

  it("a missing labels file is printed as such", () => {
    const text = renderMarkdown(render(90, readW1Labels(join(dir, "absent.md"))));
    expect(text).toContain(`operator W1 labels: file not found at ${join(dir, "absent.md")} — no labels, gates decide every task`);
    expect(text).toContain("- labelled in window: 0 (really done 0, not done 0)");
    expect(text).toContain(`grader-vs-label agreement (labelled tasks with a grader verdict): ${NO_POP}`);
  });

  it("the archive line and live-rows-only notes appear when the archive contributed", () => {
    const m = render(200);
    const text = renderMarkdown(m);
    expect(text).toContain(
      "archive read (window > 90 d): 2 files read, 1 skipped, 2 bad lines; 5 archived rows in window, 3 merged after dedupe by task_id",
    );
    expect(m.sides.every((r) => r.costPerFinished.notes.includes(LIVE_ONLY) && r.unverifiedNumbers.notes.includes(LIVE_ONLY))).toBe(true);
    for (const out of [text, renderJson(m)]) {
      expect(out).not.toContain(SECRET);
      expect(out).not.toContain(NOTE);
    }
  });

  it("no seeded free text (titles, outputs, summaries, criteria, evidence, decision prose, day-log prose, label notes) reaches markdown or JSON", () => {
    const json = renderJson(model);
    for (const out of [md, json]) {
      expect(out).not.toContain(SECRET);
      expect(out).not.toContain(NOTE);
      expect(out).not.toContain("line two");
    }
    expect(JSON.parse(json).sides.length).toBe(model.sides.length);
  });
});
