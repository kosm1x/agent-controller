/**
 * Predictions ledger (docs/planning/predictions.jsonl, read by
 * scripts/complaints-digest.sh --ledger): one prediction per line, written
 * and committed before its runs. Nothing here writes the file: the commit
 * is what proves when a row was written. Pure: file text, the digest's rows
 * and `now` in, problems or one checked line per row out.
 *
 * A row is a verdict (src/complaints/verdict.ts, buildVerdict called once per
 * row on the same rows) plus up to 3 guards, "at most J of the counted runs
 * call `tool` fewer than M times". A guard is judged over the verdict's own
 * counted runs, with the verdict's unknown slots and its close rule
 * (closeRule): a finished run's tool calls never change, so a closed guard
 * stays closed for the same reason a closed verdict does.
 *
 * The window is fixed at the trace retention: inside it every counted run
 * still has its trace rows, so a recorded closure can be rechecked; outside
 * it the trace may be pruned, so it is not.
 */
import { toolCounts, typeKey, type TaskRow } from "./digest.js";
import { buildVerdict, closeRule, ISO_TIME, TYPE_PATTERN, type Verdict } from "./verdict.js";

/** Days this mode reads; equal to TRACE_RETENTION_DAYS (ledger.test.ts pins the two). */
export const LEDGER_DAYS = 30;

export const CLOSED_STATES = ["REFUTED", "CONFIRMED", "CONFIRMED, guard broken", "EXPIRED"] as const;
export type LedgerState = (typeof CLOSED_STATES)[number] | "COUNTING" | "CONFIRMED, guard pending";

export interface Guard {
  tool: string;
  min: number;
  maxBelow: number;
}

export interface Prediction {
  /** 1-based line in the file. */
  line: number;
  id: string;
  type: string;
  /** Floored to the second, as Date.toISOString() prints it. */
  since: string;
  maxComplaints: number;
  runs: number;
  guards: Guard[];
  closed: { state: string; checkedAt: string; line: string } | null;
}

export interface Problem {
  line: number;
  reason: string;
}

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const KEYS = ["id", "type", "since", "maxComplaints", "runs", "change", "baseline", "guards", "closed", "answer"];
const GUARD_KEYS = ["tool", "min", "maxBelow"];
const CLOSED_KEYS = ["state", "checkedAt", "line"];
const MAX = Number.MAX_SAFE_INTEGER;

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const whole = (v: unknown, lo: number, hi: number): boolean => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const text = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";
const q = (s: string): string => JSON.stringify(s);

/** Problems with an object's keys, then with each present key's value (checks: key, valid, what it must be). */
function objectProblems(o: Obj, allowed: string[], required: string[], checks: [string, boolean, string][], where: string): string[] {
  return [
    ...Object.keys(o).filter((k) => !allowed.includes(k)).map((k) => `unknown key ${q(k)}${where}`),
    ...required.filter((k) => !Object.hasOwn(o, k)).map((k) => `missing key ${q(k)}${where}`),
    ...checks.filter(([k, ok]) => Object.hasOwn(o, k) && !ok).map(([k, , must]) => `${q(k)}${where} must be ${must}`),
  ];
}

export function parseLedger(src: string): { predictions: Prediction[]; problems: Problem[] } {
  const lines = src.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const predictions: Prediction[] = [];
  const problems: Problem[] = [];
  const ids = new Map<string, number>();
  lines.forEach((raw, i) => {
    const line = i + 1;
    let o: unknown;
    try {
      o = JSON.parse(raw);
    } catch {
      o = undefined;
    }
    if (!isObject(o)) return problems.push({ line, reason: "not a JSON object" });
    const runsOk = whole(o.runs, 1, 100);
    const hi = runsOk ? (o.runs as number) - 1 : MAX;
    const below = runsOk ? `a whole number from 0 to ${hi} (below "runs")` : "a whole number";
    const sinceMs = typeof o.since === "string" && ISO_TIME.test(o.since) ? Date.parse(o.since) : NaN;
    const found = objectProblems(o, KEYS, KEYS.slice(0, 7), [
      ["id", typeof o.id === "string" && ID.test(o.id), `text matching ${ID.source}`],
      ["type", typeof o.type === "string" && TYPE_PATTERN.test(o.type), `text matching ${TYPE_PATTERN.source}`],
      ["since", !Number.isNaN(sinceMs), "an ISO time with Z or an offset, e.g. 2026-11-20T18:00:00Z"],
      ["runs", runsOk, "a whole number from 1 to 100"],
      ["maxComplaints", whole(o.maxComplaints, 0, hi), below],
      ["change", text(o.change), "non-empty text"],
      ["baseline", text(o.baseline), "non-empty text"],
      ["guards", Array.isArray(o.guards) && o.guards.length >= 1 && o.guards.length <= 3, "an array of 1 to 3 guards"],
      ["closed", isObject(o.closed), "an object"],
      ["answer", typeof o.answer === "string", "text"],
    ], "");
    if (Array.isArray(o.guards) && o.guards.length <= 3) {
      o.guards.forEach((g: unknown, j) => {
        const where = ` in guard ${j + 1}`;
        if (!isObject(g)) return found.push(`guard ${j + 1} must be an object`);
        found.push(...objectProblems(g, GUARD_KEYS, GUARD_KEYS, [
          ["tool", text(g.tool), "non-empty text"],
          ["min", whole(g.min, 1, MAX), "a whole number of at least 1"],
          ["maxBelow", whole(g.maxBelow, 0, hi), below],
        ], where));
      });
    }
    if (isObject(o.closed)) {
      const c = o.closed;
      found.push(...objectProblems(c, CLOSED_KEYS, CLOSED_KEYS, [
        ["state", (CLOSED_STATES as readonly unknown[]).includes(c.state), `a closed state: ${CLOSED_STATES.map(q).join(", ")}`],
        ["checkedAt", typeof c.checkedAt === "string", "text"],
        ["line", typeof c.line === "string", "text"],
      ], ` in "closed"`));
    }
    if (typeof o.id === "string" && ID.test(o.id)) {
      const first = ids.get(o.id);
      if (first !== undefined) found.push(`duplicate id ${q(o.id)} (first on line ${first})`);
      else ids.set(o.id, line);
    }
    for (const reason of found) problems.push({ line, reason });
    if (found.length > 0) return;
    predictions.push({
      line,
      id: o.id as string,
      type: o.type as string,
      since: new Date(Math.floor(sinceMs / 1000) * 1000).toISOString(),
      maxComplaints: o.maxComplaints as number,
      runs: o.runs as number,
      guards: (o.guards as Guard[] | undefined) ?? [],
      closed: (o.closed as Prediction["closed"] | undefined) ?? null,
    });
  });
  // Two open rows on one type: both changes are live in the same runs, so
  // neither verdict could be credited to its own change.
  const open = new Map<string, Prediction>();
  for (const p of predictions) {
    if (p.closed) continue;
    const first = open.get(p.type);
    if (first) problems.push({ line: p.line, reason: `rows ${q(first.id)} (line ${first.line}) and ${q(p.id)} are both open on ${p.type}` });
    else open.set(p.type, p);
  }
  return { predictions, problems: problems.sort((a, b) => a.line - b.line) };
}

export interface GuardCheck {
  guard: Guard;
  /** Counted runs calling the tool fewer than `min` times (no trace rows: 0 calls). */
  below: number;
  word: "holds" | "broken" | "pending";
}

export interface RowCheck {
  prediction: Prediction;
  state: LedgerState;
  /** Null when `since` is outside the window: not rechecked. */
  verdict: Verdict | null;
  guards: GuardCheck[];
  /** The row's line as printed. */
  text: string;
  /** Printed under the row: the recheck of a recorded closure, or the closure to paste. */
  notes: string[];
  mismatch: boolean;
}

const GUARD_WORD = { CONFIRMED: "holds", REFUTED: "broken", COUNTING: "pending" } as const;

export function checkRow(p: Prediction, rows: TaskRow[], now: string): RowCheck {
  const head = (state: LedgerState): string => `${p.id} ${state} | ${p.type} since ${p.since}: `;
  const rec = p.closed && `recorded ${p.closed.state} at ${p.closed.checkedAt}`;
  if (Date.parse(p.since) <= Date.parse(now) - LEDGER_DAYS * 86_400_000) {
    const state = (p.closed?.state ?? "EXPIRED") as LedgerState;
    const why = `since is outside the ${LEDGER_DAYS}-day window`;
    const line = head(state) + (rec ? `${rec}; not rechecked (${why})` : why);
    return { prediction: p, state, verdict: null, guards: [], text: line, notes: p.closed ? [] : [paste(state, now, line)], mismatch: false };
  }
  const v = buildVerdict(rows, { now, type: p.type, since: p.since, maxComplaints: p.maxComplaints, runs: p.runs });
  const byId = new Map(rows.map((r) => [r.task_id, r]));
  const counts = v.runList.map((r) => toolCounts(byId.get(r.taskId) as TaskRow));
  const guards = p.guards.map((guard): GuardCheck => {
    // Own keys only: a tool named like an Object prototype member is still 0 calls.
    const below = counts.filter((t) => (Object.hasOwn(t, guard.tool) ? t[guard.tool] : 0) < guard.min).length;
    return { guard, below, word: GUARD_WORD[closeRule(below, v.unknown, guard.maxBelow)] };
  });
  const words = guards.map((g) => g.word);
  const state: LedgerState =
    v.verdict !== "CONFIRMED" ? v.verdict
    : words.includes("broken") ? "CONFIRMED, guard broken"
    : words.includes("pending") ? "CONFIRMED, guard pending"
    : "CONFIRMED";
  const guardText = guards.length === 0 ? "guard: none"
    : guards.map(({ guard: g, below, word }) => `guard ${g.tool} >= ${g.min}: ${below} run(s) below (limit ${g.maxBelow}) ${word}`).join("; ");
  const none = rows.some((r) => typeKey(r) === p.type) ? "" : `; no run of this type in ${LEDGER_DAYS} days`;
  const line = head(state)
    + `counted ${v.counted}/${v.runs}, complaints ${v.complaints} (limit ${p.maxComplaints}), unknown ${v.unknown} [${v.strip}]; ${guardText}${none}`;
  const mismatch = p.closed !== null && p.closed.state !== state;
  const notes = rec ? [mismatch ? `MISMATCH: ${rec}, recheck says ${state}` : `${rec}; recheck agrees`]
    : (CLOSED_STATES as readonly string[]).includes(state) ? [paste(state, now, line)] : [];
  return { prediction: p, state, verdict: v, guards, text: line, notes, mismatch };
}

/** The `closed` member a person pastes into the row once it has closed. */
const paste = (state: LedgerState, now: string, line: string): string => `"closed":${JSON.stringify({ state, checkedAt: now, line })}`;

export function renderLedger(file: string, now: string, checks: RowCheck[]): string {
  const out = [`Ledger ${file} checked at ${now} over the ${LEDGER_DAYS} days before it: ${checks.length} row(s)`];
  for (const c of checks) out.push(c.text, ...c.notes.map((n) => `  ${n}`));
  return `${out.join("\n")}\n`;
}
