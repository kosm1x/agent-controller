/**
 * Jev shadow readout — bars 1–3 of docs/planning/jev-consumers-plan-2026-09-21.md
 * (bar 2 as re-registered in docs/planning/jev-consumer-2-memory-plan-2026-09-22.md),
 * computed with every exclusion the plans registered, so the day-7 answer is
 * the same whoever runs it. Reads only; `scripts/validate-jev-readout.ts`
 * opens `mc.db` read-only and prints.
 */

import type Database from "better-sqlite3";
import {
  KB_CHAR_BUDGET,
  packConditionalRows,
  type ConditionalRow,
} from "../messaging/kb-injection.js";
import { KB_SHADOW_ROWS } from "./shadow-kb.js";

/** Registered gate: fewer days or decisions = INCONCLUSIVE, never a pass. */
export const READOUT_MIN_DAYS = 7;
export const READOUT_MIN_DECISIONS = 150;

export type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE";

export interface Gate {
  firstRow: string | null;
  days: number;
  decisions: number;
  conclusive: boolean;
}

/** `firstRow` is a `jev_shadow.created_at` (UTC, `YYYY-MM-DD HH:MM:SS`). */
export function gate(
  firstRow: string | null,
  decisions: number,
  now: Date,
): Gate {
  const days = firstRow
    ? (now.getTime() - Date.parse(`${firstRow.replace(" ", "T")}Z`)) /
      86_400_000
    : 0;
  return {
    firstRow,
    days,
    decisions,
    conclusive: days >= READOUT_MIN_DAYS && decisions >= READOUT_MIN_DECISIONS,
  };
}

interface ShadowRow {
  ref: string;
  item: string;
  noul: number | null;
  incumbent: string | null;
  created_at: string;
}

interface ScoredItem {
  item: string;
  noul: number;
  incumbent: string | null;
}

/** One request = one `ref`; `_withheld` / `_failed` mark it as no decision. */
interface Request {
  ref: string;
  createdAt: string;
  withheld: boolean;
  failed: boolean;
  /** A state text exceeded the 500-char send cut (`_cut` row). */
  cut: boolean;
  /** Items with an answer; a sensitive item dropped alone (null noul) is not one. */
  items: ScoredItem[];
}

function requests(db: Database.Database, consumer: string): Request[] {
  const rows = db
    .prepare(
      `SELECT ref, item, noul, incumbent, created_at FROM jev_shadow
       WHERE consumer = ? AND ref IS NOT NULL ORDER BY created_at, id`,
    )
    .all(consumer) as ShadowRow[];
  const byRef = new Map<string, Request>();
  for (const r of rows) {
    let q = byRef.get(r.ref);
    if (!q) {
      q = {
        ref: r.ref,
        createdAt: r.created_at,
        withheld: false,
        failed: false,
        cut: false,
        items: [],
      };
      byRef.set(r.ref, q);
    }
    if (r.item === "_withheld") q.withheld = true;
    else if (r.item === "_failed") q.failed = true;
    else if (r.item === "_cut") q.cut = true;
    else if (r.noul !== null)
      q.items.push({ item: r.item, noul: r.noul, incumbent: r.incumbent });
  }
  return [...byRef.values()];
}

function parseList(json: string | null): string[] {
  try {
    const v: unknown = JSON.parse(json ?? "[]");
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

const share = (n: number, of: number): number | null =>
  of > 0 ? n / of : null;

// ---------------------------------------------------------------------------
// Bar 1 — KB rows: packing in Jev-score order vs priority order.

export interface Bar1Result {
  gate: Gate;
  requests: number;
  withheld: number;
  failed: number;
  /** Turns with no `scope_telemetry` row: no tool evidence, not scored. */
  noTelemetry: number;
  /** Scored items whose row is gone from today's `jarvis_files` (or unregistered). */
  rowsMissingToday: number;
  /** Turns whose registered rows are all evidence-negative: nothing to rank. */
  noEvidence: number;
  evidencePositive: number;
  /** Share of evidence-positive registered rows in budget, per order. */
  jevShare: number | null;
  priorityShare: number | null;
  /** What priority order did live (`incumbent = 'budget'`), for comparison. */
  liveShare: number | null;
  /** Decisions whose message exceeded the 500-char send cut (`_cut` row; unmarked before that deploy). */
  cut: number;
  verdict: Verdict;
}

const rowChars = (r: ConditionalRow): number =>
  `### ${r.title}\n${r.content}`.length;

/** Greedy like `packConditionalRows`: a row that does not fit is skipped, the next may still fit. */
function packInto(
  order: readonly { path: string; chars: number }[],
  space: number,
): Set<string> {
  const inBudget = new Set<string>();
  let used = 0;
  for (const r of order) {
    if (used + r.chars > space) continue;
    inBudget.add(r.path);
    used += r.chars;
  }
  return inBudget;
}

interface ScoredKbRow {
  path: string;
  noul: number;
  incumbent: string | null;
  index: number;
  chars: number;
  positive: boolean;
}

/**
 * Registered simulation: unregistered rows keep today's priority outcome; the
 * registered rows the shadow scored are packed into the space that remains,
 * once in Jev-score order and once in priority order, with today's row sizes
 * (no row history exists). Evidence = the turn called one of the row's
 * registered tools (`scope_telemetry.tools_called`).
 */
export function bar1Kb(db: Database.Database, now: Date): Bar1Result {
  const rows = db
    .prepare(
      `SELECT path, title, content, condition FROM jarvis_files
       WHERE qualifier = 'conditional' ORDER BY priority ASC, created_at ASC`,
    )
    .all() as ConditionalRow[];
  const today = new Map(rows.map((row, index) => [row.path, { row, index }]));
  const telemetry = db.prepare(
    `SELECT tools_in_scope, tools_called FROM scope_telemetry
     WHERE task_id = ? ORDER BY id DESC LIMIT 1`,
  );
  const qs = requests(db, "kb");
  const n = {
    withheld: 0,
    failed: 0,
    noTelemetry: 0,
    rowsMissingToday: 0,
    noEvidence: 0,
    decisions: 0,
    evidencePositive: 0,
    jevIn: 0,
    priorityIn: 0,
    liveIn: 0,
    cut: 0,
  };
  for (const q of qs) {
    if (q.withheld) {
      n.withheld++;
      continue;
    }
    if (q.failed) {
      n.failed++;
      continue;
    }
    const t = telemetry.get(q.ref) as
      | { tools_in_scope: string | null; tools_called: string | null }
      | undefined;
    if (!t) {
      n.noTelemetry++;
      continue;
    }
    const called = parseList(t.tools_called);
    const packed = packConditionalRows(rows, parseList(t.tools_in_scope));
    const held = packed.inBudget
      .filter((r) => !Object.hasOwn(KB_SHADOW_ROWS, r.path))
      .reduce((sum, r) => sum + rowChars(r), 0);
    const scored: ScoredKbRow[] = [];
    for (const item of q.items) {
      const meta = today.get(item.item);
      if (!meta || !Object.hasOwn(KB_SHADOW_ROWS, item.item)) {
        n.rowsMissingToday++;
        continue;
      }
      scored.push({
        path: item.item,
        noul: item.noul,
        incumbent: item.incumbent,
        index: meta.index,
        chars: rowChars(meta.row),
        positive: KB_SHADOW_ROWS[item.item].evidence.some((e) =>
          called.includes(e),
        ),
      });
    }
    const positive = scored.filter((s) => s.positive);
    if (positive.length === 0) {
      n.noEvidence++;
      continue;
    }
    n.decisions++;
    if (q.cut) n.cut++;
    const space = KB_CHAR_BUDGET - held;
    const jev = packInto(
      [...scored].sort((a, b) => b.noul - a.noul || a.index - b.index),
      space,
    );
    const priority = packInto(
      [...scored].sort((a, b) => a.index - b.index),
      space,
    );
    n.evidencePositive += positive.length;
    n.jevIn += positive.filter((s) => jev.has(s.path)).length;
    n.priorityIn += positive.filter((s) => priority.has(s.path)).length;
    n.liveIn += positive.filter((s) => s.incumbent === "budget").length;
  }
  const g = gate(qs[0]?.createdAt ?? null, n.decisions, now);
  const jevShare = share(n.jevIn, n.evidencePositive);
  const priorityShare = share(n.priorityIn, n.evidencePositive);
  const verdict: Verdict =
    !g.conclusive || jevShare === null || priorityShare === null
      ? "INCONCLUSIVE"
      : jevShare >= 0.9 && (jevShare - priorityShare) * 100 >= 15
        ? "PASS"
        : "FAIL";
  return {
    gate: g,
    requests: qs.length,
    withheld: n.withheld,
    failed: n.failed,
    noTelemetry: n.noTelemetry,
    rowsMissingToday: n.rowsMissingToday,
    noEvidence: n.noEvidence,
    evidencePositive: n.evidencePositive,
    jevShare,
    priorityShare,
    liveShare: share(n.liveIn, n.evidencePositive),
    cut: n.cut,
    verdict,
  };
}

// ---------------------------------------------------------------------------
// Bar 2 — JME recalls: a threshold picked on the first half, judged on the second.

export interface Recall {
  ref: string;
  createdAt: string;
  /** The recall's highest item noul. */
  score: number;
  used: boolean;
}

export interface HalfJudgement {
  used: number;
  unused: number;
  usedKept: number | null;
  unusedDropped: number | null;
}

export interface Bar2Result {
  gate: Gate;
  requests: number;
  withheld: number;
  failed: number;
  /** Every item dropped as sensitive: a request with nothing scored. */
  noItems: number;
  /** No `recall_audit` row claimed for the task, or `was_used` still NULL. */
  unclaimed: number;
  /** Task ids with more than one `jme` audit row (the 60 s claim window fan-out). */
  fanOut: number;
  recalls: number;
  /** Recalls whose message exceeded the 500-char send cut (`_cut` row; unmarked before that deploy). */
  cut: number;
  threshold: number | null;
  firstHalf: HalfJudgement | null;
  secondHalf: HalfJudgement | null;
  verdict: Verdict;
}

/** The largest score that still keeps ≥ 95 % of used recalls. */
export function pickThreshold(recalls: readonly Recall[]): number | null {
  const used = recalls.filter((r) => r.used).map((r) => r.score);
  let best: number | null = null;
  for (const t of used) {
    const kept = used.filter((s) => s >= t).length / used.length;
    if (kept >= 0.95 && (best === null || t > best)) best = t;
  }
  return best;
}

export function judgeHalf(
  recalls: readonly Recall[],
  threshold: number,
): HalfJudgement {
  const used = recalls.filter((r) => r.used);
  const unused = recalls.filter((r) => !r.used);
  return {
    used: used.length,
    unused: unused.length,
    usedKept: share(
      used.filter((r) => r.score >= threshold).length,
      used.length,
    ),
    unusedDropped: share(
      unused.filter((r) => r.score < threshold).length,
      unused.length,
    ),
  };
}

export function bar2Memory(db: Database.Database, now: Date): Bar2Result {
  const qs = requests(db, "memory");
  const audit = new Map(
    (
      db
        .prepare(
          `SELECT task_id, COUNT(*) AS n, MAX(was_used) AS used FROM recall_audit
           WHERE bank = 'jme' AND task_id IS NOT NULL GROUP BY task_id`,
        )
        .all() as { task_id: string; n: number; used: number | null }[]
    ).map((a) => [a.task_id, a]),
  );
  const n = {
    withheld: 0,
    failed: 0,
    noItems: 0,
    unclaimed: 0,
    fanOut: 0,
    cut: 0,
  };
  const recalls: Recall[] = [];
  for (const q of qs) {
    if (q.withheld) {
      n.withheld++;
      continue;
    }
    if (q.failed) {
      n.failed++;
      continue;
    }
    if (q.items.length === 0) {
      n.noItems++;
      continue;
    }
    const a = audit.get(q.ref);
    if (a && a.n > 1) {
      n.fanOut++;
      continue;
    }
    if (!a || a.used === null) {
      n.unclaimed++;
      continue;
    }
    if (q.cut) n.cut++;
    recalls.push({
      ref: q.ref,
      createdAt: q.createdAt,
      score: Math.max(...q.items.map((i) => i.noul)),
      used: a.used === 1,
    });
  }
  const half = Math.floor(recalls.length / 2);
  const first = recalls.slice(0, half);
  const second = recalls.slice(half);
  const threshold = pickThreshold(first);
  const firstHalf = threshold === null ? null : judgeHalf(first, threshold);
  const secondHalf = threshold === null ? null : judgeHalf(second, threshold);
  const g = gate(qs[0]?.createdAt ?? null, recalls.length, now);
  const verdict: Verdict =
    !g.conclusive ||
    !secondHalf ||
    secondHalf.usedKept === null ||
    secondHalf.unusedDropped === null
      ? "INCONCLUSIVE"
      : secondHalf.usedKept >= 0.9 && secondHalf.unusedDropped >= 0.4
        ? "PASS"
        : "FAIL";
  return {
    gate: g,
    requests: qs.length,
    ...n,
    recalls: recalls.length,
    threshold,
    firstHalf,
    secondHalf,
    verdict,
  };
}

// ---------------------------------------------------------------------------
// Bar 3 — feedback label: a disagreement table the operator labels.

export type FeedbackLabel = "negative" | "rephrase" | "neutral";

/**
 * Frozen before the readout (the plan registers no post-hoc rescue): the
 * noul at which Jev's answer becomes a label. Not a CLI flag.
 */
export const FEEDBACK_THRESHOLD = 0.5;

const isFeedbackLabel = (s: string | null): s is FeedbackLabel =>
  s === "negative" || s === "rephrase" || s === "neutral";

/** Jev asks no positive question ("excelente" is the only eval word). */
export function jevFeedbackLabel(
  correction: number,
  restatement: number,
  threshold: number,
): FeedbackLabel {
  if (correction >= threshold) return "negative";
  if (restatement >= threshold) return "rephrase";
  return "neutral";
}

export interface Disagreement {
  ref: string;
  createdAt: string;
  correction: number;
  restatement: number;
  jev: FeedbackLabel;
  incumbent: string;
  /**
   * The follow-up or the previous message exceeded the 500-char send cut
   * (`_cut` row): Jev and the regex did not read equal text. Rows recorded
   * before `_cut` existed carry no mark.
   */
  atCut: boolean;
  label: FeedbackLabel | null;
}

export interface Bar3Result {
  gate: Gate;
  requests: number;
  withheld: number;
  failed: number;
  /** One of the two items dropped as sensitive: no label can be formed. */
  partial: number;
  /** Comparable decisions (both items answered, incumbent not positive): the gate count. */
  decisions: number;
  /** Regex said `positive`: Jev has no positive question, so not comparable. */
  positiveIncumbent: number;
  disagreements: Disagreement[];
  labelled: number;
  /** Disagreements whose label in the file is not negative/rephrase/neutral. */
  unknownLabels: number;
  /** Labels in the file whose task id is no disagreement (typo, or a row Jev agreed on). */
  unmatchedLabels: number;
  /** Share of labelled disagreements where the operator sided with Jev. */
  right: number | null;
  /** Labelled disagreements where Jev moved the label off `neutral`. */
  corrections: number;
  precision: number | null;
  verdict: Verdict | "UNLABELLED";
}

export function bar3Feedback(
  db: Database.Database,
  now: Date,
  threshold: number = FEEDBACK_THRESHOLD,
  labels: Readonly<Record<string, string>> = {},
): Bar3Result {
  const qs = requests(db, "feedback");
  const n = {
    withheld: 0,
    failed: 0,
    partial: 0,
    decisions: 0,
    positiveIncumbent: 0,
    unknownLabels: 0,
  };
  const disagreements: Disagreement[] = [];
  for (const q of qs) {
    if (q.withheld) {
      n.withheld++;
      continue;
    }
    if (q.failed) {
      n.failed++;
      continue;
    }
    const c = q.items.find((i) => i.item === "correction");
    const r = q.items.find((i) => i.item === "restatement");
    if (!c || !r) {
      n.partial++;
      continue;
    }
    const incumbent = c.incumbent ?? "neutral";
    if (incumbent === "positive") {
      n.positiveIncumbent++;
      continue;
    }
    n.decisions++;
    const jev = jevFeedbackLabel(c.noul, r.noul, threshold);
    if (jev === incumbent) continue;
    const label = labels[q.ref] ?? null;
    if (label !== null && !isFeedbackLabel(label)) n.unknownLabels++;
    disagreements.push({
      ref: q.ref,
      createdAt: q.createdAt,
      correction: c.noul,
      restatement: r.noul,
      jev,
      incumbent,
      atCut: q.cut,
      label: isFeedbackLabel(label) ? label : null,
    });
  }
  const refs = new Set(disagreements.map((d) => d.ref));
  const unmatchedLabels = Object.keys(labels).filter(
    (k) => !refs.has(k),
  ).length;
  const labelled = disagreements.filter((d) => d.label !== null);
  const corrections = labelled.filter((d) => d.jev !== "neutral");
  const right = share(
    labelled.filter((d) => d.label === d.jev).length,
    labelled.length,
  );
  const precision = share(
    corrections.filter((d) => d.label === d.jev).length,
    corrections.length,
  );
  const g = gate(qs[0]?.createdAt ?? null, n.decisions, now);
  const verdict: Bar3Result["verdict"] = !g.conclusive
    ? "INCONCLUSIVE"
    : labelled.length === 0 || right === null || precision === null
      ? "UNLABELLED"
      : right >= 0.7 && corrections.length >= 20 && precision >= 0.8
        ? "PASS"
        : "FAIL";
  return {
    gate: g,
    requests: qs.length,
    ...n,
    disagreements,
    labelled: labelled.length,
    unmatchedLabels,
    right,
    corrections: corrections.length,
    precision,
    verdict,
  };
}
