/**
 * NorthStar Sync — true 2-way LWW + tombstone-based delete propagation.
 *
 * Record identity: COMMIT UUID (embedded in file content as `COMMIT_ID: <uuid>`).
 * Journal: `northstar_sync_state` — remembers every record we've seen, so we can
 * distinguish "never existed" from "was deleted on one side."
 *
 * Unsynced-edit detection:
 *   - COMMIT side: `modified_by == "user"` means the last writer was the app, not
 *     our sync. Triggers on the COMMIT tables auto-bump `last_edited_at` on any
 *     PATCH, so we can't compare timestamps alone; `modified_by` is the gate.
 *   - Jarvis side: `jarvis_files.user_edit_time` is bumped only by real file
 *     edits (file_write/file_edit/jarvis_file_update), never by sync upserts.
 *
 * Bootstrap (empty journal): propagate both directions to union, no deletes.
 * Subsequent runs: full LWW — latest wins for updates AND deletes. Always.
 */

import type { Tool } from "../types.js";
import {
  upsertFile,
  getFile,
  deleteFile,
  listFiles,
} from "../../db/jarvis-fs.js";
import { getDatabase } from "../../db/index.js";
import {
  renderCompassIndex,
  type IndexKind,
  type IndexLocalEntry,
  type IndexCommitItem,
} from "./northstar-index.js";

const BASE_URL = "https://db.mycommit.net/rest/v1";
const USER_ID = "a8ad98e1-b9c6-4447-ab80-bac467835b3a";
const TIMEOUT_MS = 15_000;

// Module-level reentrancy guard — prevents concurrent invocations from racing
// on the journal. Cleared in the finally block of execute().
let syncInFlight = false;

type Kind = "vision" | "goal" | "objective" | "task";

const KIND_TO_TABLE: Record<Kind, string> = {
  vision: "visions",
  goal: "goals",
  objective: "objectives",
  task: "tasks",
};
const KIND_TO_PATH: Record<Kind, string> = {
  vision: "NorthStar/visions",
  goal: "NorthStar/goals",
  objective: "NorthStar/objectives",
  task: "NorthStar/tasks",
};
const KINDS: Kind[] = ["vision", "goal", "objective", "task"];

/** Columns each table accepts on PATCH (superset of fields we extract from files). */
const PUSH_FIELDS: Record<Kind, string[]> = {
  vision: ["title", "description", "status", "target_date"],
  goal: ["title", "description", "status", "target_date"],
  objective: ["title", "description", "status", "priority", "target_date"],
  task: ["title", "description", "status", "priority", "due_date", "notes"],
};

/**
 * Fields that can legitimately be null on COMMIT — removing the line from a
 * local file means "clear this value" and we push `null`. `title` and `status`
 * are NOT in this set: a record can't meaningfully exist without them, so if
 * the user deletes those lines we preserve whatever was there.
 */
const CLEARABLE_FIELDS: ReadonlySet<string> = new Set([
  "priority",
  "description",
  "notes",
  "target_date",
  "due_date",
]);

interface CommitItem {
  id: string;
  title: string;
  status: string;
  description: string | null;
  priority?: string | null;
  target_date?: string | null;
  due_date?: string | null;
  notes?: string | null;
  vision_id?: string | null;
  goal_id?: string | null;
  objective_id?: string | null;
  updated_at: string;
  last_edited_at: string;
  modified_by: string;
}

interface SyncStateRow {
  commit_id: string;
  kind: Kind;
  local_path: string;
  last_commit_edited_at: string | null;
  last_local_edit_time: string | null;
  last_sync_at: string;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

/**
 * Derive a collision-proof local path. Format: `{base}/{slug}--{id8}.md`.
 * The 8-char UUID prefix disambiguates same-title records — shipped once
 * without this and a title collision caused spurious deletes.
 */
function buildLocalPath(basePath: string, id: string, title: string): string {
  return `${basePath}/${slugify(title)}--${id.slice(0, 8)}.md`;
}

/**
 * Parse any supported timestamp (PostgREST ISO `2026-04-20T00:00:00Z` or
 * SQLite `datetime('now')` `"2026-04-20 00:00:00"`) to epoch ms. NaN when
 * parsing fails (NULL/undefined/garbage), which sorts as "older than anything"
 * in Math.max / `>` comparisons — the conservative default.
 */
function ts(s: string | null | undefined): number {
  if (!s) return 0;
  const t = Date.parse(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  return Number.isNaN(t) ? 0 : t;
}

/**
 * True when `s` is a value PostgreSQL's `date` type will accept: `YYYY-MM-DD`
 * or full ISO 8601 datetime. Rejects user-typed sentinels ("none", "TBD",
 * "pending", "-", "n/a") that would trigger PG `22007 invalid_datetime_format`
 * and brick the entire sync run for every record on that table.
 *
 * Also rejects calendar-impossible dates like `2026-02-30` that `Date.parse`
 * silently rolls over (→ March 2). Those would pass the regex and `Date.parse`
 * but PG rejects with `22008 datetime_field_overflow` — same brick, narrower
 * trigger.
 */
function isValidDateValue(s: string | null | undefined): boolean {
  if (!s) return false;
  const trimmed = s.trim();
  if (!trimmed) return false;
  // Require a leading 4-digit year + month/day separator. Cheap pre-check that
  // rejects "none"/"TBD"/"-" without falling through to Date.parse, which is
  // permissive enough to coerce things like "1" into a valid date.
  if (!/^\d{4}-\d{2}-\d{2}([T ]|$)/.test(trimmed)) return false;
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return false;
  // Reject silent rollovers (`2026-02-30` → `2026-03-02`). The first 10 chars
  // of the input are the user's claimed Y-M-D; round-trip through UTC and
  // compare. UTC is correct here because PG `date` has no timezone.
  return new Date(parsed).toISOString().slice(0, 10) === trimmed.slice(0, 10);
}

/**
 * Strip `Due: <non-date>` and `Target: <non-date>` lines from local file
 * content. Idempotent. Returns the cleaned content + a list of stripped
 * fields for operator visibility.
 *
 * Rationale: the strict mirror invariant requires that local files contain
 * only values that COMMIT will accept. Sentinels like `Due: none` would be
 * silently dropped from the POST/PATCH payload but live on in the file
 * forever — the next sync can't reconcile a value that exists locally but
 * not remotely. Removing the line on the local side closes the gap.
 */
function sanitizeLocalContent(content: string): {
  sanitized: string;
  changed: boolean;
  stripped: string[];
} {
  const stripped: string[] = [];
  const out: string[] = [];
  for (const line of content.split("\n")) {
    const m = line.match(/^(Due|Target):[ \t]*(.+)$/i);
    if (m && !isValidDateValue(m[2])) {
      stripped.push(`${m[1]}: ${m[2].trim()}`);
      continue;
    }
    out.push(line);
  }
  return {
    sanitized: out.join("\n"),
    changed: stripped.length > 0,
    stripped,
  };
}

async function fetchTable(
  table: string,
  apiKey: string,
): Promise<CommitItem[]> {
  // `order=created_at.asc` not `order=order.asc` — every table has created_at,
  // `order` is a reserved word + not guaranteed to exist on all 4 tables.
  const url = `${BASE_URL}/${table}?select=*&user_id=eq.${USER_ID}&order=created_at.asc`;
  const res = await fetch(url, {
    headers: { apikey: apiKey, Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${table}: HTTP ${res.status}`);
  return (await res.json()) as CommitItem[];
}

async function patchItem(
  table: string,
  id: string,
  updates: Record<string, unknown>,
  apiKey: string,
): Promise<{ ok: boolean; lastEditedAt?: string }> {
  const url = `${BASE_URL}/${table}?id=eq.${id}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      apikey: apiKey,
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({ ...updates, modified_by: "system" }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn(
      `[northstar-sync] PATCH ${table}/${id} failed: HTTP ${res.status} ${body.slice(0, 200)}`,
    );
    return { ok: false };
  }
  try {
    const rows = (await res.json()) as Array<{ last_edited_at?: string }>;
    return { ok: true, lastEditedAt: rows[0]?.last_edited_at };
  } catch {
    return { ok: true };
  }
}

async function deleteItem(
  table: string,
  id: string,
  apiKey: string,
): Promise<boolean> {
  const url = `${BASE_URL}/${table}?id=eq.${id}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: {
      apikey: apiKey,
      Authorization: `Bearer ${apiKey}`,
      Prefer: "return=minimal",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn(
      `[northstar-sync] DELETE ${table}/${id} failed: HTTP ${res.status} ${body.slice(0, 200)}`,
    );
  }
  return res.ok;
}

/**
 * Create a new record on COMMIT. Client-generated UUID — PostgREST accepts
 * caller-provided IDs and we need to know the UUID before we rewrite the
 * local file. `modified_by: "system"` matches the sync write convention so
 * the next sync's LWW gate correctly treats this as a non-user edit.
 */
async function createItem(
  table: string,
  id: string,
  fields: Record<string, unknown>,
  apiKey: string,
): Promise<{ ok: boolean; status: number; error?: string }> {
  const url = `${BASE_URL}/${table}`;
  const body = {
    id,
    user_id: USER_ID,
    modified_by: "system",
    ...fields,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: apiKey,
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.warn(
      `[northstar-sync] POST ${table} failed: HTTP ${res.status} ${errText.slice(0, 200)}`,
    );
    return { ok: false, status: res.status, error: errText.slice(0, 200) };
  }
  return { ok: true, status: res.status };
}

function extractField(content: string, field: string): string | null {
  // `[ \t]*` — NOT `\s*` — because `\s` includes `\n`, which means a field
  // with an empty value (`COMMIT_ID: \n`) would match the NEXT line's content.
  // Previously caused `extractCommitId` on a local-new file to return
  // "Status: in_progress" and corrupt the push-new flow.
  const match = content.match(new RegExp(`^${field}:[ \\t]*(.+)$`, "mi"));
  return match ? match[1].trim() : null;
}

/**
 * Like extractField but also accepts aliased key names.
 * Handles the common mismatch where local files use `target_date:` (snake_case)
 * instead of the canonical `Target:` form that buildFileContent emits.
 */
function extractFieldWithAlias(
  content: string,
  canonical: string,
  ...aliases: string[]
): string | null {
  const result = extractField(content, canonical);
  if (result !== null) return result;
  for (const alias of aliases) {
    const alt = extractField(content, alias);
    if (alt !== null) return alt;
  }
  return null;
}

/**
 * Extract a multi-line description from a section heading like `## Descripción`.
 * Returns all non-empty lines as a single space-joined string, or null.
 *
 * No `m` flag — the `$` in the stop-lookahead must mean end-of-string, not
 * end-of-line. `(?:^|\n)##` handles "heading at line start" without `m`.
 * (The earlier `\z` was a Ruby anchor that JS silently treats as literal `z`.)
 */
function extractDescriptionSection(content: string): string | null {
  // Stop lookahead must reject `###` (sub-heading) — `##` is a prefix of `###`,
  // so `(?=\n##|$)` would truncate at the first sub-heading. `[^#]` on the
  // third char enforces exactly-two-hashes.
  const m = content.match(
    /(?:^|\n)##[ \t]+(?:Descripci[oó]n|Description)[ \t]*\n([\s\S]*?)(?=\n##[^#]|$)/i,
  );
  if (!m) return null;
  const text = m[1]
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ");
  return text || null;
}

function extractCommitId(content: string): string | null {
  return extractField(content, "COMMIT_ID");
}

function extractTitle(content: string): string | null {
  const m = content.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

function buildFileContent(
  item: CommitItem,
  kind: Kind,
  parentTitle?: string,
): string {
  const lines = [
    `# ${item.title}`,
    `COMMIT_ID: ${item.id}`,
    `Status: ${item.status}`,
  ];
  if (item.priority) lines.push(`Priority: ${item.priority}`);
  if (parentTitle)
    lines.push(
      `${kind === "goal" ? "Vision" : kind === "objective" ? "Goal" : "Objective"}: ${parentTitle}`,
    );
  if (item.target_date) lines.push(`Target: ${item.target_date}`);
  if (item.due_date) lines.push(`Due: ${item.due_date}`);
  if (item.description) lines.push(`Description: ${item.description}`);
  if (item.notes) lines.push(`Notes: ${item.notes}`);
  lines.push("", `Last sync: ${new Date().toISOString()}`);
  return lines.join("\n");
}

/** Extract patchable fields from file content. Returns only fields present. */
function extractPatchFields(
  content: string,
  kind: Kind,
): Record<string, string | null> {
  const fields: Record<string, string | null> = {};
  const allowed = PUSH_FIELDS[kind];

  const title = extractTitle(content);
  if (allowed.includes("title") && title) fields.title = title;

  const description =
    extractFieldWithAlias(content, "Description") ??
    extractDescriptionSection(content);
  if (allowed.includes("description") && description !== null)
    fields.description = description;

  const status = extractFieldWithAlias(content, "Status");
  if (allowed.includes("status") && status) fields.status = status;

  const priority = extractField(content, "Priority");
  if (allowed.includes("priority") && priority) fields.priority = priority;

  // `Due:` is canonical on tasks (maps to due_date), but a common user typo on
  // non-task kinds where they mean target_date. Accept it as a target alias;
  // the `allowed.includes("target_date")` guard prevents it from leaking into
  // task PATCHes (tasks have no target_date column).
  // Date sentinels like `Target: none` / `Due: TBD` are rejected by PG with
  // `22007 invalid_datetime_format`. On a PATCH path the field is in
  // CLEARABLE_FIELDS, so we propagate the user's intent ("no date") as `null`
  // rather than silently dropping it — otherwise a user can't clear a stale
  // date by editing the line.
  const target = extractFieldWithAlias(content, "Target", "target_date", "Due");
  if (allowed.includes("target_date") && target) {
    fields.target_date = isValidDateValue(target) ? target : null;
  }

  const due = extractField(content, "Due");
  if (allowed.includes("due_date") && due) {
    fields.due_date = isValidDateValue(due) ? due : null;
  }

  const notes = extractField(content, "Notes");
  if (allowed.includes("notes") && notes !== null) fields.notes = notes;

  return fields;
}

// -- Journal helpers --------------------------------------------------------

function loadJournal(): Map<string, SyncStateRow> {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT commit_id, kind, local_path, last_commit_edited_at,
              last_local_edit_time, last_sync_at
       FROM northstar_sync_state`,
    )
    .all() as SyncStateRow[];
  return new Map(rows.map((r) => [r.commit_id, r]));
}

function upsertJournal(
  commitId: string,
  kind: Kind,
  localPath: string,
  lastCommitEditedAt: string | null,
  lastLocalEditTime: string | null,
): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO northstar_sync_state (commit_id, kind, local_path,
       last_commit_edited_at, last_local_edit_time, last_sync_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(commit_id) DO UPDATE SET
       kind = excluded.kind, local_path = excluded.local_path,
       last_commit_edited_at = excluded.last_commit_edited_at,
       last_local_edit_time = excluded.last_local_edit_time,
       last_sync_at = datetime('now')`,
  ).run(commitId, kind, localPath, lastCommitEditedAt, lastLocalEditTime);
}

function deleteJournal(commitId: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM northstar_sync_state WHERE commit_id = ?").run(
    commitId,
  );
}

// -- Local-side enumeration -------------------------------------------------

interface LocalEntry {
  path: string;
  commitId: string;
  content: string;
  userEditTime: string | null;
}

interface LocalNewEntry {
  path: string;
  content: string;
  title: string;
}

/**
 * Files under `NorthStar/{kind}/` with NO `COMMIT_ID:` line (or blank value).
 * These are local-only creates awaiting a push to COMMIT.
 */
function enumerateLocalNew(kind: Kind): LocalNewEntry[] {
  const prefix = `${KIND_TO_PATH[kind]}/`;
  const files = listFiles({ prefix });
  const out: LocalNewEntry[] = [];
  for (const f of files) {
    if (!f.path.endsWith(".md")) continue;
    if (f.path.endsWith("INDEX.md")) continue;
    const full = getFile(f.path);
    if (!full) continue;
    const commitId = extractCommitId(full.content);
    if (commitId && commitId.length > 0) continue; // already synced
    const title = extractTitle(full.content);
    if (!title) continue; // no heading = skip, can't POST without title
    out.push({ path: f.path, content: full.content, title });
  }
  return out;
}

/**
 * Resolve a parent reference string (from `Vision:` / `Goal:` / `Objective:`
 * lines) to a COMMIT UUID. Accepts two forms:
 *   - UUID form: "dd05f172-9eb5-423a-bcec-e94a06ebee67" — used directly
 *   - Title form: "Libertad Financiera" — looked up in commitData
 * Returns null when no match or no ref present.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * Accent- AND case-insensitive normalization for parent-title comparison.
 * NFD decomposes accented chars, the regex strips combining marks, so
 * "Visión" and "Vision" compare equal. Mirrors the slugify strategy.
 */
function normalizeForMatch(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
}

function resolveParentRef(
  rawRef: string | null,
  parentKind: Kind,
  commitData: Record<string, CommitItem[]>,
): string | null {
  if (!rawRef) return null;
  const ref = rawRef.trim();
  if (UUID_RE.test(ref)) return ref;
  const needle = normalizeForMatch(ref);
  const pool = commitData[KIND_TO_TABLE[parentKind]] ?? [];
  const match = pool.find((c) => normalizeForMatch(c.title) === needle);
  return match?.id ?? null;
}

/**
 * Build the POST body for a new COMMIT record from a local file's content.
 * Returns either the fields dict or an error message for the skipped report.
 */
function buildCreateFields(
  entry: LocalNewEntry,
  kind: Kind,
  commitData: Record<string, CommitItem[]>,
): { fields?: Record<string, unknown>; error?: string } {
  const fields: Record<string, unknown> = {
    title: entry.title,
  };
  const description =
    extractFieldWithAlias(entry.content, "Description") ??
    extractDescriptionSection(entry.content);
  if (description) fields.description = description;
  const status = extractFieldWithAlias(entry.content, "Status");
  fields.status = status ?? "in_progress";
  const priority = extractField(entry.content, "Priority");
  if (priority && kind !== "vision" && kind !== "goal") {
    fields.priority = priority;
  }
  // Tasks have no target_date column — skip entirely. For other kinds, accept
  // `Due:` as an alias for `target_date` (common user typo on objectives/goals
  // where they mean "target date" but wrote the tasks-canonical `Due:`).
  // Skip date sentinels ("none", "TBD", etc.) on push-new — POST has no
  // existing column value to clear, so omitting the field is correct. PG would
  // reject the literal string with `22007 invalid_datetime_format` and brick
  // every record on that table for this run.
  if (kind !== "task") {
    const target = extractFieldWithAlias(
      entry.content,
      "Target",
      "target_date",
      "Due",
    );
    if (target && isValidDateValue(target)) fields.target_date = target;
  }
  const due = extractField(entry.content, "Due");
  if (due && kind === "task" && isValidDateValue(due)) fields.due_date = due;
  const notes = extractField(entry.content, "Notes");
  if (notes && kind === "task") fields.notes = notes;

  // Parent FK resolution (required for goals and objectives; optional for tasks;
  // N/A for visions).
  if (kind === "goal") {
    const ref = resolveParentRef(
      extractField(entry.content, "Vision"),
      "vision",
      commitData,
    );
    if (!ref) {
      return {
        error:
          "goal requires Vision: <uuid|title> referencing an existing vision on COMMIT",
      };
    }
    fields.vision_id = ref;
  } else if (kind === "objective") {
    const ref = resolveParentRef(
      extractField(entry.content, "Goal"),
      "goal",
      commitData,
    );
    if (!ref) {
      return {
        error:
          "objective requires Goal: <uuid|title> referencing an existing goal on COMMIT",
      };
    }
    fields.goal_id = ref;
  } else if (kind === "task") {
    const ref = resolveParentRef(
      extractField(entry.content, "Objective"),
      "objective",
      commitData,
    );
    if (ref) fields.objective_id = ref;
    // Tasks may be orphans — no error.
  }
  return { fields };
}

/**
 * Rewrite a local file after successful POST: insert/fill the COMMIT_ID line.
 * Preserves all other content verbatim.
 */
function populateCommitIdInFile(
  path: string,
  title: string,
  oldContent: string,
  newCommitId: string,
  kind?: Kind,
): void {
  let newContent: string;
  if (/^COMMIT_ID:/m.test(oldContent)) {
    // `[^\n]*` not `.*\s*` — must not cross newline boundaries, else an
    // empty-value line (`COMMIT_ID: \n`) gobbles the following `Status:` line.
    newContent = oldContent.replace(
      /^COMMIT_ID:[^\n]*$/m,
      `COMMIT_ID: ${newCommitId}`,
    );
  } else {
    // Insert after the first `# Heading` line, or prepend.
    const headingMatch = oldContent.match(/^#\s+.+$/m);
    if (headingMatch) {
      newContent = oldContent.replace(
        headingMatch[0],
        `${headingMatch[0]}\nCOMMIT_ID: ${newCommitId}`,
      );
    } else {
      newContent = `COMMIT_ID: ${newCommitId}\n${oldContent}`;
    }
  }
  // Consistent tags with the pull-path's upsertFile calls: ["northstar", kind].
  // Without the kind tag, self-healed files would drift from their peers.
  const tags = kind ? ["northstar", kind] : ["northstar"];
  upsertFile(path, title, newContent, tags, "reference", 30, null, [], {
    skipUserEdit: true,
  });
}

function enumerateLocal(kind: Kind): Map<string, LocalEntry> {
  const prefix = `${KIND_TO_PATH[kind]}/`;
  const files = listFiles({ prefix });
  const map = new Map<string, LocalEntry>();
  for (const f of files) {
    if (!f.path.endsWith(".md")) continue;
    const full = getFile(f.path);
    if (!full) continue;
    const commitId = extractCommitId(full.content);
    if (!commitId) continue; // unmatched local files deferred
    map.set(commitId, {
      path: f.path,
      commitId,
      content: full.content,
      userEditTime: full.user_edit_time,
    });
  }
  return map;
}

// -- Sync core --------------------------------------------------------------

interface SyncReport {
  pulled: number;
  pushed: number;
  createdRemote: number;
  deletedLocal: number;
  deletedRemote: number;
  unchanged: number;
  skipped: number;
  skippedPaths: string[];
  destructive: string[];
  selfHealed: string[]; // Paths repaired from a prior crashed run.
  // Strict-mirror invariant: a local record that COMMIT cannot accept (POST
  // 4xx, unresolvable parent ref) is removed from the local store rather than
  // left as a permanent orphan. `dropped` surfaces the deletions so the
  // operator can re-create with valid data if the loss was unintentional.
  dropped: string[];
  // Paths whose content had `Due: <non-date>` / `Target: <non-date>` lines
  // stripped during the pre-flight sanitization pass.
  sanitized: string[];
}

async function syncKind(
  kind: Kind,
  commitItems: CommitItem[],
  commitData: Record<string, CommitItem[]>,
  journal: Map<string, SyncStateRow>,
  bootstrap: boolean,
  apiKey: string,
  report: SyncReport,
): Promise<void> {
  const table = KIND_TO_TABLE[kind];
  const basePath = KIND_TO_PATH[kind];
  const locals = enumerateLocal(kind);
  const commitById = new Map(commitItems.map((c) => [c.id, c]));

  // Union of every commit_id we care about for this kind.
  const ids = new Set<string>();
  for (const c of commitItems) ids.add(c.id);
  for (const [id] of locals) ids.add(id);
  for (const [id, row] of journal) if (row.kind === kind) ids.add(id);

  for (const id of ids) {
    const commit = commitById.get(id) ?? null;
    const local = locals.get(id) ?? null;
    const journalRow = journal.get(id) ?? null;

    // Branch: journal-only (both gone) → drop row.
    // Skip on bootstrap — journal is empty, this branch is unreachable anyway.
    if (!commit && !local && journalRow) {
      if (!bootstrap) deleteJournal(id);
      continue;
    }

    // Compute parent title for file rendering
    const parentTitle = commit
      ? findParentTitle(commit, commitData)
      : undefined;

    // Branch: missing locally
    if (commit && !local) {
      if (journalRow && !bootstrap) {
        // Local was deleted → propagate to COMMIT
        const ok = await deleteItem(table, id, apiKey);
        if (ok) {
          report.deletedRemote++;
          report.destructive.push(`DELETE ${table}/${id} "${commit.title}"`);
          deleteJournal(id);
        } else {
          report.skipped++;
        }
      } else {
        // New on COMMIT (or bootstrap) → create local
        const filePath = buildLocalPath(basePath, commit.id, commit.title);
        const content = buildFileContent(commit, kind, parentTitle);
        upsertFile(
          filePath,
          commit.title,
          content,
          ["northstar", kind],
          "reference",
          30,
          null,
          [],
          { skipUserEdit: true },
        );
        upsertJournal(id, kind, filePath, commit.last_edited_at, null);
        report.pulled++;
      }
      continue;
    }

    // Branch: missing on COMMIT
    if (!commit && local) {
      if (journalRow && !bootstrap) {
        // COMMIT deleted → delete local file
        const ok = deleteFile(local.path);
        if (ok) {
          report.deletedLocal++;
          report.destructive.push(`delete ${local.path}`);
          deleteJournal(id);
        } else {
          report.skipped++;
        }
      } else {
        // Local-only with COMMIT_ID embedded but no matching remote record.
        // v1 limitation: we can't POST a new record (no INSERT path yet), and
        // the record may be a user-typed stub without a real remote row. Skip
        // and surface the path so the operator knows which files are stuck.
        report.skipped++;
        report.skippedPaths.push(local.path);
      }
      continue;
    }

    // Branch: both present
    if (commit && local) {
      // Commit counts as "user-edited since last sync" only when the app wrote
      // last AND the last_edited_at advanced past what we recorded in the journal.
      // Without the timestamp check, every post-pull sync would loop (modified_by
      // stays "user" but the value hasn't actually changed).
      const commitEdited =
        commit.modified_by === "user" &&
        (!journalRow ||
          !journalRow.last_commit_edited_at ||
          ts(commit.last_edited_at) > ts(journalRow.last_commit_edited_at));
      const localEditedAfterSync = (() => {
        if (!local.userEditTime) return false;
        if (!journalRow) return true; // bootstrap: local has edits, treat as unsynced
        return ts(local.userEditTime) > ts(journalRow.last_sync_at);
      })();

      let winner: "commit" | "local" | "none";
      if (commitEdited && localEditedAfterSync) {
        // Both edited since last sync — tiebreak by timestamp
        winner =
          ts(commit.last_edited_at) >= ts(local.userEditTime!)
            ? "commit"
            : "local";
      } else if (commitEdited) {
        winner = "commit";
      } else if (localEditedAfterSync) {
        winner = "local";
      } else {
        winner = "none";
      }

      if (winner === "commit") {
        const content = buildFileContent(commit, kind, parentTitle);
        upsertFile(
          local.path,
          commit.title,
          content,
          ["northstar", kind],
          "reference",
          30,
          null,
          [],
          { skipUserEdit: true },
        );
        upsertJournal(id, kind, local.path, commit.last_edited_at, null);
        report.pulled++;
      } else if (winner === "local") {
        const allFields = extractPatchFields(local.content, kind);
        // Diff against commit with field-remove semantics:
        //  - Line present locally + different from commit → push new value.
        //  - Line absent locally + commit has a value + field is clearable → push null to clear.
        //  - Line absent locally + field is NOT clearable (title/status) → preserve.
        const fields: Record<string, string | null> = {};
        const commitRec = commit as unknown as Record<string, unknown>;
        for (const k of PUSH_FIELDS[kind]) {
          const localVal = allFields[k];
          const commitVal = commitRec[k];
          if (localVal !== undefined) {
            if (commitVal !== localVal) fields[k] = localVal;
          } else if (
            CLEARABLE_FIELDS.has(k) &&
            commitVal !== null &&
            commitVal !== undefined &&
            commitVal !== ""
          ) {
            fields[k] = null;
          }
        }
        if (Object.keys(fields).length === 0) {
          // Local won but every field already matches commit — no-op, count as
          // unchanged (not skipped — skipped is reserved for the genuine
          // "can't decide what to do" branches).
          report.unchanged++;
        } else {
          const result = await patchItem(table, id, fields, apiKey);
          if (result.ok) {
            // Store the post-PATCH last_edited_at so the next sync correctly
            // sees modified_by="system" + timestamp matches → no spurious pull.
            upsertJournal(
              id,
              kind,
              local.path,
              result.lastEditedAt ?? commit.last_edited_at,
              local.userEditTime,
            );
            report.pushed++;
          } else {
            report.skipped++;
          }
        }
      } else {
        // Nothing to do — just refresh journal to mark "seen this run"
        if (!journalRow) {
          upsertJournal(
            id,
            kind,
            local.path,
            commit.last_edited_at,
            local.userEditTime,
          );
        }
        report.unchanged++;
      }
    }
  }
}

function findParentTitle(
  item: CommitItem,
  commitData: Record<string, CommitItem[]>,
): string | undefined {
  if (item.vision_id)
    return commitData.visions?.find((v) => v.id === item.vision_id)?.title;
  if (item.goal_id)
    return commitData.goals?.find((g) => g.id === item.goal_id)?.title;
  if (item.objective_id)
    return commitData.objectives?.find((o) => o.id === item.objective_id)
      ?.title;
  return undefined;
}

export const northstarSyncTool: Tool = {
  name: "northstar_sync",
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
  requiresConfirmation: true,
  riskTier: "medium",
  triggerPhrases: [
    "sincroniza con NorthStar",
    "sync con db.mycommit",
    "actualiza la app",
    "push changes to commit",
  ],
  definition: {
    type: "function",
    function: {
      name: "northstar_sync",
      description: `Reconciliation between NorthStar files (Jarvis local) and COMMIT (db.mycommit.net app). NorthStar and COMMIT are PEER data stores, not master-mirror. Changes on either side stay local until THIS tool is invoked.

STRICT-MIRROR INVARIANT (LWW mode, 2nd sync onward): after a successful run, every local NorthStar record has a matching COMMIT record by id and vice versa. The 4-phase architecture enforces this:
  * Phase 0 — sanitization: \`Due: <non-date>\` and \`Target: <non-date>\` lines (e.g. \`Due: none\`, \`Target: TBD\`) are stripped from local files before sync. Sentinels can never reach COMMIT or live on locally.
  * Phase 1 — push-new: local files without a COMMIT_ID are POSTed. Validation 4xx (bad date, NULL violation, parent unresolvable) results in the LOCAL FILE BEING DELETED — surfaced under \`Dropped:\` with the PG SQLSTATE. Transport failures (HTTP 401/403/5xx) abort the sync without deleting (retry when upstream recovers).
  * Phase 2 — LWW: each side's most recent user-edit wins the whole record. Cleared dates (line removed locally) push as \`null\`.
  * Phase 4 — verification: re-fetches all 4 tables and reconciles. Local files without a COMMIT_ID, or with a COMMIT_ID missing on remote, are dropped. Remote-only records are pulled.

BOOTSTRAP MODE (first run, journal empty): destructive paths in Phases 1–4 are GATED OFF. The first sync can only create across the gap. Strict mirror enforcement starts on the second run.

RULES:
- LWW user-edit gates: COMMIT-side = \`modified_by == "user"\` + advanced \`last_edited_at\`; Jarvis-side = \`user_edit_time > journal.last_sync_at\`.
- Deletions propagate BOTH ways via the \`northstar_sync_state\` journal.
- Create propagation is BIDIRECTIONAL. Parent-FK refs (Vision: / Goal: / Objective:) accept either the parent's UUID or its exact title. Goals + objectives require a resolvable parent; tasks may be orphans.

USE WHEN:
- User asks to "sync" / "reconcilia" / "actualiza COMMIT".
- Verifying state after edits, deletes, or creates.
- After creating new NorthStar records locally and wanting them reflected in the COMMIT app.

GOTCHA: "Dropped: N" lists local files that COMMIT could not accept (validation failure on push-new, or post-Phase-3 orphans). The deletion is permanent — there is no recovery path besides re-creating with a payload COMMIT will accept. Read the dropped reasons in the return string to understand which records were lost. "Skipped: N" is a softer state — record couldn't propagate but local file was preserved (rare, mostly bootstrap-mode escape hatches).`,
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },

  async execute(_args: Record<string, unknown>): Promise<string> {
    const apiKey = process.env.COMMIT_DB_KEY;
    if (!apiKey) {
      return JSON.stringify({
        error:
          "COMMIT_DB_KEY not configured. Set the Supabase service role key in .env.",
      });
    }

    // Reentrancy guard — two concurrent syncs would race on the journal and
    // could emit destructive ops that contradict each other.
    if (syncInFlight) {
      return JSON.stringify({
        error: "Sync already in progress — wait for it to finish.",
      });
    }
    syncInFlight = true;

    try {
      // Fetch all 4 tables — NO status filter (we need every record for correct
      // journal diffing; filtering would masquerade "completed on COMMIT" as deleted).
      const commitData: Record<string, CommitItem[]> = {};
      for (const kind of KINDS) {
        commitData[KIND_TO_TABLE[kind]] = [];
      }
      const fetched = await Promise.all(
        KINDS.map((k) => fetchTable(KIND_TO_TABLE[k], apiKey)),
      );
      KINDS.forEach((k, i) => {
        commitData[KIND_TO_TABLE[k]] = fetched[i];
      });

      const journal = loadJournal();
      const bootstrap = journal.size === 0;

      const report: SyncReport = {
        pulled: 0,
        pushed: 0,
        createdRemote: 0,
        deletedLocal: 0,
        deletedRemote: 0,
        unchanged: 0,
        skipped: 0,
        skippedPaths: [],
        destructive: [],
        selfHealed: [],
        dropped: [],
        sanitized: [],
      };

      // Phase 0: strict-mirror sanitization. Walk every NorthStar record file
      // and strip `Due: <non-date>` / `Target: <non-date>` lines so the local
      // representation matches what we'd send to COMMIT (no sentinels left
      // over). Idempotent — a no-op file is touched exactly when content
      // actually changes. `skipUserEdit: true` so this cleanup doesn't
      // masquerade as a user edit and trick LWW into thinking the local side
      // is newer. Read+pass-through `condition`/`related_to` from the live
      // row — listFiles returns a projection without those columns so a
      // hardcoded null/[] would silently clobber them on every sanitized
      // file.
      for (const kind of KINDS) {
        const basePath = KIND_TO_PATH[kind];
        const files = listFiles({ prefix: basePath + "/" });
        for (const meta of files) {
          if (meta.path === `${basePath}/INDEX.md`) continue;
          const file = getFile(meta.path);
          if (!file) continue;
          const { sanitized, changed } = sanitizeLocalContent(file.content);
          if (!changed) continue;
          let relatedTo: string[] = [];
          try {
            const parsed = JSON.parse(file.related_to);
            if (Array.isArray(parsed))
              relatedTo = parsed.filter(
                (r): r is string => typeof r === "string",
              );
          } catch {
            // Malformed JSON in DB — preserve as empty array, the original
            // garbage would have failed downstream anyway.
          }
          upsertFile(
            meta.path,
            meta.title,
            sanitized,
            meta.tags,
            meta.qualifier,
            meta.priority,
            file.condition,
            relatedTo,
            { skipUserEdit: true },
          );
          report.sanitized.push(meta.path);
        }
      }

      // Phase 1: push-new-to-COMMIT. Local files with no COMMIT_ID (user
      // created via `jarvis_file_write`, never existed on COMMIT) are POSTed
      // to their table with a client-generated UUID. On success, the local
      // file is rewritten with the new COMMIT_ID and the journal is seeded.
      // Order matters: run visions first so goals can reference them by title;
      // then goals, so objectives can reference; then objectives, so tasks can.
      // If a parent isn't resolvable, the child is skipped and surfaced.
      // Parents CREATED in this same sync run ARE resolvable because we push
      // them into commitData in-place after the POST.
      // Build a path→journalRow index so we can self-heal files whose prior
      // sync run POSTed successfully but crashed before populateCommitIdInFile
      // rewrote the local COMMIT_ID. Without this, phase-2 sees (journal +
      // commit + !local-with-matching-ID) → propagates DELETE against COMMIT
      // and silently destroys the user's record. Self-heal: rewrite the local
      // file with the journaled UUID so phase-2 sees a matched record.
      const journalByPath = new Map<string, SyncStateRow>();
      for (const row of journal.values())
        journalByPath.set(row.local_path, row);

      for (const kind of KINDS) {
        const newEntries = enumerateLocalNew(kind);
        for (const entry of newEntries) {
          const existingJournal = journalByPath.get(entry.path);
          if (existingJournal) {
            // Prior run seeded this journal row. Check whether COMMIT has the
            // matching record. Three outcomes:
            //   (a) commit has it → repair the local file with the journaled
            //       UUID and move on. Phase 2 will see everything in sync.
            //   (b) commit missing + journal present → prior run never finished
            //       POST (or remote side later deleted it). Drop the journal
            //       row and retry the POST with a fresh UUID.
            const table = KIND_TO_TABLE[existingJournal.kind];
            const commitMatch = commitData[table]?.find(
              (c) => c.id === existingJournal.commit_id,
            );
            if (commitMatch) {
              populateCommitIdInFile(
                entry.path,
                entry.title,
                entry.content,
                existingJournal.commit_id,
                kind,
              );
              // File is now normal — phase 2's syncKind both-present branch
              // will count it as unchanged. Track separately so the return
              // string can surface the recovery event to the operator.
              report.selfHealed.push(entry.path);
              continue;
            }
            // (b): journal points at a ghost record — drop it so we can retry.
            deleteJournal(existingJournal.commit_id);
            journal.delete(existingJournal.commit_id);
            journalByPath.delete(entry.path);
            // Fall through to the normal create path below.
          }
          const { fields, error } = buildCreateFields(entry, kind, commitData);
          if (error) {
            // Strict-mirror invariant: a local record COMMIT cannot accept
            // (e.g. unresolvable parent ref) is removed from the local store
            // rather than left as a permanent orphan. The next sync would
            // hit the same error and skip again forever, drifting the two
            // stores. Logged via report.dropped for operator visibility.
            deleteFile(entry.path);
            report.dropped.push(`${entry.path} (${error})`);
            continue;
          }
          const newId = crypto.randomUUID();
          // Seed the journal BEFORE the POST so a mid-operation crash leaves
          // a tombstone that blocks duplicate POSTs on the next run. The
          // journal row at this point points at a UUID that doesn't yet
          // exist on COMMIT — that's fine; phase 2's logic treats it as a
          // no-op (nothing to compare against) until a subsequent successful
          // run catches up.
          const nowIso = new Date().toISOString();
          upsertJournal(newId, kind, entry.path, nowIso, nowIso);
          journalByPath.set(entry.path, {
            commit_id: newId,
            kind,
            local_path: entry.path,
            last_commit_edited_at: nowIso,
            last_local_edit_time: nowIso,
            last_sync_at: nowIso,
          });

          const res = await createItem(
            KIND_TO_TABLE[kind],
            newId,
            fields!,
            apiKey,
          );
          if (!res.ok) {
            // Transport-level / auth / upstream-down failures (401, 403,
            // 5xx) are orthogonal to record validity — a config disaster
            // (rotated key, Supabase reboot, Caddy outage) must NOT cause
            // every push-new file to be deleted in lockstep. Drop the
            // pre-seeded journal row and abort the sync; the operator
            // retries once the upstream is healthy.
            if (res.status === 401 || res.status === 403 || res.status >= 500) {
              deleteJournal(newId);
              journalByPath.delete(entry.path);
              throw new Error(
                `aborting: HTTP ${res.status} on POST ${KIND_TO_TABLE[kind]} for ${entry.path} — refusing to drop local content for transport/auth failures, retry after upstream recovers`,
              );
            }
            // Genuine 4xx validation failure (bad date, NOT NULL, CHECK,
            // etc.) — drop the journal row so a future create attempt
            // isn't blocked by the tombstone, and remove the local file
            // so the strict-mirror invariant holds. The operator sees the
            // deletion + the upstream error code under `report.dropped`;
            // if the loss was unintentional they can re-create with a
            // payload that COMMIT will accept.
            deleteJournal(newId);
            journalByPath.delete(entry.path);
            deleteFile(entry.path);
            // Extract the PG SQLSTATE code from the PostgREST error JSON when
            // present (`{"code":"22007", ...}` → `22007`). Operators can map
            // these to root cause: 22007 = bad date, 23502 = NOT NULL
            // violation, 23514 = CHECK violation, 22P02 = invalid text repr,
            // 23505 = unique violation. Without the code the reason looks
            // identical for very different bugs.
            let pgCode = "";
            if (res.error) {
              const m = res.error.match(/"code"\s*:\s*"([0-9A-Z]{5})"/);
              if (m) pgCode = ` PG ${m[1]}`;
            }
            report.dropped.push(
              `${entry.path} (POST failed: HTTP ${res.status}${pgCode}${res.error ? ` ${res.error}` : ""})`,
            );
            continue;
          }
          // Success: rewrite local file with populated COMMIT_ID, and inject
          // the record into commitData so subsequent kinds can resolve it
          // as a parent + syncKind sees it as already-matched.
          populateCommitIdInFile(
            entry.path,
            entry.title,
            entry.content,
            newId,
            kind,
          );
          const injected: CommitItem = {
            id: newId,
            title: entry.title,
            status: String(fields!.status ?? "in_progress"),
            description:
              typeof fields!.description === "string"
                ? fields!.description
                : null,
            priority:
              typeof fields!.priority === "string" ? fields!.priority : null,
            target_date:
              typeof fields!.target_date === "string"
                ? fields!.target_date
                : null,
            due_date:
              typeof fields!.due_date === "string" ? fields!.due_date : null,
            notes: typeof fields!.notes === "string" ? fields!.notes : null,
            vision_id:
              typeof fields!.vision_id === "string" ? fields!.vision_id : null,
            goal_id:
              typeof fields!.goal_id === "string" ? fields!.goal_id : null,
            objective_id:
              typeof fields!.objective_id === "string"
                ? fields!.objective_id
                : null,
            updated_at: nowIso,
            last_edited_at: nowIso,
            modified_by: "system",
          };
          commitData[KIND_TO_TABLE[kind]].push(injected);
          // Refresh the journal map so downstream syncKind sees the new row.
          journal.set(newId, {
            commit_id: newId,
            kind,
            local_path: entry.path,
            last_commit_edited_at: nowIso,
            last_local_edit_time: nowIso,
            last_sync_at: nowIso,
          });
          report.createdRemote++;
        }
      }

      // Phase 2: normal LWW sync across the (now-updated) union.
      for (const kind of KINDS) {
        await syncKind(
          kind,
          commitData[KIND_TO_TABLE[kind]],
          commitData,
          journal,
          bootstrap,
          apiKey,
          report,
        );
      }

      // Phase 4: post-sync mirror verification. Re-fetches the canonical
      // state from COMMIT (post-deletes, post-creates, post-PATCHes) and
      // walks every local file to ensure id-level identity with the remote.
      // Any local file whose COMMIT_ID is missing remotely (or is itself
      // missing) is dropped; any remote record without a matching local
      // file is pulled. Catches paths Phases 1–3 missed (network blip,
      // race, bug) and brings the two stores into structural identity.
      const verified = await Promise.all(
        KINDS.map((k) => fetchTable(KIND_TO_TABLE[k], apiKey)),
      );
      KINDS.forEach((k, i) => {
        commitData[KIND_TO_TABLE[k]] = verified[i];
      });

      for (const kind of KINDS) {
        const basePath = KIND_TO_PATH[kind];
        const remoteById = new Map(
          commitData[KIND_TO_TABLE[kind]].map((c) => [c.id, c]),
        );
        const localCommitIds = new Set<string>();

        const filesForKind = listFiles({ prefix: basePath + "/" });
        for (const meta of filesForKind) {
          if (meta.path === `${basePath}/INDEX.md`) continue;
          const file = getFile(meta.path);
          if (!file) continue;
          const commitId = extractCommitId(file.content);
          // Bootstrap mode preserves all local content (the sync run is the
          // very first reconciliation; the operator's local files MAY be the
          // canonical source). Phase 2's bootstrap branch already pulls
          // remote-only records, so the only Phase-4 work left for bootstrap
          // is to re-add new pulls for any that slipped — destructive paths
          // are gated.
          if (!commitId) {
            if (!bootstrap) {
              // No COMMIT_ID after all phases ran → Phase 1 either failed
              // silently or the file was just created and never rewritten.
              // Either way, this is an unsyncable orphan under the strict
              // mirror invariant.
              deleteFile(meta.path);
              report.dropped.push(`${meta.path} (post-sync: no COMMIT_ID)`);
            }
            continue;
          }
          if (!remoteById.has(commitId)) {
            if (!bootstrap) {
              // Local has a COMMIT_ID that isn't on the remote any more.
              // Phase 3 deletes propagation should have caught this, but if
              // it slipped (e.g. DELETE 5xx with retry exhaustion), drop the
              // local now so the next read isn't operating on a ghost.
              deleteFile(meta.path);
              report.dropped.push(
                `${meta.path} (post-sync orphan: id ${commitId.slice(0, 8)} missing on COMMIT)`,
              );
            }
            continue;
          }
          localCommitIds.add(commitId);
        }

        // Remote records without a local file → pull. Phase 2 should have
        // produced these via the bootstrap/missing-locally branch; this is
        // defense-in-depth for the case where that write failed silently.
        // Membership is keyed by COMMIT_ID (not filename) so a record that
        // exists locally under a stale slug (parent title renamed on
        // COMMIT) is NOT re-created under the new canonical path — the
        // existing file is left alone and will rename naturally on the
        // next push-or-pull pass when LWW notices the title change.
        for (const [id, commit] of remoteById) {
          if (localCommitIds.has(id)) continue;
          const parentTitle = findParentTitle(commit, commitData);
          const filePath = buildLocalPath(basePath, commit.id, commit.title);
          const content = buildFileContent(commit, kind, parentTitle);
          upsertFile(
            filePath,
            commit.title,
            content,
            ["northstar", kind],
            "reference",
            30,
            null,
            [],
            { skipUserEdit: true },
          );
          report.pulled++;
        }
      }

      // Rebuild INDEX.md from POST-sync local state — what's on disk right
      // now, not the pre-sync commitData snapshot. Before this, INDEX.md was
      // built from `commitData[table]` captured at the start of the run, so
      // any records this sync had just deleted on COMMIT still appeared in
      // the INDEX. User-visible symptom: "sync ignored my deletes" when in
      // fact the DELETEs fired correctly but INDEX showed stale ghosts.
      //
      // 2026-05-09 friction-pickup #3: format changed from flat per-kind list
      // to compass narrative (vision → goal → objective → task tree, sorted
      // by status). Renderer extracted to `northstar-index.ts` so it can be
      // unit-tested independently of the sync's network/DB harness.
      const indexLocals: Record<IndexKind, IndexLocalEntry[]> = {
        vision: [],
        goal: [],
        objective: [],
        task: [],
      };
      const indexCommits: Record<IndexKind, Map<string, IndexCommitItem>> = {
        vision: new Map(),
        goal: new Map(),
        objective: new Map(),
        task: new Map(),
      };
      let totalListed = 0;
      for (const kind of KINDS) {
        const locals = enumerateLocal(kind);
        for (const entry of locals.values()) {
          indexLocals[kind].push({
            path: entry.path,
            commitId: entry.commitId,
            content: entry.content,
          });
          totalListed++;
        }
        for (const c of commitData[KIND_TO_TABLE[kind]]) {
          indexCommits[kind].set(c.id, {
            id: c.id,
            title: c.title,
            status: c.status,
            priority: c.priority ?? null,
            vision_id: c.vision_id ?? null,
            goal_id: c.goal_id ?? null,
            objective_id: c.objective_id ?? null,
          });
        }
      }

      const indexBody = renderCompassIndex(indexLocals, indexCommits, {
        bootstrap,
        totalListed,
        syncedAt: new Date().toISOString(),
      });

      upsertFile(
        "NorthStar/INDEX.md",
        "NorthStar Hierarchy",
        indexBody,
        ["northstar", "index"],
        "reference",
        5,
        null,
        [],
        { skipUserEdit: true },
      );

      if (report.destructive.length > 0) {
        console.warn(
          `[northstar-sync] destructive ops:\n  ${report.destructive.join("\n  ")}`,
        );
      }
      if (report.dropped.length > 0) {
        console.warn(
          `[northstar-sync] dropped unsyncable local records:\n  ${report.dropped.join("\n  ")}`,
        );
      }

      const skippedNote =
        report.skippedPaths.length > 0
          ? ` Skipped paths: ${report.skippedPaths.slice(0, 5).join(", ")}${report.skippedPaths.length > 5 ? ` (+${report.skippedPaths.length - 5} more)` : ""}.`
          : "";
      const transitionNote = bootstrap
        ? " Bootstrap complete — record-level deletion detection enabled starting next sync."
        : "";
      const selfHealNote =
        report.selfHealed.length > 0
          ? ` Self-healed ${report.selfHealed.length} file(s) from a prior crashed run: ${report.selfHealed.slice(0, 3).join(", ")}${report.selfHealed.length > 3 ? ` (+${report.selfHealed.length - 3} more)` : ""}.`
          : "";
      const droppedNote =
        report.dropped.length > 0
          ? ` Dropped unsyncable: ${report.dropped.slice(0, 5).join(", ")}${report.dropped.length > 5 ? ` (+${report.dropped.length - 5} more)` : ""}.`
          : "";
      const sanitizedNote =
        report.sanitized.length > 0
          ? ` Sanitized ${report.sanitized.length} file(s) (stripped invalid date sentinels): ${report.sanitized.slice(0, 3).join(", ")}${report.sanitized.length > 3 ? ` (+${report.sanitized.length - 3} more)` : ""}.`
          : "";
      return `NorthStar sync complete (${bootstrap ? "bootstrap" : "LWW"}). Created remote: ${report.createdRemote}, Pulled: ${report.pulled}, Pushed: ${report.pushed}, Deleted local: ${report.deletedLocal}, Deleted remote: ${report.deletedRemote}, Unchanged: ${report.unchanged}, Skipped: ${report.skipped}, Dropped: ${report.dropped.length}.${selfHealNote}${sanitizedNote}${droppedNote}${skippedNote}${transitionNote}`;
    } catch (err) {
      return JSON.stringify({
        error: `Sync failed: ${err instanceof Error ? err.message : err}`,
      });
    } finally {
      syncInFlight = false;
    }
  },
};
