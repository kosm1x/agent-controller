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

function extractField(content: string, field: string): string | null {
  const match = content.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : null;
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

  const description = extractField(content, "Description");
  if (allowed.includes("description") && description !== null)
    fields.description = description;

  const status = extractField(content, "Status");
  if (allowed.includes("status") && status) fields.status = status;

  const priority = extractField(content, "Priority");
  if (allowed.includes("priority") && priority) fields.priority = priority;

  const target = extractField(content, "Target");
  if (allowed.includes("target_date") && target) fields.target_date = target;

  const due = extractField(content, "Due");
  if (allowed.includes("due_date") && due) fields.due_date = due;

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
  deletedLocal: number;
  deletedRemote: number;
  unchanged: number;
  skipped: number;
  skippedPaths: string[];
  destructive: string[];
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
      description: `Bidirectional Last-Write-Wins sync between NorthStar files and COMMIT (db.mycommit.net).

RULES:
- Record-level LWW: whichever side edited most recently wins the whole record.
- Unsynced-edit detection:
  * COMMIT side: \`modified_by == "user"\` means the app edited since our last sync.
  * Jarvis side: \`user_edit_time\` bumped only by real file edits, not by sync writes.
- Deletions propagate both ways via the \`northstar_sync_state\` journal:
  * record in journal + missing on one side → deleted by user → propagate delete
  * record not in journal + missing on one side → new, just created → propagate create
- First run (empty journal) is bootstrap mode: create across the gap, NO deletes.

DIRECTION: always full bidirectional — no direction param anymore (the old
field-level merge is gone; record-level LWW is the only mode).

GOTCHA: 0 pulled + 0 pushed + 0 deleted means everything's in sync — normal.`,
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
        deletedLocal: 0,
        deletedRemote: 0,
        unchanged: 0,
        skipped: 0,
        skippedPaths: [],
        destructive: [],
      };

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

      // Rebuild INDEX.md from POST-sync local state — what's on disk right
      // now, not the pre-sync commitData snapshot. Before this, INDEX.md was
      // built from `commitData[table]` captured at the start of the run, so
      // any records this sync had just deleted on COMMIT still appeared in
      // the INDEX. User-visible symptom: "sync ignored my deletes" when in
      // fact the DELETEs fired correctly but INDEX showed stale ghosts.
      const indexLines = ["# NorthStar — Hierarchy\n"];
      let totalListed = 0;
      for (const kind of KINDS) {
        const locals = enumerateLocal(kind);
        const commitById = new Map(
          commitData[KIND_TO_TABLE[kind]].map((c) => [c.id, c]),
        );
        // Sort by commit creation order if available, else by path.
        const sorted = Array.from(locals.values()).sort((a, b) => {
          const ca = commitById.get(a.commitId);
          const cb = commitById.get(b.commitId);
          if (ca && cb) return (ca.title ?? "").localeCompare(cb.title ?? "");
          return a.path.localeCompare(b.path);
        });
        indexLines.push(
          `## ${KIND_TO_TABLE[kind].charAt(0).toUpperCase() + KIND_TO_TABLE[kind].slice(1)} (${sorted.length})`,
        );
        for (const entry of sorted) {
          const commit = commitById.get(entry.commitId);
          // Prefer commitData for title/status (authoritative when present);
          // fall back to the file's `# Heading` + `Status:` line when the
          // local file has a COMMIT_ID that no longer exists on COMMIT (e.g.
          // after an app-side delete that hasn't propagated yet — the file
          // is still on disk but commitData won't have it).
          const title =
            commit?.title ?? extractTitle(entry.content) ?? "(untitled)";
          const status =
            commit?.status ?? extractField(entry.content, "Status") ?? "";
          const priority = commit?.priority
            ? ` (${commit.priority})`
            : extractField(entry.content, "Priority")
              ? ` (${extractField(entry.content, "Priority")})`
              : "";
          indexLines.push(
            `- [${title}](${entry.path})${status ? ` — ${status}` : ""}${priority}`,
          );
          totalListed++;
        }
        indexLines.push("");
      }
      indexLines.push(
        `---\nLast sync: ${new Date().toISOString()}\nMode: ${bootstrap ? "bootstrap (no deletes)" : "LWW (deletes propagated)"}\nLocal records: ${totalListed}\nSource of truth: local NorthStar files (post-sync). Run northstar_sync to reconcile with db.mycommit.net.`,
      );

      upsertFile(
        "NorthStar/INDEX.md",
        "NorthStar Hierarchy",
        indexLines.join("\n"),
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

      const skippedNote =
        report.skippedPaths.length > 0
          ? ` Skipped paths: ${report.skippedPaths.slice(0, 5).join(", ")}${report.skippedPaths.length > 5 ? ` (+${report.skippedPaths.length - 5} more)` : ""}.`
          : "";
      const transitionNote = bootstrap
        ? " Bootstrap complete — record-level deletion detection enabled starting next sync."
        : "";
      return `NorthStar sync complete (${bootstrap ? "bootstrap" : "LWW"}). Pulled: ${report.pulled}, Pushed: ${report.pushed}, Deleted local: ${report.deletedLocal}, Deleted remote: ${report.deletedRemote}, Unchanged: ${report.unchanged}, Skipped: ${report.skipped}.${skippedNote}${transitionNote}`;
    } catch (err) {
      return JSON.stringify({
        error: `Sync failed: ${err instanceof Error ? err.message : err}`,
      });
    } finally {
      syncInFlight = false;
    }
  },
};
