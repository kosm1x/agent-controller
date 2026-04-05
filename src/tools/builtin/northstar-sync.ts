/**
 * NorthStar Sync — connects to COMMIT db.mycommit.net and syncs
 * visions/goals/objectives/tasks into NorthStar/ files.
 *
 * Strictly a service: external DB → NorthStar files. On demand only.
 * User: fede@eurekamd.net (a8ad98e1-b9c6-4447-ab80-bac467835b3a)
 */

import type { Tool } from "../types.js";
import { upsertFile } from "../../db/jarvis-fs.js";

const BASE_URL = "https://db.mycommit.net/rest/v1";
const USER_ID = "a8ad98e1-b9c6-4447-ab80-bac467835b3a";
const TIMEOUT_MS = 15_000;

interface Vision {
  id: string;
  title: string;
  status: string;
  description: string;
  target_date: string | null;
}
interface Goal {
  id: string;
  title: string;
  status: string;
  description: string;
  target_date: string | null;
  vision_id: string | null;
}
interface Objective {
  id: string;
  title: string;
  status: string;
  priority: string;
  description: string;
  target_date: string | null;
  goal_id: string | null;
}
interface Task {
  id: string;
  title: string;
  status: string;
  priority: string;
  description: string;
  due_date: string | null;
  notes: string | null;
  objective_id: string | null;
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

async function fetchTable<T>(
  table: string,
  apiKey: string,
  extraFilter?: string,
): Promise<T[]> {
  const filter = extraFilter ? `&${extraFilter}` : "";
  const url = `${BASE_URL}/${table}?select=*&user_id=eq.${USER_ID}${filter}&order=order.asc`;
  const res = await fetch(url, {
    headers: { apikey: apiKey, Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${table}: HTTP ${res.status}`);
  return (await res.json()) as T[];
}

export const northstarSyncTool: Tool = {
  name: "northstar_sync",
  requiresConfirmation: true,
  definition: {
    type: "function",
    function: {
      name: "northstar_sync",
      description: `Sync visions, goals, objectives, and tasks from the COMMIT database (db.mycommit.net) into NorthStar/ files.

USE WHEN:
- User asks to sync or refresh NorthStar from the COMMIT database
- User asks "sincroniza NorthStar", "actualiza desde COMMIT"

This is a one-way sync: COMMIT DB → NorthStar files. Overwrites existing files.
Requires COMMIT_DB_KEY env var.`,
      parameters: {
        type: "object",
        properties: {
          include_completed: {
            type: "boolean",
            description:
              "Include completed items (default: false, only active items)",
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
    const statusFilter = includeCompleted ? "" : "status=neq.completed";

    try {
      // Fetch all data
      const [visions, goals, objectives, tasks] = await Promise.all([
        fetchTable<Vision>("visions", apiKey, statusFilter),
        fetchTable<Goal>("goals", apiKey, statusFilter),
        fetchTable<Objective>("objectives", apiKey, statusFilter),
        fetchTable<Task>("tasks", apiKey, statusFilter),
      ]);

      let filesWritten = 0;

      // Write vision files
      for (const v of visions) {
        const slug = slugify(v.title);
        const visionGoals = goals.filter((g) => g.vision_id === v.id);
        const goalList = visionGoals
          .map(
            (g) =>
              `- [${g.title}](NorthStar/goals/${slugify(g.title)}.md) — ${g.status}`,
          )
          .join("\n");

        const content = `# ${v.title}
Status: ${v.status}
${v.target_date ? `Target: ${v.target_date}` : ""}
${v.description ? `Description: ${v.description}` : ""}

## Goals
${goalList || "- (none)"}
`;
        upsertFile(
          `NorthStar/visions/${slug}.md`,
          v.title,
          content,
          ["northstar", "vision"],
          "reference",
          30,
        );
        filesWritten++;
      }

      // Write goal files
      for (const g of goals) {
        const slug = slugify(g.title);
        const vision = visions.find((v) => v.id === g.vision_id);
        const goalObjectives = objectives.filter((o) => o.goal_id === g.id);
        const goalTasks = tasks.filter((t) => {
          const obj = objectives.find((o) => o.id === t.objective_id);
          return obj?.goal_id === g.id;
        });

        const objList = goalObjectives
          .map(
            (o) =>
              `- [${o.title}](NorthStar/objectives/${slugify(o.title)}.md) — ${o.status} (${o.priority})`,
          )
          .join("\n");
        const taskList = goalTasks
          .map(
            (t) =>
              `- [${t.title}](NorthStar/tasks/${slugify(t.title)}.md) — ${t.status} (${t.priority})`,
          )
          .join("\n");

        const content = `# ${g.title}
Status: ${g.status}
Vision: ${vision?.title ?? "unlinked"}
${g.target_date ? `Target: ${g.target_date}` : ""}
${g.description ? `Description: ${g.description}` : ""}

## Objectives
${objList || "- (none)"}

## Tasks
${taskList || "- (none)"}
`;
        upsertFile(
          `NorthStar/goals/${slug}.md`,
          g.title,
          content,
          ["northstar", "goal"],
          "reference",
          30,
        );
        filesWritten++;
      }

      // Write objective files
      for (const o of objectives) {
        const slug = slugify(o.title);
        const goal = goals.find((g) => g.id === o.goal_id);
        const objTasks = tasks.filter((t) => t.objective_id === o.id);
        const taskList = objTasks
          .map(
            (t) =>
              `- [${t.title}](NorthStar/tasks/${slugify(t.title)}.md) — ${t.status} (${t.priority})`,
          )
          .join("\n");

        const content = `# ${o.title}
Status: ${o.status}
Priority: ${o.priority}
Goal: ${goal?.title ?? "unlinked"}
${o.target_date ? `Target: ${o.target_date}` : ""}
${o.description ? `Description: ${o.description}` : ""}

## Tasks
${taskList || "- (none)"}
`;
        upsertFile(
          `NorthStar/objectives/${slug}.md`,
          o.title,
          content,
          ["northstar", "objective"],
          "reference",
          30,
        );
        filesWritten++;
      }

      // Write task files
      for (const t of tasks) {
        const slug = slugify(t.title);
        const objective = objectives.find((o) => o.id === t.objective_id);

        const content = `# ${t.title}
Status: ${t.status}
Priority: ${t.priority}
Objective: ${objective?.title ?? "unlinked"}
${t.due_date ? `Due: ${t.due_date}` : ""}
${t.notes ? `Notes: ${t.notes}` : ""}
${t.description ? `Description: ${t.description}` : ""}
`;
        upsertFile(
          `NorthStar/tasks/${slug}.md`,
          t.title,
          content,
          ["northstar", "task"],
          "reference",
          30,
        );
        filesWritten++;
      }

      // Regenerate NorthStar INDEX
      const indexContent = `# NorthStar — Hierarchy

## Visions (${visions.length})
${visions.map((v) => `- [${v.title}](NorthStar/visions/${slugify(v.title)}.md) — ${v.status}`).join("\n")}

## Goals (${goals.length})
${goals.map((g) => `- [${g.title}](NorthStar/goals/${slugify(g.title)}.md) — ${g.status}`).join("\n")}

## Objectives (${objectives.length})
${objectives.map((o) => `- [${o.title}](NorthStar/objectives/${slugify(o.title)}.md) — ${o.status} (${o.priority})`).join("\n")}

## Tasks (${tasks.length})
${tasks.map((t) => `- [${t.title}](NorthStar/tasks/${slugify(t.title)}.md) — ${t.status} (${t.priority})`).join("\n")}

---
Last sync: ${new Date().toISOString()}
Source: db.mycommit.net (user fede@eurekamd.net)
`;

      upsertFile(
        "NorthStar/INDEX.md",
        "NorthStar Hierarchy",
        indexContent,
        ["northstar", "index"],
        "reference",
        5,
      );
      filesWritten++;

      return `NorthStar sync complete. ${filesWritten} files written: ${visions.length} visions, ${goals.length} goals, ${objectives.length} objectives, ${tasks.length} tasks.`;
    } catch (err) {
      return JSON.stringify({
        error: `Sync failed: ${err instanceof Error ? err.message : err}`,
      });
    }
  },
};
