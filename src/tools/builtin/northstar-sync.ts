/**
 * NorthStar Sync — bidirectional sync with COMMIT db.mycommit.net.
 *
 * Reads visions/goals/objectives/tasks from both NorthStar files and COMMIT DB.
 * Latest entry wins (compare updated_at timestamps).
 * COMMIT UUIDs embedded in file content for deterministic matching.
 *
 * User: fede@eurekamd.net (a8ad98e1-b9c6-4447-ab80-bac467835b3a)
 */

import type { Tool } from "../types.js";
import { upsertFile, getFile } from "../../db/jarvis-fs.js";

const BASE_URL = "https://db.mycommit.net/rest/v1";
const USER_ID = "a8ad98e1-b9c6-4447-ab80-bac467835b3a";
const TIMEOUT_MS = 15_000;

interface CommitItem {
  id: string;
  title: string;
  status: string;
  description: string;
  priority?: string;
  target_date?: string | null;
  due_date?: string | null;
  notes?: string | null;
  vision_id?: string | null;
  goal_id?: string | null;
  objective_id?: string | null;
  updated_at: string;
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

async function fetchTable(
  table: string,
  apiKey: string,
  statusFilter: string,
): Promise<CommitItem[]> {
  const filter = statusFilter ? `&${statusFilter}` : "";
  const url = `${BASE_URL}/${table}?select=*&user_id=eq.${USER_ID}${filter}&order=order.asc`;
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
): Promise<boolean> {
  const url = `${BASE_URL}/${table}?id=eq.${id}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      apikey: apiKey,
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(updates),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn(
      `[northstar-sync] PATCH ${table}/${id} failed: HTTP ${res.status} ${body.slice(0, 200)}`,
    );
  }
  return res.ok;
}

/** Extract a field value from file content */
function extractField(content: string, field: string): string | null {
  const match = content.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : null;
}

/** Build NorthStar file content with COMMIT_ID embedded */
function buildFileContent(
  item: CommitItem,
  type: string,
  parentTitle?: string,
  children?: string,
): string {
  const lines = [
    `# ${item.title}`,
    `COMMIT_ID: ${item.id}`,
    `Status: ${item.status}`,
  ];
  if (item.priority) lines.push(`Priority: ${item.priority}`);
  if (parentTitle)
    lines.push(
      `${type === "goal" ? "Vision" : type === "objective" ? "Goal" : "Objective"}: ${parentTitle}`,
    );
  if (item.target_date) lines.push(`Target: ${item.target_date}`);
  if (item.due_date) lines.push(`Due: ${item.due_date}`);
  if (item.description) lines.push(`Description: ${item.description}`);
  if (item.notes) lines.push(`Notes: ${item.notes}`);
  if (children) lines.push("", children);
  lines.push("", `Last sync: ${new Date().toISOString()}`);
  return lines.join("\n");
}

export const northstarSyncTool: Tool = {
  name: "northstar_sync",
  requiresConfirmation: true,
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
      description: `Bidirectional sync between NorthStar files and COMMIT database (db.mycommit.net).

Latest entry wins: compares updated_at timestamps. If NorthStar file is newer, pushes to COMMIT DB. If COMMIT DB is newer, updates NorthStar file.

USE WHEN:
- User asks to sync or refresh NorthStar: "sincroniza NorthStar", "actualiza desde COMMIT"
- User updated tasks in COMMIT and wants NorthStar to reflect changes
- User updated NorthStar files and wants COMMIT DB to reflect changes

Requires COMMIT_DB_KEY env var.`,
      parameters: {
        type: "object",
        properties: {
          include_completed: {
            type: "boolean",
            description: "Include completed items (default: false)",
          },
          direction: {
            type: "string",
            enum: ["both", "pull", "push"],
            description:
              "Sync direction: both (default), pull (COMMIT→NorthStar), push (NorthStar→COMMIT)",
          },
        },
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const apiKey = process.env.COMMIT_DB_KEY;
    if (!apiKey) {
      return JSON.stringify({
        error:
          "COMMIT_DB_KEY not configured. Set the Supabase service role key in .env.",
      });
    }

    const includeCompleted = args.include_completed === true;
    const direction = (args.direction as string) || "both";
    const statusFilter = includeCompleted ? "" : "status=neq.completed";

    try {
      const tables = ["visions", "goals", "objectives", "tasks"] as const;
      const typeMap = {
        visions: "vision",
        goals: "goal",
        objectives: "objective",
        tasks: "task",
      } as const;
      const pathMap = {
        visions: "NorthStar/visions",
        goals: "NorthStar/goals",
        objectives: "NorthStar/objectives",
        tasks: "NorthStar/tasks",
      } as const;

      // Fetch all COMMIT data
      const commitData: Record<string, CommitItem[]> = {};
      for (const table of tables) {
        commitData[table] = await fetchTable(table, apiKey, statusFilter);
      }

      let pulled = 0;
      let pushed = 0;
      let unchanged = 0;

      for (const table of tables) {
        const items = commitData[table];
        const type = typeMap[table];
        const basePath = pathMap[table];

        for (const item of items) {
          const slug = slugify(item.title);
          const filePath = `${basePath}/${slug}.md`;
          const existing = getFile(filePath);

          // Find parent title for context
          let parentTitle: string | undefined;
          if ("vision_id" in item && item.vision_id) {
            parentTitle = commitData.visions.find(
              (v) => v.id === item.vision_id,
            )?.title;
          } else if ("goal_id" in item && item.goal_id) {
            parentTitle = commitData.goals.find(
              (g) => g.id === item.goal_id,
            )?.title;
          } else if ("objective_id" in item && item.objective_id) {
            parentTitle = commitData.objectives.find(
              (o) => o.id === item.objective_id,
            )?.title;
          }

          if (!existing) {
            // File doesn't exist — pull from COMMIT
            if (direction !== "push") {
              const content = buildFileContent(item, type, parentTitle);
              upsertFile(
                filePath,
                item.title,
                content,
                ["northstar", type],
                "reference",
                30,
              );
              pulled++;
            }
            continue;
          }

          // Both exist — merge strategy:
          // COMMIT wins for: status, priority (user is authority on the app)
          // NorthStar wins for: due_date, target_date, notes (Jarvis manages these)
          // On conflict: COMMIT status always overrides file status
          const commitTime = new Date(item.updated_at).getTime();
          const fileTime = new Date(existing.updated_at).getTime();
          let didPull = false;
          let didPush = false;

          // STEP 1: Always pull status/priority from COMMIT if different
          if (direction !== "push") {
            const fileStatus = extractField(existing.content, "Status");
            const filePriority = extractField(existing.content, "Priority");
            if (
              (fileStatus && fileStatus !== item.status) ||
              (filePriority && filePriority !== (item.priority ?? ""))
            ) {
              // COMMIT status/priority wins — rebuild file with COMMIT data
              const content = buildFileContent(item, type, parentTitle);
              upsertFile(
                filePath,
                item.title,
                content,
                ["northstar", type],
                "reference",
                30,
              );
              didPull = true;
            }
          }

          // STEP 2: Push dates/notes from file to COMMIT if file is newer
          if (fileTime > commitTime && direction !== "pull" && !didPull) {
            const newDescription = extractField(
              existing.content,
              "Description",
            );
            const newNotes = extractField(existing.content, "Notes");
            const newTarget = extractField(existing.content, "Target");
            const newDue = extractField(existing.content, "Due");

            const updates: Record<string, unknown> = {
              updated_at: new Date().toISOString(),
            };
            // Never push status — COMMIT is authority
            if (newDescription && newDescription !== item.description)
              updates.description = newDescription;
            if (newNotes && newNotes !== item.notes) updates.notes = newNotes;
            if (newTarget && newTarget !== item.target_date)
              updates.target_date = newTarget;
            if (newDue && newDue !== item.due_date) updates.due_date = newDue;

            if (Object.keys(updates).length > 1) {
              const ok = await patchItem(table, item.id, updates, apiKey);
              if (ok) didPush = true;
              else
                console.warn(
                  `[northstar-sync] Failed to push ${item.title} to ${table}`,
                );
            }
          }

          if (didPull) pulled++;
          else if (didPush) pushed++;
          else unchanged++;
        }
      }

      // Regenerate NorthStar INDEX
      const indexLines = ["# NorthStar — Hierarchy\n"];
      for (const table of tables) {
        const items = commitData[table];
        const basePath = pathMap[table];
        indexLines.push(
          `## ${table.charAt(0).toUpperCase() + table.slice(1)} (${items.length})`,
        );
        for (const item of items) {
          const slug = slugify(item.title);
          indexLines.push(
            `- [${item.title}](${basePath}/${slug}.md) — ${item.status}${item.priority ? ` (${item.priority})` : ""}`,
          );
        }
        indexLines.push("");
      }
      indexLines.push(
        `---\nLast sync: ${new Date().toISOString()}\nSource: db.mycommit.net (user fede@eurekamd.net)\nDirection: ${direction}`,
      );

      upsertFile(
        "NorthStar/INDEX.md",
        "NorthStar Hierarchy",
        indexLines.join("\n"),
        ["northstar", "index"],
        "reference",
        5,
      );

      return `NorthStar sync complete (${direction}). Pulled: ${pulled}, Pushed: ${pushed}, Unchanged: ${unchanged}. Total: ${Object.values(commitData).flat().length} items.`;
    } catch (err) {
      return JSON.stringify({
        error: `Sync failed: ${err instanceof Error ? err.message : err}`,
      });
    }
  },
};
