/**
 * Complaints digest: per recurring task type (ritual or schedule), how often
 * its runs end with concerns or fail, and the evidence. Pure: rows from
 * COMPLAINTS_SQL (src/complaints/query.ts) in, a digest object out, plus a
 * text renderer. No database, no file system, no clock: `now` is a parameter.
 * Same rows (in any order) and same options give byte-identical output.
 */

/** One task, as COMPLAINTS_SQL returns it through `sqlite3 -json`. */
export interface TaskRow {
  task_id: string;
  status: string;
  /** UTC 'YYYY-MM-DD HH:MM:SS'. */
  created_at: string;
  ritual_id: string | null;
  schedule_id: string | null;
  schedule_name: string | null;
  /** JSON object text, tool name -> calls attempted in this run (tool.called events). */
  tools: string | null;
  /** 1 when the output carries a numbers_audit record. */
  has_audit: number;
  /** JSON array text of numbers_audit.unverified. */
  unverified: string | null;
  concern_detail: string | null;
  reply_tail: string | null;
  /**
   * Short commit id of the build the task ran on; null when unknown. Absent
   * on a database without task_completion_facts: no build is shown then.
   */
  build?: string | null;
}

export interface DigestOptions {
  /** ISO time the window ends at (shown in the header). */
  now: string;
  days: number;
  /** N: the trailing runs the strip and the trigger look at. */
  last: number;
  /** K: complaints among the last N that trigger. */
  min: number;
  /** Only this type key, when set. */
  type?: string;
}

/** Mean calls attempted per run (tool.called events) in clean and concern runs. */
export interface ToolDiff {
  tool: string;
  clean: number;
  concern: number;
}

export interface Evidence {
  date: string;
  id: string;
  source: "concern" | "reply";
  text: string;
  /** The run's build (null when unknown, empty or blank); only when rows carry builds. */
  build?: string | null;
}

export interface TypeDigest {
  key: string;
  name: string;
  runs: number;
  concerns: number;
  failed: number;
  strip: string;
  complaintsLastN: number;
  tooFewRuns: boolean;
  trigger: boolean;
  unverified: {
    runsWithUnverified: number;
    runsWithAudit: number;
    recurring: { figure: string; runs: number }[];
  };
  /** Profile of calls attempted (tool.called events), not of tools that ran. */
  tools: { cleanRuns: number; concernRuns: number; diffs: ToolDiff[] };
  evidence: Evidence[];
  /**
   * Distinct builds among the strip's runs (the last N), oldest first; only
   * when rows carry builds.
   */
  builds?: string[];
  /** Per build, the strip's runs on it and how many show C and F; unknown build (null) last. */
  buildRuns?: BuildRuns[];
}

export interface BuildRuns {
  build: string | null;
  runs: number;
  /** Runs whose strip character is C (ended with concerns). */
  concern: number;
  /** Runs whose strip character is F (failed). concern + failed = the strip's complaints. */
  failed: number;
}

export interface Digest {
  now: string;
  days: number;
  last: number;
  min: number;
  types: TypeDigest[];
}

const CONCERNS = "completed_with_concerns";
const FAILED = "failed";
const CLEAN = "completed";
const MX_OFFSET_MS = 6 * 3600 * 1000;

export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
export const isComplaint = (r: TaskRow): boolean => r.status === CONCERNS || r.status === FAILED;

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function typeKey(r: TaskRow): string | null {
  if (r.ritual_id) return `ritual:${r.ritual_id}`;
  if (r.schedule_id) return `schedule:${r.schedule_id}`;
  return null;
}

export function stripChar(status: string): string {
  if (status === CLEAN) return ".";
  if (status === CONCERNS) return "C";
  if (status === FAILED) return "F";
  return "?";
}

export function toolCounts(r: TaskRow): Record<string, number> {
  const v = parseJson(r.tools);
  const out: Record<string, number> = {};
  if (v === null || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [tool, n] of Object.entries(v)) if (typeof n === "number") out[tool] = n;
  return out;
}

function figures(r: TaskRow): string[] {
  const v = parseJson(r.unverified);
  if (!Array.isArray(v)) return [];
  const set = new Set<string>();
  for (const f of v) {
    if (typeof f !== "string" && typeof f !== "number") continue;
    const s = String(f).trim();
    if (s) set.add(s);
  }
  return [...set];
}

/** Mexico City calendar day (UTC-6, no daylight saving). */
function localDate(createdAt: string): string {
  return new Date(Date.parse(`${createdAt.replace(" ", "T")}Z`) - MX_OFFSET_MS).toISOString().slice(0, 10);
}

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();
/** A run's build as shown: whitespace-collapsed; null, empty or blank is no build. */
export const buildOf = (r: TaskRow): string | null => collapse(r.build ?? "") || null;
const chars = (s: string): string[] => Array.from(s);

export function evidence(r: TaskRow, facts: boolean): Evidence {
  const base = { date: localDate(r.created_at), id: r.task_id.slice(0, 8) };
  const build = facts ? { build: buildOf(r) } : {};
  const concern = collapse(r.concern_detail ?? "");
  if (concern) return { ...base, source: "concern", text: chars(concern).slice(0, 500).join(""), ...build };
  return { ...base, source: "reply", text: chars(collapse(r.reply_tail ?? "")).slice(-500).join(""), ...build };
}

function mean(rows: TaskRow[], counts: Map<TaskRow, Record<string, number>>, tool: string): number {
  let sum = 0;
  for (const r of rows) sum += counts.get(r)?.[tool] ?? 0;
  return sum / rows.length;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

/** The strip's runs grouped by build, first appearance first; the no-build group last. */
function buildRuns(lastRuns: TaskRow[]): BuildRuns[] {
  const groups = new Map<string | null, BuildRuns>();
  for (const r of lastRuns) {
    const build = buildOf(r);
    const g = groups.get(build) ?? { build, runs: 0, concern: 0, failed: 0 };
    g.runs++;
    const c = stripChar(r.status);
    if (c === "C") g.concern++;
    if (c === "F") g.failed++;
    groups.set(build, g);
  }
  const none = groups.get(null);
  groups.delete(null);
  return none ? [...groups.values(), none] : [...groups.values()];
}

function digestType(key: string, runs: TaskRow[], opts: DigestOptions, facts: boolean): TypeDigest {
  const lastRuns = runs.slice(-opts.last);
  const complaintsLastN = lastRuns.filter(isComplaint).length;
  const tooFewRuns = runs.length < opts.last;

  const audited = runs.filter((r) => r.has_audit === 1);
  const figureRuns = new Map<string, number>();
  let runsWithUnverified = 0;
  for (const r of audited) {
    const fs = figures(r);
    if (fs.length > 0) runsWithUnverified++;
    for (const f of fs) figureRuns.set(f, (figureRuns.get(f) ?? 0) + 1);
  }
  const recurring = [...figureRuns]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
    .slice(0, 5)
    .map(([figure, n]) => ({ figure, runs: n }));

  const counts = new Map(runs.map((r) => [r, toolCounts(r)] as const));
  const clean = runs.filter((r) => r.status === CLEAN);
  const concern = runs.filter((r) => r.status === CONCERNS);
  const diffs: (ToolDiff & { d: number })[] = [];
  if (clean.length >= 3 && concern.length >= 3) {
    const names = new Set<string>();
    for (const r of [...clean, ...concern]) for (const t of Object.keys(counts.get(r) ?? {})) names.add(t);
    for (const tool of [...names].sort(cmp)) {
      const c = mean(clean, counts, tool);
      const k = mean(concern, counts, tool);
      // 1e-9 absorbs float noise so a difference of exactly 1.0 counts.
      if (Math.abs(c - k) >= 1 - 1e-9) diffs.push({ tool, clean: round2(c), concern: round2(k), d: Math.abs(c - k) });
    }
    diffs.sort((a, b) => b.d - a.d || cmp(a.tool, b.tool));
  }

  const latest = runs[runs.length - 1];
  return {
    key,
    name: latest.ritual_id ?? latest.schedule_name ?? latest.schedule_id ?? key,
    runs: runs.length,
    concerns: runs.filter((r) => r.status === CONCERNS).length,
    failed: runs.filter((r) => r.status === FAILED).length,
    strip: lastRuns.map((r) => stripChar(r.status)).join(""),
    complaintsLastN,
    tooFewRuns,
    trigger: !tooFewRuns && complaintsLastN >= opts.min,
    unverified: { runsWithUnverified, runsWithAudit: audited.length, recurring },
    tools: {
      cleanRuns: clean.length,
      concernRuns: concern.length,
      diffs: diffs.map(({ tool, clean: c, concern: k }) => ({ tool, clean: c, concern: k })),
    },
    evidence: runs.filter(isComplaint).slice(-3).reverse().map((r) => evidence(r, facts)),
    ...(facts ? factsFields(lastRuns) : {}),
  };
}

function factsFields(lastRuns: TaskRow[]): Pick<TypeDigest, "builds" | "buildRuns"> {
  const per = buildRuns(lastRuns);
  return { builds: per.flatMap((b) => (b.build === null ? [] : [b.build])), buildRuns: per };
}

export function buildDigest(rows: TaskRow[], opts: DigestOptions): Digest {
  // The facts SQL returns a build column on every row (null included); the SQL
  // for an older database has none, and then the output is the same as before.
  const facts = rows.some((r) => r.build !== undefined);
  const sorted = [...rows].sort((a, b) => cmp(a.created_at, b.created_at) || cmp(a.task_id, b.task_id));
  const groups = new Map<string, TaskRow[]>();
  for (const r of sorted) {
    const key = typeKey(r);
    if (key === null || (opts.type && key !== opts.type)) continue;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }
  const types = [...groups]
    .map(([key, runs]) => digestType(key, runs, opts, facts))
    .sort((a, b) => b.complaintsLastN - a.complaintsLastN || cmp(a.key, b.key));
  return { now: opts.now, days: opts.days, last: opts.last, min: opts.min, types };
}

const fmt = (x: number): string => x.toFixed(1);

export function renderDigest(d: Digest): string {
  const out: string[] = [
    `Complaints digest: ${d.days} days to ${d.now}; strip = last ${d.last} runs, oldest left; trigger at ${d.min}/${d.last} concerns+failed`,
    `${d.types.length} recurring type(s); ${d.types.filter((t) => t.trigger).length} triggered`,
  ];
  for (const t of d.types) {
    out.push("", `${t.key}  ${t.name}`);
    out.push(`  runs ${t.runs}  concerns ${t.concerns}  failed ${t.failed}`);
    const trig = t.tooFewRuns ? `no (too few runs: ${t.runs} < ${d.last})` : t.trigger ? "yes" : "no";
    out.push(`  last ${d.last}: [${t.strip}]  complaints ${t.complaintsLastN}/${Math.min(t.runs, d.last)}  TRIGGER ${trig}`);
    const u = t.unverified;
    let line = `  unverified figures: ${u.runsWithUnverified}/${u.runsWithAudit} audited runs`;
    if (u.recurring.length > 0) line += `; recurring: ${u.recurring.map((f) => `${JSON.stringify(f.figure)} x${f.runs}`).join(", ")}`;
    out.push(line);
    if (t.builds && t.buildRuns) {
      const items = t.buildRuns.map(
        (b) => `${b.build ?? "no build"} ${b.runs} run${b.runs === 1 ? "" : "s"} / ${b.concern} concern / ${b.failed} failed`,
      );
      out.push(`  builds, oldest first: ${t.builds.length > 0 ? items.join(" · ") : "none recorded"}`);
    }
    if (t.tools.diffs.length > 0) {
      out.push(`  tools, mean calls attempted per run (clean n=${t.tools.cleanRuns} / concern n=${t.tools.concernRuns}):`);
      for (const x of t.tools.diffs) out.push(`    ${x.tool} ${fmt(x.clean)} / ${fmt(x.concern)}`);
    }
    if (t.evidence.length > 0) {
      out.push("  evidence (newest first):");
      for (const e of t.evidence) {
        const build = e.build === undefined ? "" : ` @${e.build ?? "-"}`;
        out.push(`    ${e.date} ${e.id}${build} [${e.source}] ${e.text}`);
      }
    }
  }
  return `${out.join("\n")}\n`;
}
