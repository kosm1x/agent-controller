/**
 * Verdict on a prediction written before the runs happen: "type T has at
 * most K complaints in its first N runs queued at or after S". Pure: the rows
 * are the digest's (scripts/complaints-digest.sh --verdict), and a complaint
 * is what the digest calls one.
 *
 * The rule. Each run is FINISHED (completed, completed_with_concerns,
 * failed: the strip's ".", C, F), CANCELLED (terminal with no outcome: it
 * never takes a slot) or IN FLIGHT (any other status, unknown ones included;
 * needs_context and blocked too: they are not complaints, but hold a slot
 * until they resolve). The slots are the first N finished or in-flight runs in
 * queue order (tasks.created_at, then task_id). complaints = complaints among
 * the finished runs in the slots; unknown = in-flight runs in the slots plus
 * the empty slots. REFUTED iff complaints > K; CONFIRMED iff complaints +
 * unknown <= K; otherwise COUNTING.
 *
 * Why a closed verdict is final: a finished or cancelled row never changes
 * status again (every status write in src/ excludes those four), and new
 * rows sort after every row counted here (see `before`). So a slot changes
 * only when an in-flight run finishes (one unknown becomes at most one
 * complaint) or is cancelled and the runs behind it move up (that unknown is
 * replaced by a complaint, a clean run, another unknown or an empty slot).
 * complaints never falls, so REFUTED stays; complaints + unknown never rises,
 * so CONFIRMED stays.
 *
 * Outside that guarantee: (1) a manual edit of the database. No known
 * writer in the repo rewrites an ended status: the `mc-ctl cancel` database
 * fallback was the one found, and it now leaves all four ended statuses
 * alone (src/dispatch/mc-ctl-cancel-fallback.test.ts holds that); (2) retention
 * deleting a counted row (only if TASKS_RETENTION_DAYS is below the --since
 * age); (3) the host clock stepping backward, so new rows are stamped before
 * rows already counted. A replay with a past --now reads today's statuses,
 * not a snapshot of that time.
 */
import { buildOf, cmp, evidence, isComplaint, stripChar, typeKey, type TaskRow } from "./digest.js";

export type VerdictWord = "CONFIRMED" | "REFUTED" | "COUNTING";

export interface VerdictOptions {
  /** An ISO time from Date.toISOString(); only whole seconds are used. */
  now: string;
  type: string;
  /** S, an ISO time from Date.toISOString(); only whole seconds are used. */
  since: string;
  maxComplaints: number;
  runs: number;
}

export interface VerdictRun {
  createdAt: string;
  taskId: string;
  status: string;
  build: string | null;
  /** For a complaint, the evidence the digest would show; null for a clean run. */
  source: "concern" | "reply" | null;
  text: string | null;
}

export interface QueuedRun {
  createdAt: string;
  taskId: string;
  status: string;
}

export interface Verdict {
  now: string;
  type: string;
  since: string;
  verdict: VerdictWord;
  /** Finished runs in the slots. */
  counted: number;
  runs: number;
  complaints: number;
  /** In-flight runs in the slots plus the empty slots. */
  unknown: number;
  /** Runs queued in the second of `now` (or later): left for the next check. */
  deferred: number;
  maxComplaints: number;
  /** In-flight runs holding a slot. */
  inFlight: QueuedRun[];
  /** Cancelled runs at or after S: never in a slot. */
  cancelled: QueuedRun[];
  /** Finished or in-flight runs after the first N; they never change the verdict. */
  ignoredAfterN: number;
  /** Distinct builds of the counted runs, oldest first; null (no build) is one of them. */
  builds: (string | null)[];
  /** The slots in the digest's letters, oldest left; "?" is a run in flight. */
  strip: string;
  /** The counted (finished) runs. */
  runList: VerdictRun[];
}

/** A type key as --type takes it. */
export const TYPE_PATTERN = /^(ritual|schedule):[A-Za-z0-9_-]+$/;
/** An ISO time with Z or an offset, as --now and --since take it. */
export const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/;

/**
 * The close rule over `limit`: REFUTED once `bad` exceeds it, CONFIRMED once
 * `bad` plus `unknown` cannot, else COUNTING. One copy, so the ledger's guards
 * close by exactly the verdict's rule.
 */
export function closeRule(bad: number, unknown: number, limit: number): VerdictWord {
  return bad > limit ? "REFUTED" : bad + unknown <= limit ? "CONFIRMED" : "COUNTING";
}

/**
 * A prediction's S as counted: floored to the second (tasks.created_at has
 * whole seconds, so a run stamped in the second of S is at or after it), and
 * whether it is inside the window (now - days, now] the SQL reads. An S at or
 * before the window's start could miss runs, so it is never half counted.
 */
export function windowSince(sinceMs: number, nowMs: number, days: number): { since: string; inside: boolean } {
  const floored = Math.floor(sinceMs / 1000) * 1000;
  return { since: new Date(floored).toISOString(), inside: floored > nowMs - days * 86_400_000 };
}

/** tasks.created_at text ('YYYY-MM-DD HH:MM:SS') of an ISO time, floored to the second. */
const secondKey = (iso: string): string => iso.slice(0, 19).replace("T", " ");
const queued = (r: TaskRow): QueuedRun => ({ createdAt: r.created_at, taskId: r.task_id, status: r.status });
const isFinished = (r: TaskRow): boolean => stripChar(r.status) !== "?";
const isCancelled = (r: TaskRow): boolean => r.status === "cancelled";

/**
 * True iff the second of `nowMs` is later than the clock: a --now ahead of the
 * clock would count rows that runs queued later can still sort ahead of. The
 * wrapper's pinned --now (floored, read before the clock) is never refused.
 */
export function nowIsAfterClock(nowMs: number, clockMs: number): boolean {
  return Math.floor(nowMs / 1000) * 1000 > clockMs;
}

export function buildVerdict(rows: TaskRow[], opts: VerdictOptions): Verdict {
  const since = secondKey(opts.since);
  // Rows queued in the second of `now` are left for a later check: a run
  // queued later in that same second would share the time and could sort
  // ahead of them on task_id (a random id), so only earlier seconds count.
  const before = secondKey(opts.now);
  const ofType = rows.filter((r) => typeKey(r) === opts.type && cmp(r.created_at, since) >= 0);
  const mine = ofType
    .filter((r) => cmp(r.created_at, before) < 0)
    .sort((a, b) => cmp(a.created_at, b.created_at) || cmp(a.task_id, b.task_id));
  const live = mine.filter((r) => !isCancelled(r));
  const slots = live.slice(0, opts.runs);
  const counted = slots.filter(isFinished);
  const inFlight = slots.filter((r) => !isFinished(r));
  const complaints = counted.filter(isComplaint).length;
  const unknown = inFlight.length + (opts.runs - slots.length);
  const K = opts.maxComplaints;
  const verdict = closeRule(complaints, unknown, K);
  return {
    now: opts.now,
    type: opts.type,
    since: opts.since,
    verdict,
    counted: counted.length,
    runs: opts.runs,
    complaints,
    unknown,
    deferred: ofType.length - mine.length,
    maxComplaints: K,
    inFlight: inFlight.map(queued),
    cancelled: mine.filter(isCancelled).map(queued),
    ignoredAfterN: live.length - slots.length,
    builds: [...new Set(counted.map(buildOf))],
    strip: slots.map((r) => stripChar(r.status)).join(""),
    runList: counted.map((r) => {
      const e = isComplaint(r) ? evidence(r, false) : null;
      return {
        createdAt: r.created_at,
        taskId: r.task_id,
        status: r.status,
        build: buildOf(r),
        source: e?.source ?? null,
        text: e?.text ?? null,
      };
    }),
  };
}

export function renderVerdict(v: Verdict): string {
  const out = [
    `Prediction: ${v.type} has at most ${v.maxComplaints} complaint(s) (concerns+failed) in its first ${v.runs} runs queued at or after ${v.since}; checked at ${v.now}`,
    `verdict: ${v.verdict}  counted ${v.counted}/${v.runs}  unknown ${v.unknown}  complaints ${v.complaints} (limit ${v.maxComplaints})`,
    `  slots, oldest left: [${v.strip}]`,
  ];
  if (v.verdict === "COUNTING") {
    // From the rule: REFUTED needs complaints > K; CONFIRMED needs enough
    // unknown slots to resolve clean that complaints + unknown <= K.
    const refute = v.maxComplaints + 1 - v.complaints;
    const confirm = v.complaints + v.unknown - v.maxComplaints;
    out.push(`  to close: ${refute} more complaint(s) would refute it; ${confirm} more clean result(s) in the open slots would confirm it`);
    if (v.inFlight.length > 0) out.push(`  waiting for ${v.inFlight.length} run(s) still in flight`);
  }
  for (const r of v.runList) {
    const text = r.source === null ? "" : ` [${r.source}] ${r.text}`;
    out.push(`    ${r.createdAt} ${r.status} @${r.build ?? "-"}${text}`);
  }
  out.push(`  in flight, holding a slot: ${v.inFlight.length}`);
  for (const r of v.inFlight) out.push(`    ${r.createdAt} ${r.status} ${r.taskId}`);
  const held = [...new Set(v.inFlight.map((r) => r.status).filter((s) => s === "needs_context" || s === "blocked"))];
  if (held.length > 0) out.push(`  ${held.join(" and ")}: not a complaint; holds its slot until it resolves`);
  out.push(`  cancelled, ignored: ${v.cancelled.length}`);
  for (const r of v.cancelled) out.push(`    ${r.createdAt} ${r.status} ${r.taskId}`);
  out.push(`  after the first ${v.runs}: ${v.ignoredAfterN}`);
  out.push(`  queued in the second of the check, left for the next check: ${v.deferred}`);
  if (v.builds.length > 1) {
    out.push(`  caveat: the counted runs span ${v.builds.length} builds, oldest first: ${v.builds.map((b) => b ?? "no build").join(" · ")}`);
  }
  return `${out.join("\n")}\n`;
}
