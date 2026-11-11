/**
 * ritual_read — read back the full stored text of a ritual or scheduled-task
 * run, or list recent runs with their delivery outcome.
 *
 * Why: ritual and scheduled-report text exists only in the database (the
 * run output envelope). `task_history` returns a 500-character preview,
 * `/rituales completo <id>` covers only held or shortened pushes and is a
 * phone command, and the shell cannot read the database by design. Without
 * this tool the agent cannot show the operator a report it produced.
 *
 * Read-only. Identity of a run: `tasks.metadata.ritualId` (code rituals) or
 * the `schedule:<id>` tag (DB schedules) — the same key the delivery seam
 * writes to `ritual_deliveries.ritual_id`. Text = the latest run's output
 * through `extractDeliverableText` (the extractor `task_history` uses).
 *
 * Size: tool results are capped on the way to the model
 * (MAX_TOOL_RESULT_CHARS — the OpenAI-compat adapter evicts anything longer
 * to a file and shows a 30 % preview). Every result here is built to fit
 * under that cap minus RESULT_HEADROOM (room for the injection banner and
 * outbound scrub); longer texts are paged with `offset` / `nextOffset`.
 */

import { defineTool } from "../define-tool.js";
import { getDatabase } from "../../db/index.js";
import { MAX_TOOL_RESULT_CHARS } from "../../config/constants.js";
import { extractDeliverableText } from "../../lib/deliverable.js";
import { RITUALS_TIMEZONE } from "../../rituals/config.js";
import {
  ensureRitualDeliveriesTable,
  mxDay,
} from "../../rituals/delivery-policy.js";
import { ensureRitualControlTables } from "../../rituals/ritual-controls.js";

const DEFAULT_LIST_LIMIT = 10;
const MAX_LIST_LIMIT = 30;
const DEFAULT_LIST_DAYS = 7;
const DEFAULT_FETCH_DAYS = 30;
const MAX_DAYS = 30;
const DAY_MS = 86_400_000;

/** Chars kept free under the cap for the injection banner + scrub growth. */
export const RESULT_HEADROOM = 1_000;

/** Largest result string this tool returns. */
export function resultBudget(): number {
  return Math.max(1, MAX_TOOL_RESULT_CHARS - RESULT_HEADROOM);
}

interface CandidateRow {
  task_id: string;
  title: string;
  task_status: string;
  created_at: string;
  ritual_key: string;
}

interface RunMeta {
  ritual: string;
  name: string;
  day: string;
  time: string;
  taskId: string;
  status: string;
  delivery: string;
}

// The run key, in SQL so the window filter stays in the database. CASE
// guards json_extract/json_each from a malformed metadata row (they throw).
const candidateSql = (where: string): string => `
  SELECT task_id, title, task_status, created_at, ritual_key FROM (
    SELECT t.id, t.task_id, t.title, t.status AS task_status, t.created_at,
      CASE WHEN json_valid(t.metadata) THEN COALESCE(
        CAST(json_extract(t.metadata, '$.ritualId') AS TEXT),
        (SELECT j.value FROM json_each(t.metadata, '$.tags') j
          WHERE j.value LIKE 'schedule:%' LIMIT 1)
      ) END AS ritual_key
    FROM tasks t
    WHERE ${where}
      AND (t.metadata LIKE '%ritualId%' OR t.metadata LIKE '%schedule:%')
  ) WHERE ritual_key IS NOT NULL AND ritual_key <> ''
  ORDER BY created_at DESC, id DESC`;

function sqlUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function asDate(createdAt: string): Date {
  return new Date(createdAt.replace(" ", "T") + "Z");
}

function mxTime(d: Date): string {
  return d.toLocaleTimeString("en-GB", {
    timeZone: RITUALS_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function isIsoDay(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function loadWindow(fromUtc: string, toUtc: string): CandidateRow[] {
  return getDatabase()
    .prepare(candidateSql("t.created_at >= @from AND t.created_at < @to"))
    .all({ from: fromUtc, to: toUtc }) as CandidateRow[];
}

function loadTask(taskId: string): CandidateRow | undefined {
  return getDatabase()
    .prepare(candidateSql("t.task_id = @taskId"))
    .get({ taskId }) as CandidateRow | undefined;
}

function latestRun(
  taskId: string,
): { status: string; output: string | null } | undefined {
  return getDatabase()
    .prepare(
      "SELECT status, output FROM runs WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .get(taskId) as { status: string; output: string | null } | undefined;
}

/** Delivery outcome from the seam's ledger; "capped" deferral = shortened push. */
function deliveryLabel(taskId: string): string {
  const db = getDatabase();
  const d = db
    .prepare(
      "SELECT delivered, reason FROM ritual_deliveries WHERE task_id = ? ORDER BY id DESC LIMIT 1",
    )
    .get(taskId) as { delivered: number; reason: string } | undefined;
  if (!d) return "sin registro";
  if (d.delivered === 1) {
    const capped = db
      .prepare(
        "SELECT 1 FROM ritual_deferrals WHERE task_id = ? AND reason = 'capped' LIMIT 1",
      )
      .get(taskId);
    return capped ? "acortado" : "enviado";
  }
  if (d.reason === "budget" || d.reason === "muted") return "diferido";
  if (d.reason === "suppressed") return "no enviado (suprimido)";
  return `no enviado (${d.reason})`;
}

/**
 * The human-readable text of a stored run output, or why there is none.
 * Same extraction as task_history; a legacy plain-text row is the text, a
 * malformed JSON record is never returned raw.
 */
function storedText(
  output: string | null | undefined,
): { text: string } | { problem: string } {
  if (output == null || output.trim() === "") {
    return { problem: "This run stored no output." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    const trimmed = output.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      return { problem: "This run's stored output is malformed and cannot be read." };
    }
    return { text: trimmed };
  }
  const text = extractDeliverableText(parsed);
  return text
    ? { text }
    : { problem: "This run's stored output has no text (the run produced no report)." };
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

/** `s` cut to `max` chars (never mid surrogate pair), "…" marking the cut. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const end = isHighSurrogate(s.charCodeAt(max - 1)) ? max - 1 : max;
  return `${s.slice(0, end)}…`;
}

/** Task titles are display names; a pathological one must not eat the result budget. */
const NAME_MAX = 200;
/** Caller-supplied strings echoed back in an error. */
const ECHO_MAX = 100;

function metaFor(row: CandidateRow, runStatus: string | undefined): RunMeta {
  const at = asDate(row.created_at);
  return {
    ritual: row.ritual_key,
    name: clip(row.title, NAME_MAX),
    day: mxDay(at),
    time: mxTime(at),
    taskId: row.task_id,
    status: runStatus ?? row.task_status,
    delivery: deliveryLabel(row.task_id),
  };
}

/** Distinct ritual keys, newest first, named by their newest run's title. */
function ritualsIn(rows: CandidateRow[]): Array<{ ritual: string; name: string }> {
  const seen = new Map<string, string>();
  for (const r of rows) if (!seen.has(r.ritual_key)) seen.set(r.ritual_key, clip(r.title, NAME_MAX));
  return [...seen].map(([ritual, name]) => ({ ritual, name }));
}

/**
 * `build(n)` for the largest n ≤ items that fits resultBudget() (at least
 * 1): a list result obeys the same cap as a text page.
 */
function fitting(items: number, build: (n: number) => string): string {
  let n = items;
  let out = build(n);
  while (out.length > resultBudget() && n > 1) {
    n -= 1;
    out = build(n);
  }
  return out;
}

function substringHit(row: CandidateRow, q: string): boolean {
  return (
    row.ritual_key.toLowerCase().includes(q) ||
    row.title.toLowerCase().includes(q)
  );
}

/**
 * One page of `text` from `offset`, as the final JSON string, never longer
 * than resultBudget(). JSON escaping makes the encoded length
 * data-dependent (a control character encodes as 6 chars), so the slice
 * shrinks in proportion to the overflow until it fits — subtracting the
 * overflow instead collapses an escape-heavy page to one character. A page
 * always advances by at least one whole code point and never ends between
 * the two halves of a surrogate pair.
 */
function pageResult(
  base: Record<string, unknown>,
  text: string,
  offset: number,
): string {
  const budget = resultBudget();
  const minEnd = Math.min(
    text.length,
    offset + (isHighSurrogate(text.charCodeAt(offset)) ? 2 : 1),
  );
  let end = Math.max(minEnd, Math.min(text.length, offset + budget));
  for (;;) {
    if (end < text.length && end > minEnd && isHighSurrogate(text.charCodeAt(end - 1))) {
      end -= 1;
    }
    const out = JSON.stringify({
      ...base,
      totalChars: text.length,
      offset,
      nextOffset: end < text.length ? end : null,
      text: text.slice(offset, end),
    });
    if (out.length <= budget || end <= minEnd) return out;
    end = Math.max(minEnd, offset + Math.floor(((end - offset) * budget) / out.length));
  }
}

function fetchRun(
  row: CandidateRow,
  offset: number,
  otherRunsSameDay: number,
): string {
  const run = latestRun(row.task_id);
  const meta = metaFor(row, run?.status);
  const base = { mode: "fetch", ...meta, otherRunsSameDay };
  const got = storedText(run?.output);
  if ("problem" in got) return JSON.stringify({ ...base, error: got.problem });
  if (offset > 0 && offset >= got.text.length) {
    return JSON.stringify({
      ...base,
      totalChars: got.text.length,
      error: `offset ${offset} is past the end of the text (totalChars ${got.text.length}).`,
    });
  }
  return pageResult(base, got.text, offset);
}

function numArg(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}

export const ritualReadTool = defineTool({
  name: "ritual_read",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  description: `Read back the FULL stored text of a ritual or scheduled report, or list recent runs. The only tool that returns a ritual run's stored text in full: task_history shows 500 characters; shell_exec cannot read the database. Text = the run's own stored output, in full; delivery-time additions and (sin verificar) marks are not in it.

USE WHEN:
- The operator asks to see, read back, resend or quote a ritual, a briefing, a nightly close or a scheduled report
- You need the exact text of a report that was shortened, deferred or never pushed

DO NOT USE WHEN:
- The task was not a ritual or scheduled run — use task_history

List (no ritual/task_id, or list:true): newest first, rows {ritual, name, day, time (Mexico City), taskId, status, delivery, chars}, no text.
Fetch (ritual or task_id): one run's text + the same fields. Several rituals match → no text; pick an id from candidates. No match → error + the ritual ids seen in the window. Several runs that day → the latest; otherRunsSameDay counts the rest.

delivery: 'enviado' (pushed; an emailed or word-capped push may have been shortened) | 'acortado' (pushed shortened) | 'diferido' (held: mute or budget) | 'no enviado (suprimido)' (never pushed by design) | 'no enviado (<reason>)' | 'sin registro' (no delivery decision).

Long texts are paged: while nextOffset is a number, call again with the same task_id and offset=nextOffset; totalChars is the full length. Quote the text as returned; never fill a gap from memory.`,
  parameters: {
    type: "object",
    properties: {
      ritual: {
        type: "string",
        description:
          "Ritual id or part of its name, case-insensitive. Exact id first ('nightly-close', 'signal-intelligence', 'schedule:<id>'), else a substring of an id or run title ('morning sync', 'posthumanismo'). Omit to list.",
      },
      date: {
        type: "string",
        description:
          "Mexico City day YYYY-MM-DD, e.g. '2026-11-10'. Fetch: that day's latest run of the ritual. List: only that day. Omit for the latest run.",
      },
      task_id: {
        type: "string",
        description:
          "Exact task id of one run (from a list row or an earlier result). Takes precedence over ritual; use it when paging.",
      },
      list: {
        type: "boolean",
        description:
          "true = list runs without text, filtered by ritual (substring) and date when given. Default false.",
      },
      limit: {
        type: "number",
        description: "List rows to return, newest first (default 10, max 30).",
      },
      days: {
        type: "number",
        description:
          "Look-back window in days, max 30 (list default 7, fetch default 30). Ignored when date is set.",
      },
      offset: {
        type: "number",
        description:
          "Character offset into the text; pass the previous result's nextOffset to get the next page. Default 0.",
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const ritual = typeof args.ritual === "string" ? args.ritual.trim() : "";
    const taskId = typeof args.task_id === "string" ? args.task_id.trim() : "";
    const date = typeof args.date === "string" ? args.date.trim() : "";
    // One list flag everywhere: only boolean true lists ({list:"true", task_id}
    // is a fetch by task_id).
    const listFlag = args.list === true;
    const listMode = listFlag || (ritual === "" && taskId === "");
    const offset = numArg(args.offset) ?? 0;

    if (date !== "" && !isIsoDay(date)) {
      return JSON.stringify({ error: `date must be YYYY-MM-DD (Mexico City day), got "${clip(date, ECHO_MAX)}".` });
    }
    if (offset < 0) {
      return JSON.stringify({ error: "offset must be 0 or a previous nextOffset." });
    }

    try {
      ensureRitualDeliveriesTable();
      ensureRitualControlTables();

      if (taskId !== "" && !listFlag) {
        const row = loadTask(taskId);
        if (!row) {
          return JSON.stringify({
            error: `No ritual or scheduled-task run has task id "${clip(taskId, ECHO_MAX)}". For other tasks use task_history.`,
          });
        }
        const sameDay = loadWindow(
          sqlUtc(new Date(asDate(row.created_at).getTime() - DAY_MS)),
          sqlUtc(new Date(asDate(row.created_at).getTime() + DAY_MS)),
        ).filter(
          (r) =>
            r.ritual_key === row.ritual_key &&
            mxDay(asDate(r.created_at)) === mxDay(asDate(row.created_at)),
        );
        return fetchRun(row, offset, Math.max(0, sameDay.length - 1));
      }

      // Window: the asked MX day (±1 UTC day, filtered exactly below), else
      // the last `days` days.
      let rows: CandidateRow[];
      let windowLabel: { date: string } | { days: number };
      if (date !== "") {
        const midnight = Date.parse(`${date}T00:00:00Z`);
        rows = loadWindow(
          sqlUtc(new Date(midnight - DAY_MS)),
          sqlUtc(new Date(midnight + 2 * DAY_MS)),
        ).filter((r) => mxDay(asDate(r.created_at)) === date);
        windowLabel = { date };
      } else {
        const days = Math.min(
          Math.max(numArg(args.days) ?? (listMode ? DEFAULT_LIST_DAYS : DEFAULT_FETCH_DAYS), 1),
          MAX_DAYS,
        );
        const now = Date.now();
        rows = loadWindow(sqlUtc(new Date(now - days * DAY_MS)), sqlUtc(new Date(now + DAY_MS)));
        windowLabel = { days };
      }

      if (listMode) {
        const q = ritual.toLowerCase();
        const matched = q === "" ? rows : rows.filter((r) => substringHit(r, q));
        const limit = Math.min(
          Math.max(numArg(args.limit) ?? DEFAULT_LIST_LIMIT, 1),
          MAX_LIST_LIMIT,
        );
        const runs = matched.slice(0, limit).map((r) => {
          const run = latestRun(r.task_id);
          const got = storedText(run?.output);
          return {
            ...metaFor(r, run?.status),
            chars: "text" in got ? got.text.length : 0,
          };
        });
        return fitting(runs.length, (n) =>
          JSON.stringify({
            mode: "list",
            window: windowLabel,
            ...(ritual !== "" ? { ritualFilter: clip(ritual, ECHO_MAX) } : {}),
            returned: n,
            total: matched.length,
            runs: runs.slice(0, n),
          }),
        );
      }

      // Fetch by ritual: exact id first, then case-insensitive substring.
      const q = ritual.toLowerCase();
      const exact = rows.filter(
        (r) => r.ritual_key === ritual || r.ritual_key === `schedule:${ritual}`,
      );
      const hits = exact.length > 0 ? exact : rows.filter((r) => substringHit(r, q));
      const keys = ritualsIn(hits);
      const echo = clip(ritual, ECHO_MAX);
      if (keys.length === 0) {
        const seen = ritualsIn(rows);
        return fitting(seen.length, (n) =>
          JSON.stringify({
            error: `No ritual or scheduled run matches "${echo}" in this window. Pick an id from rituals, or widen days / change date.`,
            window: windowLabel,
            ritualsTotal: seen.length,
            rituals: seen.slice(0, n),
          }),
        );
      }
      if (keys.length > 1) {
        return fitting(keys.length, (n) =>
          JSON.stringify({
            error: `"${echo}" matches ${keys.length} rituals. Call again with one exact id from candidates.`,
            window: windowLabel,
            candidates: keys.slice(0, n),
          }),
        );
      }
      const chosen = hits[0];
      const chosenDay = mxDay(asDate(chosen.created_at));
      const others = hits.filter(
        (r) => r !== chosen && mxDay(asDate(r.created_at)) === chosenDay,
      ).length;
      return fetchRun(chosen, offset, others);
    } catch (err) {
      // No stack, no SQL text to the model; the journal keeps the detail.
      console.error("[ritual_read] failed:", err);
      return JSON.stringify({ error: "Could not read the ritual records right now." });
    }
  },
});
