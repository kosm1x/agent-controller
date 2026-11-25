/**
 * Predictions ledger (docs/planning/predictions.jsonl, read by
 * scripts/complaints-digest.sh --ledger): one prediction per line, written
 * and committed before its runs. Nothing here writes the file: the commit
 * is what proves when a row was written. Pure: file text, the digest's rows
 * and `now` in, problems or one checked line per row out.
 *
 * Each line must be canonical JSON (the text JSON.stringify gives back for
 * it), so a duplicate key cannot hide behind the one that wins. Every value
 * the tool prints is held to a pattern with no line break; `change` and
 * `baseline` are never printed, nor is `answer` beyond its last word, and a
 * problem message quotes text from the file (a key name) only ASCII-escaped.
 *
 * A closing pairs the count with the operator's answer to "do the outputs
 * since the change read worse, the same or better": `answer`, free text whose
 * last word (after its last space) must be exactly worse, same or better. That
 * word, the row's read, is the only text of `answer` ever printed: on a
 * recorded closure's line, a MISMATCH excepted (the recheck disputes the
 * closure, so there is no settled count to pair), OWED when there is no
 * answer, marked when it points the other way from the recorded state
 * (CONFIRMED... read worse, REFUTED read better). An EXPIRED closure has no
 * verdict to pair, so it gets no read. The paste offer asks for the answer
 * only while the row has none.
 *
 * A row is a verdict (src/complaints/verdict.ts, buildVerdict called once per
 * row on the same rows) plus up to 3 guards, "at most J of the counted runs
 * make fewer than M calls of `tool`". A guard may name a set of equivalent
 * tools instead (`tools`: 2 to 4 distinct names in ascending order, printed
 * joined by `|`); a run's calls are then the sum over the set. A guard counts
 * a tool's calls that have no did-not-run gate row: the ledger SQL's
 * `guard_tools` (src/complaints/query.ts, every tool the run called, so a
 * set needs nothing more from it), tool.called rows minus tool.gated rows whose
 * decision is in GATED_NOT_RUN. There is no trace event for a call that ran,
 * so these known cases still count: a call that errored; a placeholder
 * refusal on the first-call path (it is refused before the gate, so it leaves
 * no gate row, while the same refusal on the pending-card path does); sibling
 * calls after a turn-ending refusal (they never reach the gate); calls
 * refused by the external-request policy; and calls the tool registry
 * refuses just before executing them (src/tools/registry.ts): a rendered
 * secret placeholder in a non-read-only call it cannot turn back into a
 * value, a `{{SECRET_X}}` or shell `$SECRET_X` reference naming no stored
 * secret, or shell expansion in shell_exec. Those emit tool.secret_ref_refused,
 * which is not subtracted.
 *
 * A guard is judged over the verdict's own counted runs, with the verdict's
 * unknown slots and its close rule (closeRule), except that a counted run
 * whose completed_at second is not strictly before the check's second (or
 * that has no completed_at) is unknown to the guards, like a run in flight:
 * a trace row written later in that second still belongs to the run. The one
 * assumption left: no trace row for a finished run is written after its
 * completed_at second ends. Under it, a judged run's counts never change, so
 * a closed guard stays closed for the same reason a closed verdict does.
 *
 * The window is fixed at the trace retention. Checked at the clock, every
 * counted run inside it still has its trace rows, so a recorded closure is
 * rechecked; outside it the trace may be pruned, so it is not. A replay (a
 * --now in the past) reads today's rows: retention runs on the real clock and
 * may have pruned rows that existed at the replayed time, so a replay never
 * rechecks a recorded closure and never offers one to record. A closure
 * recorded after the replayed time is marked so on its row, not refused.
 */
import { cmp, toolCounts, typeKey, type TaskRow } from "./digest.js";
import { buildVerdict, closeRule, ISO_TIME, TYPE_PATTERN, windowSince, type Verdict } from "./verdict.js";

/** Days this mode reads; equal to TRACE_RETENTION_DAYS (ledger.test.ts pins the two). */
export const LEDGER_DAYS = 30;

export const CLOSED_STATES = ["REFUTED", "CONFIRMED", "CONFIRMED, guard broken", "EXPIRED"] as const;
export type LedgerState = (typeof CLOSED_STATES)[number] | "COUNTING" | "CONFIRMED, guard pending";

/** One tool, or a set of equivalent tools whose calls are summed. */
export type Guard = ({ tool: string } | { tools: string[] }) & { min: number; maxBelow: number };

export interface Prediction {
  /** 1-based line in the file. */
  line: number;
  id: string;
  type: string;
  /** Floored to the second (windowSince), as Date.toISOString() prints it. */
  since: string;
  maxComplaints: number;
  runs: number;
  guards: Guard[];
  closed: { state: string; checkedAt: string; line: string } | null;
  /** The last word of `answer`; null without one. */
  read: Read | null;
}

export interface Problem {
  line: number;
  reason: string;
}

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const TOOL = /^[A-Za-z0-9_.:-]{1,64}$/;
const DAY_MS = 86_400_000;
const KEYS = ["id", "type", "since", "maxComplaints", "runs", "change", "baseline", "guards", "closed", "answer"];
const GUARD_KEYS = ["tool", "tools", "min", "maxBelow"];
const CLOSED_KEYS = ["state", "checkedAt", "line"];
const MAX = Number.MAX_SAFE_INTEGER;
const READS = ["worse", "same", "better"] as const;
type Read = (typeof READS)[number];
/** The text after the last space (all of it when there is none). */
const lastWord = (s: string): string => s.slice(s.lastIndexOf(" ") + 1);

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const whole = (v: unknown, lo: number, hi: number): boolean => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const text = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";
/** Every character outside printable ASCII as \\uXXXX; printable ASCII text is unchanged. */
export const asciiEscape = (s: string): string =>
  s.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
/** Quoted and ASCII-escaped: no file text reaches a message raw (no NEL, line separators or bidi controls). */
const q = (s: string): string => asciiEscape(JSON.stringify(s));

/** Problems with an object's keys, then with each present key's value (checks: key, valid, what it must be). */
function objectProblems(o: Obj, allowed: string[], required: string[], checks: [string, boolean, string][], where: string): string[] {
  return [
    ...Object.keys(o).filter((k) => !allowed.includes(k)).map((k) => `unknown key ${q(k)}${where}`),
    ...required.filter((k) => !Object.hasOwn(o, k)).map((k) => `missing key ${q(k)}${where}`),
    ...checks.filter(([k, ok]) => Object.hasOwn(o, k) && !ok).map(([k, , must]) => `${q(k)}${where} must be ${must}`),
  ];
}

/**
 * `latest`: the latest time a recorded closure may carry: the check's time at
 * the clock; in a replay, the real current time (a closure later than the
 * replayed time is marked on its row by checkRow, not refused here).
 */
export function parseLedger(src: string, latest: string): { predictions: Prediction[]; problems: Problem[] } {
  const latestMs = Date.parse(latest);
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
    const canonical = JSON.stringify(o);
    const found = raw === canonical ? [] : ["not in canonical form (one JSON object, no spaces, no duplicate keys, as JSON.stringify writes it)"];
    const runsOk = whole(o.runs, 1, 100);
    const hi = runsOk ? (o.runs as number) - 1 : MAX;
    const below = runsOk ? `a whole number from 0 to ${hi} (below "runs")` : "a whole number";
    const sinceMs = isoMs(o.since);
    const since = Number.isNaN(sinceMs) ? null : windowSince(sinceMs, latestMs, LEDGER_DAYS).since;
    found.push(...objectProblems(o, KEYS, KEYS.slice(0, 7), [
      ["id", typeof o.id === "string" && ID.test(o.id), `text matching ${ID.source}`],
      ["type", typeof o.type === "string" && TYPE_PATTERN.test(o.type), `text matching ${TYPE_PATTERN.source}`],
      ["since", !Number.isNaN(sinceMs), "an ISO time with Z or an offset, e.g. 2026-11-20T18:00:00Z"],
      ["runs", runsOk, "a whole number from 1 to 100"],
      ["maxComplaints", whole(o.maxComplaints, 0, hi), below],
      ["change", text(o.change), "non-empty text"],
      ["baseline", text(o.baseline), "non-empty text"],
      ["guards", Array.isArray(o.guards) && o.guards.length >= 1 && o.guards.length <= 3, "an array of 1 to 3 guards"],
      ["closed", isObject(o.closed), "an object"],
      ["answer", typeof o.answer === "string" && (READS as readonly string[]).includes(lastWord(o.answer)), 'text whose last word (after its last space) is "worse", "same" or "better"'],
    ], ""));
    if (Array.isArray(o.guards) && o.guards.length <= 3) {
      o.guards.forEach((g: unknown, j) => {
        const where = ` in guard ${j + 1}`;
        if (!isObject(g)) return found.push(`guard ${j + 1} must be an object`);
        const names = g.tools;
        found.push(...objectProblems(g, GUARD_KEYS, GUARD_KEYS.slice(2), [
          ["tool", typeof g.tool === "string" && TOOL.test(g.tool), `text matching ${TOOL.source}`],
          ["tools", Array.isArray(names) && names.length >= 2 && names.length <= 4
            && names.every((t, k) => typeof t === "string" && TOOL.test(t) && (k === 0 || cmp(names[k - 1], t) < 0)),
            `an array of 2 to 4 tool names, each text matching ${TOOL.source}, distinct and in ascending order`],
          ["min", whole(g.min, 1, MAX), "a whole number of at least 1"],
          ["maxBelow", whole(g.maxBelow, 0, hi), below],
        ], where));
        if (Object.hasOwn(g, "tool") === Object.hasOwn(g, "tools")) found.push(`guard ${j + 1} must have exactly one of "tool" and "tools"`);
      });
    }
    if (isObject(o.closed)) {
      const c = o.closed;
      found.push(...objectProblems(c, CLOSED_KEYS, CLOSED_KEYS, [
        ["state", (CLOSED_STATES as readonly unknown[]).includes(c.state), `a closed state: ${CLOSED_STATES.map(q).join(", ")}`],
        ["checkedAt", recordedIn(isoMs(c.checkedAt), since, latestMs, c.state === "EXPIRED"), `an ISO time at or after "since" and not later than the current time: less than ${LEDGER_DAYS} days after "since", or at least that for EXPIRED`],
        ["line", typeof c.line === "string" && !/[\r\n\u0085\u2028\u2029]/.test(c.line), "single-line text"],
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
      since: since as string,
      maxComplaints: o.maxComplaints as number,
      runs: o.runs as number,
      guards: (o.guards as Guard[] | undefined) ?? [],
      closed: (o.closed as Prediction["closed"] | undefined) ?? null,
      read: typeof o.answer === "string" ? (lastWord(o.answer) as Read) : null,
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
  /** Judged runs with fewer than `min` calls with no did-not-run gate row of the guard's tool, or summed over its set (no trace rows: 0). */
  below: number;
  /** Counted runs not yet judged: finished in the check's second or later, or with no completed_at. */
  unsettled: number;
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
  /** Printed under the row: the recheck of a recorded closure, or the closure to paste and what goes with it. */
  notes: string[];
  mismatch: boolean;
}

const GUARD_WORD = { CONFIRMED: "holds", REFUTED: "broken", COUNTING: "pending" } as const;

const toolNames = (g: Guard): string[] => ("tools" in g ? g.tools : [g.tool]);

/** ms of an ISO time in the CLI's pattern; NaN for anything else. */
const isoMs = (v: unknown): number => (typeof v === "string" && ISO_TIME.test(v) ? Date.parse(v) : NaN);

/**
 * A recorded closure's time: not before `since` nor after `latestMs` (see
 * parseLedger), and
 * inside the row's window, where every closed state but EXPIRED is computed;
 * EXPIRED is only ever computed outside it.
 */
function recordedIn(ms: number, since: string | null, latestMs: number, expired: boolean): boolean {
  if (Number.isNaN(ms)) return false;
  if (since === null) return true; // "since" is reported on its own
  const s = Date.parse(since);
  return ms >= s && ms <= latestMs && ms < s + LEDGER_DAYS * DAY_MS !== expired;
}

/** `replay`: --now was given, so a recorded closure is not rechecked and none is offered. */
export function checkRow(p: Prediction, rows: TaskRow[], now: string, replay: boolean): RowCheck {
  const head = (state: LedgerState): string => `${p.id} ${state} | ${p.type} since ${p.since}: `;
  const after = p.closed !== null && Date.parse(p.closed.checkedAt) > Date.parse(now);
  const rec = p.closed && `recorded ${p.closed.state} at ${p.closed.checkedAt}${after ? ", after this time" : ""}`;
  const s = p.closed?.state;
  const differs = (s?.startsWith("CONFIRMED") && p.read === "worse") || (s === "REFUTED" && p.read === "better");
  const read = !s || s === "EXPIRED" ? "" : `; operator's read: ${p.read ?? "OWED"}${differs ? " (differs from the count)" : ""}`;
  if (!windowSince(Date.parse(p.since), Date.parse(now), LEDGER_DAYS).inside) {
    const state = (p.closed?.state ?? "EXPIRED") as LedgerState;
    const why = `since is outside the ${LEDGER_DAYS}-day window`;
    const line = head(state) + (rec ? `${rec}; not rechecked (${why})${read}` : why);
    const notes = p.closed || replay ? [] : [paste(state, now, line)];
    return { prediction: p, state, verdict: null, guards: [], text: line, notes, mismatch: false };
  }
  const v = buildVerdict(rows, { now, type: p.type, since: p.since, maxComplaints: p.maxComplaints, runs: p.runs });
  const byId = new Map(rows.map((r) => [r.task_id, r]));
  // Judged: finished in a second strictly before the check's, so no trace row
  // written in its finishing second can still arrive.
  const nowKey = now.slice(0, 19).replace("T", " ");
  const judged = v.runList.map((r) => byId.get(r.taskId)).filter((r): r is TaskRow => {
    const done = r?.completed_at;
    return typeof done === "string" && cmp(done, nowKey) < 0;
  });
  const counts = judged.map((r) => toolCounts(r.guard_tools));
  const unsettled = v.runList.length - judged.length;
  const guards = p.guards.map((guard): GuardCheck => {
    // Own keys only: a tool named like an Object prototype member is still 0 calls.
    const calls = (t: Record<string, number>): number => toolNames(guard).reduce((n, tool) => n + (Object.hasOwn(t, tool) ? t[tool] : 0), 0);
    const below = counts.filter((t) => calls(t) < guard.min).length;
    return { guard, below, unsettled, word: GUARD_WORD[closeRule(below, v.unknown + unsettled, guard.maxBelow)] };
  });
  const words = guards.map((g) => g.word);
  const state: LedgerState =
    v.verdict !== "CONFIRMED" ? v.verdict
    : words.includes("broken") ? "CONFIRMED, guard broken"
    : words.includes("pending") ? "CONFIRMED, guard pending"
    : "CONFIRMED";
  const guardText = guards.length === 0 ? "guard: none"
    : guards.map(({ guard: g, below, word }) => `guard ${toolNames(g).join("|")} >= ${g.min} calls: ${below} run(s) below (limit ${g.maxBelow}) ${word}`).join("; ")
      + (guards.length > 0 && unsettled > 0 ? `; ${unsettled} counted run(s) not yet judged` : "");
  const none = rows.some((r) => typeKey(r) === p.type) ? "" : `; no run of this type in ${LEDGER_DAYS} days`;
  const line = head(state)
    + `counted ${v.counted}/${v.runs}, complaints ${v.complaints} (limit ${p.maxComplaints}), unknown ${v.unknown} [${v.strip}]; ${guardText}${none}`;
  const mismatch = !replay && p.closed !== null && p.closed.state !== state;
  const notes = rec ? [replay ? `${rec}; not rechecked (replay)${read}` : mismatch ? `MISMATCH: ${rec}, recheck says ${state}` : `${rec}; recheck agrees${read}`]
    : !replay && (CLOSED_STATES as readonly string[]).includes(state) ? [paste(state, now, line), ...(p.read ? [] : [ANSWER_NOTE])] : [];
  return { prediction: p, state, verdict: v, guards, text: line, notes, mismatch };
}

/** The `closed` member a person pastes into the row once it has closed. */
const paste = (state: LedgerState, now: string, line: string): string => `"closed":${JSON.stringify({ state, checkedAt: now, line })}`;
/** Printed under a paste, but EXPIRED's, while the row has no answer. */
const ANSWER_NOTE = `record it with the operator's answer to "do the outputs since the change read worse, the same or better": "answer", text whose last word is worse, same or better`;

export function renderLedger(file: string, now: string, checks: RowCheck[], replay: boolean): string {
  const at = replay ? `replayed at ${now} (a replay, not a recheck)` : `checked at ${now}`;
  const out = [
    `Ledger ${asciiEscape(file)} ${at} over the ${LEDGER_DAYS} days before it: ${checks.length} row(s); a guard counts a tool's calls with no did-not-run gate row (errored calls and some refusals included)`,
  ];
  for (const c of checks) out.push(c.text, ...c.notes.map((n) => `  ${n}`));
  return `${out.join("\n")}\n`;
}
