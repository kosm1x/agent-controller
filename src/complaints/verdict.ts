/**
 * Verdict on a prediction written before the runs happen: "type T has at
 * most K complaints in its first N finished runs started at or after S".
 * Pure: the rows are the digest's (scripts/complaints-digest.sh --verdict),
 * and a complaint and a finished run are what the digest calls them.
 */
import { buildOf, cmp, evidence, isComplaint, stripChar, typeKey, type TaskRow } from "./digest.js";

export type VerdictWord = "CONFIRMED" | "REFUTED" | "COUNTING";

export interface VerdictOptions {
  now: string;
  type: string;
  /** S, an ISO time from Date.toISOString(). */
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

export interface Verdict {
  now: string;
  type: string;
  since: string;
  verdict: VerdictWord;
  counted: number;
  runs: number;
  complaints: number;
  maxComplaints: number;
  /** Runs of the type at or after S that are not finished (running, cancelled, ...). */
  unfinished: number;
  /** Finished runs after the first N; they never change the verdict. */
  ignoredAfterN: number;
  /** Distinct builds of the counted runs, oldest first; null (no build) is one of them. */
  builds: (string | null)[];
  strip: string;
  runList: VerdictRun[];
}

/**
 * S in the text form of tasks.created_at, so a plain string comparison is the
 * digest's ordering: 'YYYY-MM-DD HH:MM:SS', with milliseconds only when S has
 * them (a run stamped in the same second but before S then sorts before it).
 */
function sinceKey(iso: string): string {
  const t = iso.replace("T", " ");
  return iso.endsWith(".000Z") ? t.slice(0, 19) : t.slice(0, 23);
}

export function buildVerdict(rows: TaskRow[], opts: VerdictOptions): Verdict {
  const since = sinceKey(opts.since);
  const mine = rows
    .filter((r) => typeKey(r) === opts.type && cmp(r.created_at, since) >= 0)
    .sort((a, b) => cmp(a.created_at, b.created_at) || cmp(a.task_id, b.task_id));
  const finished = mine.filter((r) => stripChar(r.status) !== "?");
  const counted = finished.slice(0, opts.runs);
  const complaints = counted.filter(isComplaint).length;
  const K = opts.maxComplaints;
  const verdict: VerdictWord =
    complaints > K ? "REFUTED" : complaints + (opts.runs - counted.length) <= K ? "CONFIRMED" : "COUNTING";
  return {
    now: opts.now,
    type: opts.type,
    since: opts.since,
    verdict,
    counted: counted.length,
    runs: opts.runs,
    complaints,
    maxComplaints: K,
    unfinished: mine.length - finished.length,
    ignoredAfterN: finished.length - counted.length,
    builds: [...new Set(counted.map(buildOf))],
    strip: counted.map((r) => stripChar(r.status)).join(""),
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
    `Prediction: ${v.type} has at most ${v.maxComplaints} complaint(s) (concerns+failed) in its first ${v.runs} finished runs started at or after ${v.since}; checked at ${v.now}`,
    `verdict: ${v.verdict}  counted ${v.counted}/${v.runs}  complaints ${v.complaints} (limit ${v.maxComplaints})`,
    `  counted runs, oldest left: [${v.strip}]`,
    `  not counted: ${v.unfinished} unfinished, ${v.ignoredAfterN} after the first ${v.runs}`,
  ];
  for (const r of v.runList) {
    const text = r.source === null ? "" : ` [${r.source}] ${r.text}`;
    out.push(`    ${r.createdAt} ${r.status} @${r.build ?? "-"}${text}`);
  }
  if (v.builds.length > 1) {
    out.push(`  caveat: the counted runs span ${v.builds.length} builds, oldest first: ${v.builds.map((b) => b ?? "no build").join(" · ")}`);
  }
  return `${out.join("\n")}\n`;
}
