import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import {
  bar1Kb,
  bar2Memory,
  bar3Feedback,
  gate,
  jevFeedbackLabel,
  judgeHalf,
  pickThreshold,
  type Recall,
} from "./readout.js";

const NOW = new Date("2026-09-22T12:00:00Z");
const REGISTERED_A = "knowledge/procedures/code-generation-sop.md"; // evidence file_write…
const REGISTERED_B = "directives/data-doc-authoring.md"; // evidence gdocs_write…

function shadow(
  consumer: string,
  ref: string,
  item: string,
  noul: number | null,
  incumbent: string | null,
  createdAt = "2026-09-22 01:00:00",
): void {
  getDatabase()
    .prepare(
      `INSERT INTO jev_shadow (created_at, consumer, ref, item, noul, latency_ms, incumbent)
       VALUES (?, ?, ?, ?, ?, 100, ?)`,
    )
    .run(createdAt, consumer, ref, item, noul, incumbent);
}

function telemetry(taskId: string, called: string[], message = "hola"): void {
  getDatabase()
    .prepare(
      `INSERT INTO scope_telemetry (task_id, message, tools_in_scope, tools_called)
       VALUES (?, ?, '["file_write"]', ?)`,
    )
    .run(taskId, message, JSON.stringify(called));
}

function kbRow(path: string, priority: number, chars: number): void {
  getDatabase()
    .prepare(
      `INSERT INTO jarvis_files (id, path, title, content, qualifier, condition, priority)
       VALUES (?, ?, 't', ?, 'conditional', NULL, ?)`,
    )
    .run(path, path, "x".repeat(chars), priority);
}

function audit(taskId: string, wasUsed: number | null, rows = 1): void {
  for (let i = 0; i < rows; i++)
    getDatabase()
      .prepare(
        `INSERT INTO recall_audit (bank, query, source, task_id, was_used)
         VALUES ('jme', 'q', 'test', ?, ?)`,
      )
      .run(taskId, wasUsed);
}

const recall = (score: number, used: boolean, i: number): Recall => ({
  ref: `t${i}`,
  createdAt: "2026-09-22 01:00:00",
  score,
  used,
});

beforeEach(() => {
  initDatabase(":memory:");
});
afterEach(() => {
  closeDatabase();
});

describe("gate", () => {
  it("is conclusive only at 7 days and 150 decisions", () => {
    expect(gate("2026-09-15 12:00:00", 150, NOW).conclusive).toBe(true);
    expect(gate("2026-09-15 12:00:00", 149, NOW).conclusive).toBe(false);
    expect(gate("2026-09-16 00:00:00", 150, NOW).conclusive).toBe(false);
    expect(gate(null, 150, NOW)).toMatchObject({ days: 0, conclusive: false });
  });
});

describe("bar 1 — kb", () => {
  it("packs the registered rows into the space unregistered rows leave, in both orders", () => {
    // Priority order: 5,000 unregistered chars, then A (2,000), then B (2,000).
    // Budget 8,000 → priority order keeps A, pushes B out; 2,990 chars remain
    // for registered rows, one of them.
    kbRow("directives/unregistered.md", 10, 5000);
    kbRow(REGISTERED_A, 20, 2000);
    kbRow(REGISTERED_B, 30, 2000);
    telemetry("t1", ["gdocs_write"]); // evidence for B only
    shadow("kb", "t1", REGISTERED_A, 0.1, "budget");
    shadow("kb", "t1", REGISTERED_B, 0.9, "pointer");
    shadow("kb", "t1", "_cut", null, null); // the message was longer than 500

    const r = bar1Kb(getDatabase(), NOW);
    expect(r.cut).toBe(1);
    expect(r.evidencePositive).toBe(1);
    expect(r.jevShare).toBe(1); // B first by score, fits
    expect(r.priorityShare).toBe(0); // A first by priority, B does not fit
    expect(r.liveShare).toBe(0); // what the incumbent column says
    expect(r.verdict).toBe("INCONCLUSIVE"); // 1 decision, < 7 days
  });

  it("excludes withheld, failed, no-telemetry and evidence-free turns and counts them", () => {
    kbRow(REGISTERED_A, 20, 100);
    shadow("kb", "w", "_withheld", null, null);
    shadow("kb", "w", "_cut", null, null); // never an item
    shadow("kb", "f", "_failed", null, null);
    shadow("kb", "no-tel", REGISTERED_A, 0.5, "budget");
    telemetry("no-ev", ["intel_query"]);
    shadow("kb", "no-ev", REGISTERED_A, 0.5, "budget");
    telemetry("gone", ["file_write"]);
    shadow("kb", "gone", "directives/deleted-since.md", 0.5, "budget");

    const r = bar1Kb(getDatabase(), NOW);
    expect(r).toMatchObject({
      requests: 5,
      withheld: 1,
      failed: 1,
      noTelemetry: 1,
      noEvidence: 2,
      rowsMissingToday: 1,
      evidencePositive: 0,
      jevShare: null,
      cut: 0, // the withheld request's `_cut` is not a decision
      verdict: "INCONCLUSIVE",
    });
  });
});

describe("bar 2 — memory", () => {
  it("picks the largest threshold keeping 95 % of used recalls", () => {
    const first = [
      recall(0.1, true, 0),
      ...Array.from({ length: 19 }, (_, i) =>
        recall(0.5 + i * 0.02, true, i + 1),
      ),
      recall(0.9, false, 30),
    ];
    expect(pickThreshold(first)).toBe(0.5);
    expect(pickThreshold([recall(0.3, false, 0)])).toBeNull();
  });

  it("judges a half by used kept and unused dropped", () => {
    const half = [
      recall(0.9, true, 0),
      recall(0.4, true, 1),
      recall(0.2, false, 2),
      recall(0.7, false, 3),
    ];
    expect(judgeHalf(half, 0.5)).toEqual({
      used: 2,
      unused: 2,
      usedKept: 0.5,
      unusedDropped: 0.5,
    });
  });

  it("scores a recall by its highest item and applies every registered exclusion", () => {
    shadow("memory", "used", "1", 0.2, "preference");
    shadow("memory", "used", "2", 0.8, "project");
    shadow("memory", "used", "_cut", null, null);
    audit("used", 1);
    shadow("memory", "unused", "3", 0.3, "project");
    audit("unused", 0);
    shadow("memory", "fan", "4", 0.9, "project");
    audit("fan", 1, 2); // two jme rows for one task: the claim-window fan-out
    shadow("memory", "w", "_withheld", null, null);
    shadow("memory", "f", "_failed", null, null);
    shadow("memory", "unclaimed", "5", 0.9, "project");
    shadow("memory", "pending", "6", 0.9, "project");
    audit("pending", null);
    shadow("memory", "empty", "7", null, "project"); // the only item was dropped

    const r = bar2Memory(getDatabase(), NOW);
    expect(r).toMatchObject({
      requests: 8,
      withheld: 1,
      failed: 1,
      noItems: 1,
      unclaimed: 2,
      fanOut: 1,
      recalls: 2,
      cut: 1,
      verdict: "INCONCLUSIVE",
    });
    // First half = the used recall (score 0.8, its highest item) → threshold 0.8.
    expect(r.threshold).toBe(0.8);
    expect(r.secondHalf).toEqual({
      used: 0,
      unused: 1,
      usedKept: null,
      unusedDropped: 1,
    });
  });
});

describe("bar 3 — feedback", () => {
  it("labels correction before restatement, never positive", () => {
    expect(jevFeedbackLabel(0.8, 0.9, 0.5)).toBe("negative");
    expect(jevFeedbackLabel(0.1, 0.6, 0.5)).toBe("rephrase");
    expect(jevFeedbackLabel(0.49, 0.49, 0.5)).toBe("neutral");
  });

  it("lists disagreements with the regex, marks the cut, and scores operator labels", () => {
    shadow("feedback", "dis", "correction", 0.8, "neutral");
    shadow("feedback", "dis", "restatement", 0.2, "neutral");
    shadow("feedback", "dis", "_cut", null, null); // a text exceeded the send cut
    shadow("feedback", "typo", "correction", 0.8, "neutral");
    shadow("feedback", "typo", "restatement", 0.2, "neutral");
    shadow("feedback", "agree", "correction", 0.1, "neutral");
    shadow("feedback", "agree", "restatement", 0.1, "neutral");
    shadow("feedback", "pos", "correction", 0.1, "positive");
    shadow("feedback", "pos", "restatement", 0.1, "positive");
    shadow("feedback", "half", "correction", 0.9, "neutral"); // restatement dropped
    shadow("feedback", "w", "_withheld", null, null);
    shadow("feedback", "f", "_failed", null, null);

    const r = bar3Feedback(getDatabase(), NOW, 0.5, {
      dis: "negative",
      typo: "Negative", // not a label: counted, not scored
      agree: "rephrase", // not a disagreement: label ignored
      pos: "bogus",
      nope: "negative", // no such task: a typo in the file
    });
    expect(r).toMatchObject({
      requests: 7,
      withheld: 1,
      failed: 1,
      partial: 1,
      decisions: 3, // dis, typo, agree; the positive incumbent is not comparable
      positiveIncumbent: 1,
      labelled: 1,
      unknownLabels: 1,
      unmatchedLabels: 3, // agree (no disagreement), pos (not comparable), nope
      right: 1,
      corrections: 1,
      precision: 1,
      verdict: "INCONCLUSIVE",
    });
    expect(r.disagreements).toEqual([
      expect.objectContaining({
        ref: "dis",
        jev: "negative",
        incumbent: "neutral",
        atCut: true,
        label: "negative",
      }),
      expect.objectContaining({ ref: "typo", atCut: false, label: null }),
    ]);
  });

  it("is UNLABELLED, not a verdict, when the gate passes with no labels", () => {
    for (let i = 0; i < 150; i++) {
      shadow(
        "feedback",
        `t${i}`,
        "correction",
        0.9,
        "neutral",
        "2026-09-10 00:00:00",
      );
      shadow(
        "feedback",
        `t${i}`,
        "restatement",
        0.1,
        "neutral",
        "2026-09-10 00:00:00",
      );
    }
    const r = bar3Feedback(getDatabase(), NOW);
    expect(r.gate.conclusive).toBe(true);
    expect(r.disagreements).toHaveLength(150);
    expect(r.verdict).toBe("UNLABELLED");
  });
});

// ---------------------------------------------------------------------------
// Verdicts: one fixture over each registered bar, one just under, at the gate.

const DAY7 = "2026-09-10 00:00:00";

function kbTurn(
  i: number,
  called: string[],
  aNoul: number,
  bNoul: number,
): void {
  telemetry(`k${i}`, called);
  shadow("kb", `k${i}`, REGISTERED_A, aNoul, "budget", DAY7);
  shadow("kb", `k${i}`, REGISTERED_B, bNoul, "pointer", DAY7);
}

/** Priority order always keeps A and never B (see the packing test above). */
function kbFixture(aTurns: number, bJevIn: number, bJevOut: number) {
  kbRow("directives/unregistered.md", 10, 5000);
  kbRow(REGISTERED_A, 20, 2000);
  kbRow(REGISTERED_B, 30, 2000);
  let i = 0;
  for (let k = 0; k < aTurns; k++) kbTurn(i++, ["file_write"], 0.9, 0.1); // A positive: both orders keep it
  for (let k = 0; k < bJevIn; k++) kbTurn(i++, ["gdocs_write"], 0.1, 0.9); // B positive: only Jev order keeps it
  for (let k = 0; k < bJevOut; k++) kbTurn(i++, ["gdocs_write"], 0.9, 0.1); // B positive: neither keeps it
  return bar1Kb(getDatabase(), NOW);
}

function memRecall(i: number, score: number, used: boolean, at: string): void {
  shadow("memory", `m${i}`, "1", score, "project", at);
  audit(`m${i}`, used ? 1 : 0);
}

/** First half: 72 used at 0.6 + 3 used at 0.2 → threshold 0.6. Second half: 30 used, 45 unused. */
function memFixture(secondUsedLow: number, secondUnusedLow: number) {
  const second = "2026-09-11 00:00:00";
  let i = 0;
  for (let k = 0; k < 72; k++) memRecall(i++, 0.6, true, DAY7);
  for (let k = 0; k < 3; k++) memRecall(i++, 0.2, true, DAY7);
  for (let k = 0; k < 30 - secondUsedLow; k++)
    memRecall(i++, 0.7, true, second);
  for (let k = 0; k < secondUsedLow; k++) memRecall(i++, 0.5, true, second);
  for (let k = 0; k < secondUnusedLow; k++) memRecall(i++, 0.55, false, second);
  for (let k = 0; k < 45 - secondUnusedLow; k++)
    memRecall(i++, 0.9, false, second);
  return bar2Memory(getDatabase(), NOW);
}

function fbDecision(i: number, correction: number, incumbent: string): void {
  shadow("feedback", `f${i}`, "correction", correction, incumbent, DAY7);
  shadow("feedback", `f${i}`, "restatement", 0.1, incumbent, DAY7);
}

/** Jev says negative where the regex said neutral; the operator labels some. */
function fbFixture(
  right: number,
  wrong: number,
  jevNeutralWrong: number,
  comparable = 150,
  positives = 0,
) {
  const labels: Record<string, string> = {};
  let i = 0;
  for (let k = 0; k < comparable - jevNeutralWrong; k++)
    fbDecision(i++, 0.9, "neutral");
  for (let k = 0; k < right; k++) labels[`f${k}`] = "negative";
  for (let k = right; k < right + wrong; k++) labels[`f${k}`] = "neutral";
  for (let k = 0; k < jevNeutralWrong; k++) {
    fbDecision(i, 0.1, "negative"); // Jev neutral, regex negative, operator sides with the regex
    labels[`f${i++}`] = "negative";
  }
  for (let k = 0; k < positives; k++) fbDecision(i++, 0.1, "positive");
  return bar3Feedback(getDatabase(), NOW, 0.5, labels);
}

describe("verdicts at the registered bars", () => {
  it("bar 1 passes at 15.3 points over priority order and fails at 14.7", () => {
    expect(kbFixture(127, 23, 0)).toMatchObject({
      evidencePositive: 150,
      jevShare: 1,
      verdict: "PASS",
    });
    closeDatabase();
    initDatabase(":memory:");
    expect(kbFixture(128, 22, 0)).toMatchObject({
      jevShare: 1,
      verdict: "FAIL",
    });
  });

  it("bar 1 passes at 90.0 % in budget by Jev order and fails at 89.3 %", () => {
    expect(kbFixture(112, 23, 15)).toMatchObject({
      jevShare: 0.9,
      verdict: "PASS",
    });
    closeDatabase();
    initDatabase(":memory:");
    expect(kbFixture(111, 23, 16)).toMatchObject({ verdict: "FAIL" });
  });

  it("bar 2 picks the threshold on the first half only and passes at 90 % kept / 40 % dropped", () => {
    // Picked on both halves the threshold would be 0.5 (102 of 105 used kept),
    // the 0.55 unused recalls would survive it, and the verdict would be FAIL.
    expect(memFixture(3, 18)).toMatchObject({
      recalls: 150,
      threshold: 0.6,
      secondHalf: { used: 30, unused: 45, usedKept: 0.9, unusedDropped: 0.4 },
      verdict: "PASS",
    });
  });

  it("bar 2 fails one used recall under 90 % kept, or one unused under 40 % dropped", () => {
    expect(memFixture(4, 18)).toMatchObject({
      threshold: 0.6,
      verdict: "FAIL",
    });
    closeDatabase();
    initDatabase(":memory:");
    expect(memFixture(3, 17)).toMatchObject({
      threshold: 0.6,
      verdict: "FAIL",
    });
  });

  it("bar 3 passes at 20 corrections, precision 80 %, Jev right 72.7 %", () => {
    expect(fbFixture(16, 4, 2)).toMatchObject({
      decisions: 150,
      labelled: 22,
      corrections: 20,
      precision: 0.8,
      right: 16 / 22,
      verdict: "PASS",
    });
  });

  it("bar 3 fails at 19 corrections, at precision 75 %, or at Jev right 69.6 %", () => {
    expect(fbFixture(16, 3, 2)).toMatchObject({
      corrections: 19,
      verdict: "FAIL",
    });
    closeDatabase();
    initDatabase(":memory:");
    expect(fbFixture(15, 5, 1)).toMatchObject({
      precision: 0.75,
      right: 15 / 21,
      verdict: "FAIL",
    });
    closeDatabase();
    initDatabase(":memory:");
    expect(fbFixture(16, 4, 3)).toMatchObject({
      right: 16 / 23,
      verdict: "FAIL",
    });
  });

  it("bar 3's gate counts comparable decisions only: a positive incumbent is not one", () => {
    expect(fbFixture(16, 4, 2, 149, 1)).toMatchObject({
      decisions: 149,
      positiveIncumbent: 1,
      verdict: "INCONCLUSIVE",
    });
  });
});
