/**
 * S6 WS2 — which project a new task belongs to (spec
 * docs/planning/s6-project-contract-spec-2026-10-11.md §4, ruling 3c).
 *
 * `resolveProjectAttribution` is PURE: first match wins, in this order —
 *   1. schedule — the run's origin schedule row carries `project_slug`
 *      (projected from the record's `schedules`, `./projector.ts`).
 *   2. parent   — a sub-task inherits the parent's slug AND source.
 *   3. ritual   — `RITUAL_PROJECT[ritualId]` (`rituals/config.ts`; empty today).
 *   4. inbound  — the jarvis-pull seam names a slug (no producer until WS4/WS7).
 *   5. chat     — the chat detector named a project (explicit mention).
 *   6. thread   — inherited from the thread's last EXPLICIT mention (`chat`)
 *                 within CHAT_THREAD_WINDOW_MS; never from another inherited
 *                 row, so the window cannot renew itself.
 *   null        — operator-level work.
 * `classifier` is a declared value with NO producer: no record maps a scope
 * group to a slug yet (spec §3).
 *
 * `attributeNewTask` is the thin db adapter the dispatcher calls once, before
 * its INSERT; it validates every resolved slug against `projects`
 * (`canonicalProjectSlug`). The columns are written by that INSERT only —
 * never updated.
 */

import type Database from "better-sqlite3";
import { errMsg } from "../lib/err-msg.js";
import { createLogger } from "../lib/logger.js";
import { RITUAL_PROJECT } from "../rituals/config.js";

const log = createLogger("attribution");

export const PROJECT_SOURCES = [
  "schedule",
  "parent",
  "ritual",
  "inbound",
  "chat",
  "thread",
  "classifier",
] as const;
export type ProjectSource = (typeof PROJECT_SOURCES)[number];

export interface ProjectAttribution {
  slug: string;
  source: ProjectSource;
}

/** How long a chat thread keeps the project its last explicit mention named. */
export const CHAT_THREAD_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface AttributionInput {
  /** `scheduled_tasks.project_slug` of the origin schedule; null when there is none or it is unclaimed. */
  scheduleSlug: string | null;
  /** The parent row's columns; null when the task has no parent (or the row is gone). */
  parent: { slug: string | null; source: string | null } | null;
  ritualId?: string;
  ritualProjects: Readonly<Record<string, string>>;
  /** A slug the submitter named: the chat detector or the jarvis-pull seam. */
  submitted?: { slug?: string; source?: "inbound" | "chat" };
  /** The newest explicit mention (`project_source = 'chat'`) on the same chat thread. */
  thread: { slug: string; createdAtMs: number } | null;
  nowMs: number;
}

const isProjectSource = (s: unknown): s is ProjectSource =>
  typeof s === "string" && (PROJECT_SOURCES as readonly string[]).includes(s);

/** First match wins (module head). Pure. */
export function resolveProjectAttribution(
  input: AttributionInput,
): ProjectAttribution | null {
  if (input.scheduleSlug) return { slug: input.scheduleSlug, source: "schedule" };
  if (input.parent?.slug) {
    return {
      slug: input.parent.slug,
      source: isProjectSource(input.parent.source) ? input.parent.source : "parent",
    };
  }
  const ritualSlug = input.ritualId ? input.ritualProjects[input.ritualId] : undefined;
  if (ritualSlug) return { slug: ritualSlug, source: "ritual" };
  const named = input.submitted?.slug;
  if (named && input.submitted?.source === "inbound") return { slug: named, source: "inbound" };
  if (named && input.submitted?.source === "chat") return { slug: named, source: "chat" };
  if (input.thread && input.nowMs - input.thread.createdAtMs <= CHAT_THREAD_WINDOW_MS) {
    return { slug: input.thread.slug, source: "thread" };
  }
  return null;
}

/** SQLite `datetime()` text (UTC, no zone) → epoch ms. */
const sqliteMs = (s: string): number => Date.parse(`${s.replace(" ", "T")}Z`);
/** epoch ms → SQLite `datetime()` text. */
const sqliteText = (ms: number): string =>
  new Date(ms).toISOString().replace("T", " ").slice(0, 19);

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

export interface NewTaskFacts {
  /** The run's origin schedule id (dispatcher `gateContextFor` → `originScheduleId`). */
  originScheduleId?: string;
  parentTaskId?: string;
  ritualId?: string;
  threadId?: string;
  projectSlug?: string;
  projectSource?: "inbound" | "chat";
}

/** One lookup's failure is logged and read as "no value"; the next source still resolves. */
function lookup<T>(source: string, fallback: T, read: () => T): T {
  try {
    return read();
  } catch (err) {
    log.warn({ source, err: errMsg(err) }, "attribution lookup failed — source skipped");
    return fallback;
  }
}

/** Read the inputs the resolver needs — only the lookups the facts call for. */
export function readAttributionInput(
  db: Database.Database,
  facts: NewTaskFacts,
  nowMs = Date.now(),
): AttributionInput {
  const scheduleSlug = !facts.originScheduleId
    ? null
    : lookup("schedule", null, () => {
        const row = db
          .prepare("SELECT project_slug FROM scheduled_tasks WHERE schedule_id = ?")
          .get(facts.originScheduleId) as { project_slug?: unknown } | undefined;
        return str(row?.project_slug);
      });
  const parent: AttributionInput["parent"] = !facts.parentTaskId
    ? null
    : lookup("parent", null, () => {
        const row = db
          .prepare("SELECT project_slug, project_source FROM tasks WHERE task_id = ?")
          .get(facts.parentTaskId) as
          | { project_slug?: unknown; project_source?: unknown }
          | undefined;
        return row ? { slug: str(row.project_slug), source: str(row.project_source) } : null;
      });
  // Only explicit mentions (`chat`) feed the fallback: an inherited
  // (`thread`) row never renews the window. Bounded by the 24 h predicate
  // and LIMIT 1; no index.
  const thread: AttributionInput["thread"] =
    !facts.threadId || facts.projectSlug
      ? null
      : lookup("thread", null, () => {
          const row = db
            .prepare(
              `SELECT project_slug, created_at FROM tasks
                WHERE project_source = 'chat' AND project_slug IS NOT NULL AND created_at >= ?
                  AND json_valid(metadata) AND json_extract(metadata, '$.threadId') = ?
                ORDER BY created_at DESC, id DESC LIMIT 1`,
            )
            .get(sqliteText(nowMs - CHAT_THREAD_WINDOW_MS), facts.threadId) as
            | { project_slug?: unknown; created_at?: unknown }
            | undefined;
          const slug = str(row?.project_slug);
          const at = str(row?.created_at);
          return slug && at ? { slug, createdAtMs: sqliteMs(at) } : null;
        });
  return {
    scheduleSlug,
    parent,
    ritualId: facts.ritualId,
    ritualProjects: RITUAL_PROJECT,
    submitted: facts.projectSlug
      ? { slug: facts.projectSlug, source: facts.projectSource }
      : undefined,
    thread,
    nowMs,
  };
}

/** Sources that name a project from words (chat, its thread, an inbound
 *  caller): they bind only to a live (active/paused) row. A record's own
 *  claims (schedule, parent, ritual) keep any status. */
const LIVE_ONLY_SOURCES: ReadonlySet<ProjectSource> = new Set(["chat", "thread", "inbound"]);
const LIVE = (status: string | null) =>
  ["active", "paused"].includes((status ?? "active").toLowerCase());

/**
 * The `projects` slug a resolved slug stands for. An exact `projects.slug`
 * match wins (for a LIVE_ONLY source the row must be active/paused, else
 * null). Otherwise the ACTIVE/PAUSED rows whose alias equals
 * (case-insensitive) a PHRASE of the slug (itself, or with spaces for
 * hyphens) win over rows matching one of its hyphen-separated WORDS; within
 * the winning rank exactly one row resolves, a tie is null (logged with the
 * row slugs). Else null. The chat detector returns KB folder names
 * (`williams-radar`) that are not row slugs.
 */
export function canonicalProjectSlug(
  db: Database.Database,
  slug: string,
  source: ProjectSource,
): string | null {
  const exact = db.prepare("SELECT slug, status FROM projects WHERE slug = ?").get(slug) as
    | { slug: string; status: string | null }
    | undefined;
  if (exact) return !LIVE_ONLY_SOURCES.has(source) || LIVE(exact.status) ? exact.slug : null;
  const norm = (k: string) => k.trim().toLowerCase();
  const phrases = new Set([slug, slug.replace(/-/g, " ")].map(norm));
  const keys = [...new Set([...phrases, ...slug.split("-").map(norm)])].filter((k) => k.length > 0);
  const rows = db
    .prepare(
      `SELECT DISTINCT p.slug, lower(trim(a.value)) AS alias FROM projects p, json_each(p.config, '$.aliases') a
        WHERE json_valid(p.config) AND json_type(p.config, '$.aliases') = 'array'
          AND lower(COALESCE(p.status, 'active')) IN ('active', 'paused')
          AND a.type = 'text' AND lower(trim(a.value)) IN (${keys.map(() => "?").join(", ")})
        ORDER BY p.slug`,
    )
    .all(...keys) as Array<{ slug: string; alias: string }>;
  const phraseRows = [...new Set(rows.filter((r) => phrases.has(r.alias)).map((r) => r.slug))];
  const best = phraseRows.length > 0 ? phraseRows : [...new Set(rows.map((r) => r.slug))];
  if (best.length === 1) return best[0]!;
  if (best.length > 1) {
    log.warn({ slug, matches: best }, "attribution alias tie — unattributed");
  }
  return null;
}

/**
 * The dispatcher's one call, before its INSERT. A failed lookup skips only
 * its own source; the resolved slug is validated against `projects` (an
 * unknown slug is never stored).
 */
export function attributeNewTask(
  db: Database.Database,
  facts: NewTaskFacts,
  nowMs = Date.now(),
): ProjectAttribution | null {
  const resolved = resolveProjectAttribution(readAttributionInput(db, facts, nowMs));
  if (!resolved) return null;
  const slug = lookup("validate", null, () =>
    canonicalProjectSlug(db, resolved.slug, resolved.source),
  );
  return slug ? { slug, source: resolved.source } : null;
}
