/**
 * Complaints proposals: the per-type packet the weekly complaints-proposals
 * ritual (src/rituals/complaints-proposals.ts) embeds for the model, which
 * then writes one proposed change per type for the operator. Nothing here
 * applies a change or writes a ledger row. Pure: the ledger SQL's rows
 * (complaintsSql(facts, true), so `guard_tools` and `completed_at` are
 * present), the parsed ledger and its text, the newest run of each covered
 * type and `now` in, text out. Same inputs (rows in any order) give
 * byte-identical output.
 *
 * What the model may not write is computed here: the prediction (a fixed
 * K/N with the digest's baseline) and the guard candidates, counted from the
 * same per-run `guard_tools` counts the ledger's guard check reads.
 */
import { buildDigest, cmp, renderDigest, toolCounts, typeKey, type DigestOptions, type TaskRow } from "./digest.js";
import type { Guard, Prediction } from "./ledger.js";

/** The CLI's defaults (scripts/complaints-digest.ts): the trigger is the digest's. */
const DAYS = 30;
const LAST = 7;
const MIN = 5;
/** Types covered per week; the rest are listed as not covered. */
export const COVERED_MAX = 3;
export const INSTRUCTION_MAX_CHARS = 6_000;
const GUARD_RUNS = 10;
const GUARD_MIN_RUNS = 5;
/** Two tools that read the same files: a one-name guard over either broke a real prediction. */
const READ_PAIR = ["file_read", "jarvis_file_read"];
/** A meta tool: whether a run calls it depends on the build (deferred tool loading), not on the task's work. */
export const NOT_A_GUARD = "ToolSearch";
/** What src/complaints/ledger.ts accepts per row; the packet says so, the model chooses. */
const GUARDS_PER_ROW = "1 to 3";
export const PREDICTION = `at most 2 of the next ${LAST} runs end as a complaint`;
const FINISHED = new Set(["completed", "completed_with_concerns", "failed"]);
/** The ritual these packets are for never proposes on itself; its complaints stay in the ordinary digest. */
export const SELF_KEY = "ritual:complaints-proposals";

/** The newest run of a covered type: its instruction text and the tool list in its metadata (null: none declared). */
export interface NewestRun {
  description: string;
  tools: string[] | null;
  /** True: `description` is the schedule's stored task text; false: the newest run's assembled description. */
  stored: boolean;
}

export interface ProposalTypes {
  /** In order: most complaints in the last 7 first, then by key; at most COVERED_MAX. */
  covered: { key: string; newestTaskId: string }[];
  notCovered: string[];
}

const digestOpts = (now: string, type?: string): DigestOptions => ({ now, days: DAYS, last: LAST, min: MIN, type });
const sorted = (rows: TaskRow[]): TaskRow[] =>
  [...rows].sort((a, b) => cmp(a.created_at, b.created_at) || cmp(a.task_id, b.task_id));
const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Types the digest marks triggered that have no open ledger row, this ritual's own type left out. */
export function proposalTypes(rows: TaskRow[], predictions: Prediction[], now: string): ProposalTypes {
  const open = new Set(predictions.filter((p) => p.closed === null).map((p) => p.type));
  // buildDigest orders types by complaints in the last N, then by key.
  const keys = buildDigest(rows, digestOpts(now)).types.filter((t) => t.trigger && !open.has(t.key) && t.key !== SELF_KEY).map((t) => t.key);
  const newest = new Map<string, string>();
  for (const r of sorted(rows)) {
    const key = typeKey(r);
    if (key) newest.set(key, r.task_id);
  }
  return {
    covered: keys.slice(0, COVERED_MAX).map((key) => ({ key, newestTaskId: newest.get(key) as string })),
    notCovered: keys.slice(COVERED_MAX),
  };
}

/** The description up to the first line that starts a data fence, capped at INSTRUCTION_MAX_CHARS. */
export function instructionText(description: string): string {
  const lines = description.split("\n");
  const fence = lines.findIndex((l) => l.startsWith("⟦BEGIN"));
  const text = (fence === -1 ? description : lines.slice(0, fence).join("\n")).trimEnd();
  const chars = Array.from(text);
  if (chars.length <= INSTRUCTION_MAX_CHARS) return text;
  return `${chars.slice(0, INSTRUCTION_MAX_CHARS).join("")}\n[cut at ${INSTRUCTION_MAX_CHARS.toLocaleString("en-US")} characters: the rest of the instruction text is not shown]`;
}

export interface GuardCandidates {
  /** Finished runs with counts the candidates were computed over, oldest first. */
  runs: number;
  /** Per tool (ascending), its fewest and most calls over those runs; a run without the tool counts 0. */
  ranges: { tool: string; min: number; max: number }[];
  guards: Guard[];
}

/**
 * Over the type's last GUARD_RUNS finished runs whose counts are final (as the
 * ledger judges them: completed_at a second before `now`, `guard_tools`
 * present): every tool with at least one call in each run is a candidate;
 * the read pair as a set when neither qualifies alone but their sum does.
 * NOT_A_GUARD is never one. All candidates are returned; the row takes a few.
 */
export function guardCandidates(rows: TaskRow[], key: string, now: string): GuardCandidates {
  const nowKey = now.slice(0, 19).replace("T", " ");
  const counts = sorted(rows)
    .filter((r) => typeKey(r) === key)
    .filter((r) => FINISHED.has(r.status) && typeof r.completed_at === "string" && cmp(r.completed_at, nowKey) < 0 && typeof r.guard_tools === "string")
    .slice(-GUARD_RUNS)
    .map((r) => toolCounts(r.guard_tools));
  const calls = (c: Record<string, number>, tool: string): number => (Object.hasOwn(c, tool) ? c[tool] : 0);
  const names = [...new Set(counts.flatMap((c) => Object.keys(c)))].sort(cmp);
  const ranges = names.map((tool) => {
    const n = counts.map((c) => calls(c, tool));
    return { tool, min: Math.min(...n), max: Math.max(...n) };
  });
  const guards: Guard[] = [];
  if (counts.length >= GUARD_MIN_RUNS) {
    for (const r of ranges) if (r.min >= 1 && r.tool !== NOT_A_GUARD) guards.push({ tool: r.tool, min: 1, maxBelow: 0 });
    const alone = READ_PAIR.some((t) => ranges.some((r) => r.tool === t && r.min >= 1));
    if (!alone && counts.every((c) => READ_PAIR.reduce((n, t) => n + calls(c, t), 0) >= 1)) {
      guards.push({ tools: [...READ_PAIR], min: 1, maxBelow: 0 });
    }
  }
  return { runs: counts.length, ranges, guards };
}

/**
 * One packet per covered type, in the covered order. `ledgerSrc` is the text
 * `predictions` was parsed from; `types` is proposalTypes of the same inputs.
 */
export function renderPackets(
  rows: TaskRow[],
  predictions: Prediction[],
  ledgerSrc: string,
  newest: Record<string, NewestRun>,
  now: string,
  types: ProposalTypes = proposalTypes(rows, predictions, now),
): { key: string; text: string }[] {
  const ledgerLines = ledgerSrc.split("\n");
  return types.covered.map(({ key, newestTaskId }) => {
    const digest = buildDigest(rows, digestOpts(now, key));
    const t = digest.types[0];
    const out = [`type ${key}  name ${t.name}`, "", "== complaints digest (code output)", renderDigest(digest).trimEnd()];

    out.push("", "== earlier predictions on this type");
    const prior = predictions.filter((p) => p.type === key);
    if (prior.length === 0) out.push("none");
    for (const p of prior) {
      // parseLedger accepted this line, so it parses and `change` is non-empty text.
      const change = (JSON.parse(ledgerLines[p.line - 1]) as { change: string }).change;
      out.push(`- ${p.id}: ${p.closed ? `closed ${p.closed.state}` : "open"}; operator's read: ${p.read ?? "none recorded"}`);
      out.push(`  change: ${collapse(change)}`);
    }

    const run = newest[key];
    out.push("", run?.stored ? "== stored instruction text of the task (the current text; older runs in the digest may have had a different one)" : `== instruction text of the newest run (${newestTaskId.slice(0, 8)}); parts of it are data computed for that run`);
    out.push(run ? instructionText(run.description) : "not available");

    out.push("", "== tools the task is given");
    out.push(!run ? "not available" : run.tools === null ? "no list declared: the run is offered every tool that exists" : run.tools.length === 0 ? "none" : [...run.tools].sort(cmp).join(", "));

    const g = guardCandidates(rows, key, now);
    out.push("", `== calls per run: fewest-most over the last ${g.runs} finished run(s) with counts (calls with no did-not-run gate row)`);
    if (g.runs === 0) out.push("no finished run with counts");
    else if (g.ranges.length === 0) out.push("no tool was called");
    for (const r of g.ranges) out.push(`${r.tool} ${r.min === r.max ? r.min : `${r.min}-${r.max}`}`);

    const ended = t.failed > 0
      ? `${t.concerns} of ${t.runs} runs ended with concerns and ${t.failed} failed`
      : `${t.concerns} of ${t.runs} runs ended with concerns`;
    const lastN = `last ${LAST}: ${t.complaintsLastN} of ${Math.min(t.runs, LAST)}${t.failed > 0 ? " ended with concerns or failed" : ""}`;
    out.push("", "== computed prediction (copy unchanged)", `prediction: ${PREDICTION}`, `baseline: ${ended} in the ${DAYS} days to ${now.slice(0, 10)}; ${lastN}`);

    out.push("", `== guard candidates (computed; a ledger row takes ${GUARDS_PER_ROW} guards: copy the chosen ones unchanged)`);
    if (g.runs < GUARD_MIN_RUNS) out.push(`no guard candidates: fewer than ${GUARD_MIN_RUNS} runs with counts`);
    else if (g.guards.length === 0) out.push("no guard candidates: no tool was called in every one of these runs");
    for (const guard of g.guards) out.push(JSON.stringify(guard));
    return { key, text: `${out.join("\n")}\n` };
  });
}
