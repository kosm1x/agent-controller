/**
 * Stalled-project detector — the work-truth detector.
 *
 * Operator ruling (2026-06-23): the Telegram day-log is the ONLY record of work
 * done. NorthStar is a stale compass of visions/goals, not advancement; the
 * task table is not the day-log either. So this detector grounds "is a project
 * moving?" in the day-log (`jarvis_files` path `logs/day-logs/YYYY-MM-DD.md`,
 * written verbatim on every Telegram exchange) cross-referenced against the
 * active-project list (`projects` table). A project not mentioned in the
 * day-log for more than the stale window is flagged `stalled_project`.
 *
 * This replaces the retired NorthStar `dormant_objective` + task-table
 * `stalled_task`/`implicit_deadline`/`recurring_blocker` detectors as the
 * production signal source (see src/detection/index.ts).
 *
 * Matching is heuristic — the day-log is free-text dialogue, not project-tagged.
 * A project counts as "mentioned" only on a fairly DISTINCTIVE match: its slug,
 * its slug-spaced form, its full name, or a distinctive token (length ≥ 6, not a
 * generic word). The bias is deliberately toward FLAGGING — so the failure mode
 * is a false-POSITIVE (a project discussed only by an unlisted nickname looks
 * quiet) which the operator simply dismisses. The UNSAFE direction is the
 * inverse: a coincidental common word ("data", "salon", "voice") matching and
 * thereby SUPPRESSING a real stall — which is exactly why bare short/generic
 * tokens are excluded (they also collide across projects, e.g.
 * salon-voice-outreach vs salones-wa). Tighten precision by adding alias terms
 * to `projects.config` over time.
 */

import { getDatabase } from "../db/index.js";
import type Database from "better-sqlite3";
import type { StalledProjectSignal } from "./signals.js";

/** A project unmentioned in the day-log longer than this is "stalled". */
const STALE_DAYS = 7;
/** How many days of day-logs to load when computing days-since-mention. */
const SCAN_WINDOW_DAYS = 30;
const MS_PER_DAY = 86_400_000;
/** Tokens shorter than this collide across projects ("data","plan","salon",
 *  "voice","local","brain") and coincidentally match unrelated day-log text,
 *  suppressing real stalls — so only longer, distinctive tokens count. */
const MIN_TOKEN_LEN = 6;
/** Generic ≥6-char words shared across many projects — excluded so they can't
 *  mask a stall by coincidental match. */
const COMMON_TOKENS = new Set([
  "agente",
  "studio",
  "sistema",
  "proyecto",
  "project",
  "personal",
  "branding",
  "intelligence",
  "general",
  "content",
  "analysis",
]);

interface ProjectRow {
  slug: string;
  name: string;
}
interface DayLogRow {
  /** `logs/day-logs/YYYY-MM-DD.md` */
  path: string;
  content: string;
}

const DATE_IN_PATH = /logs\/day-logs\/(\d{4}-\d{2}-\d{2})\.md$/;

/** Match terms for a project: slug, full name, and significant name tokens, all
 *  lower-cased. The slug ("salones-wa") and a tokenized name ("salones") give
 *  two independent shots at a free-text mention. */
function matchTermsFor(p: ProjectRow): string[] {
  const terms = new Set<string>();
  const slug = p.slug.toLowerCase().trim();
  const name = p.name.toLowerCase().trim();
  // Distinctive whole-identity terms (precise, no cross-project collision).
  if (slug) {
    terms.add(slug); // "salones-wa"
    terms.add(slug.replace(/[-_]+/g, " ")); // "salones wa"
  }
  if (name) terms.add(name); // "salones wa"
  // Distinctive single tokens only (len >= MIN_TOKEN_LEN, not generic) — keeps
  // "salones"/"pipesong"/"outreach"; drops "data"/"salon"/"voice"/"intelligence".
  for (const tok of `${name} ${slug}`.split(/[^a-z0-9áéíóúñ]+/i)) {
    const t = tok.toLowerCase();
    if (t.length >= MIN_TOKEN_LEN && !COMMON_TOKENS.has(t)) terms.add(t);
  }
  return [...terms];
}

function daysBetween(aIso: string, bIso: string): number {
  const a = Date.parse(aIso + "T00:00:00Z");
  const b = Date.parse(bIso + "T00:00:00Z");
  return Math.round((a - b) / MS_PER_DAY);
}

/**
 * Detect active projects that have gone quiet in the day-log.
 *
 * @param staleDays - flag projects unmentioned for more than this many days.
 * @param db - injectable for tests.
 */
export function detectStalledProjects(
  staleDays: number = STALE_DAYS,
  db: Database.Database = getDatabase(),
): StalledProjectSignal[] {
  const projects = db
    .prepare(`SELECT slug, name FROM projects WHERE status = 'active'`)
    .all() as ProjectRow[];
  if (projects.length === 0) return [];

  const logs = db
    .prepare(
      `SELECT path, content FROM jarvis_files
        WHERE path LIKE 'logs/day-logs/%'
        ORDER BY path DESC
        LIMIT ?`,
    )
    .all(SCAN_WINDOW_DAYS) as DayLogRow[];
  if (logs.length === 0) return []; // no day-log to judge against — say nothing

  // Reference "today" = the newest day-log present (sidesteps wall-clock tz).
  const dated = logs
    .map((l) => ({
      date: DATE_IN_PATH.exec(l.path)?.[1] ?? null,
      content: l.content.toLowerCase(),
    }))
    .filter((l): l is { date: string; content: string } => l.date !== null)
    .sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first
  if (dated.length === 0) return [];
  const latestDate = dated[0].date;

  const signals: StalledProjectSignal[] = [];
  for (const p of projects) {
    const terms = matchTermsFor(p);
    // newest day-log (already sorted desc) that mentions any term
    const hit = dated.find((d) => terms.some((t) => d.content.includes(t)));
    const daysSinceMention = hit ? daysBetween(latestDate, hit.date) : null;
    if (daysSinceMention !== null && daysSinceMention <= staleDays) continue;

    signals.push({
      kind: "stalled_project",
      severity: "info",
      summary:
        daysSinceMention === null
          ? `Project "${p.name}" not mentioned in the day-log in the last ${SCAN_WINDOW_DAYS}d`
          : `Project "${p.name}" last mentioned in the day-log ${daysSinceMention}d ago`,
      slug: p.slug,
      name: p.name,
      daysSinceMention,
    });
  }
  return signals;
}
