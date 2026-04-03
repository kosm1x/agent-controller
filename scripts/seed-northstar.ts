/**
 * Seed NorthStar — individual files per item, folder per hierarchy level.
 * INDEX.md is the routing table: full hierarchy with file paths.
 * User: fede@eurekamd.net
 * Run: npx tsx scripts/seed-northstar.ts
 */

import { initDatabase, getDatabase } from "../src/db/index.js";
initDatabase("./data/mc.db");
const db = getDatabase();

interface V {
  id: string;
  title: string;
  status: string;
  description: string;
  target_date: string | null;
}
interface G {
  id: string;
  title: string;
  status: string;
  description: string;
  target_date: string | null;
  vision_id: string | null;
}
interface O {
  id: string;
  title: string;
  status: string;
  priority: string;
  description: string;
  target_date: string | null;
  goal_id: string | null;
}
interface T {
  id: string;
  title: string;
  status: string;
  priority: string;
  due_date: string | null;
  is_recurring: boolean;
  description: string;
  notes: string;
  objective_id: string | null;
}

const SRK =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoic3VwYWJhc2UiLCJpYXQiOjE3NzUxNTgwMjEsImV4cCI6MTkzMjgzODAyMX0.yzz5TAijY5eBfAAzPWfoMocS7abltXJZ0AL-0wZeBhA";
const FUID = "a8ad98e1-b9c6-4447-ab80-bac467835b3a";
const BASE = "https://db.mycommit.net/rest/v1";
const headers = { apikey: SRK, Authorization: `Bearer ${SRK}` };

async function get<R>(table: string): Promise<R[]> {
  const url = `${BASE}/${table}?select=*&user_id=eq.${FUID}&status=neq.completed&order=order.asc`;
  const res = await fetch(url, { headers });
  return (await res.json()) as R[];
}

function slug(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60);
}

const ins = db.prepare(
  `INSERT OR REPLACE INTO jarvis_files (id, path, title, content, tags, qualifier, priority, created_at, updated_at)
   VALUES (?, ?, ?, ?, '["northstar"]', ?, ?, datetime('now'), datetime('now'))`,
);

let fileCount = 0;
function save(
  id: string,
  path: string,
  title: string,
  content: string,
  qualifier = "reference",
  priority = 30,
) {
  ins.run(id, path, title, content, qualifier, priority);
  fileCount++;
}

async function main() {
  const visions = await get<V>("visions");
  const goals = await get<G>("goals");
  const objectives = await get<O>("objectives");
  const tasks = await get<T>("tasks");

  console.log(
    `Fetched: ${visions.length} visions, ${goals.length} goals, ${objectives.length} objectives, ${tasks.length} tasks`,
  );

  // Build lookup maps
  const goalsByVision = new Map<string, G[]>();
  for (const g of goals) {
    const k = g.vision_id ?? "_orphan";
    if (!goalsByVision.has(k)) goalsByVision.set(k, []);
    goalsByVision.get(k)!.push(g);
  }

  const objsByGoal = new Map<string, O[]>();
  for (const o of objectives) {
    const k = o.goal_id ?? "_orphan";
    if (!objsByGoal.has(k)) objsByGoal.set(k, []);
    objsByGoal.get(k)!.push(o);
  }

  const tasksByObj = new Map<string, T[]>();
  for (const t of tasks) {
    const k = t.objective_id ?? "_orphan";
    if (!tasksByObj.has(k)) tasksByObj.set(k, []);
    tasksByObj.get(k)!.push(t);
  }

  // Slug maps for file paths
  const vSlug = new Map<string, string>();
  for (const v of visions) vSlug.set(v.id, slug(v.title));
  const gSlug = new Map<string, string>();
  for (const g of goals) gSlug.set(g.id, slug(g.title));
  const oSlug = new Map<string, string>();
  for (const o of objectives) oSlug.set(o.id, slug(o.title));
  const tSlug = new Map<string, string>();
  for (const t of tasks) tSlug.set(t.id, slug(t.title));

  // --- INDEX.md: the routing table ---
  const idx: string[] = [];
  idx.push("# NorthStar");
  idx.push("");
  idx.push(
    "Fede's visions, goals, objectives, and tasks. Each item is an individual file.",
  );
  idx.push(
    "To find tasks under a goal: read the goal file — it lists all its objectives and their tasks with file paths.",
  );
  idx.push("");

  for (const v of visions) {
    const vg = goalsByVision.get(v.id) ?? [];
    idx.push(
      `## Vision: [${v.title}](visions/${vSlug.get(v.id)}.md) — ${v.status}`,
    );
    for (const g of vg) {
      const go = objsByGoal.get(g.id) ?? [];
      const taskCount = go.reduce(
        (n, o) => n + (tasksByObj.get(o.id) ?? []).length,
        0,
      );
      idx.push(
        `  - Goal: [${g.title}](goals/${gSlug.get(g.id)}.md) — ${g.status} (${go.length} obj, ${taskCount} tasks)`,
      );
    }
    idx.push("");
  }

  const orphanGoals = goalsByVision.get("_orphan") ?? [];
  const orphanObjs = objsByGoal.get("_orphan") ?? [];
  const orphanTasks = tasksByObj.get("_orphan") ?? [];
  if (orphanGoals.length || orphanObjs.length || orphanTasks.length) {
    idx.push("## Unlinked");
    for (const g of orphanGoals)
      idx.push(
        `  - Goal: [${g.title}](goals/${gSlug.get(g.id)}.md) — no vision`,
      );
    for (const o of orphanObjs)
      idx.push(
        `  - Objective: [${o.title}](objectives/${oSlug.get(o.id)}.md) — no goal`,
      );
    for (const t of orphanTasks)
      idx.push(
        `  - Task: [${t.title}](tasks/${tSlug.get(t.id)}.md) — no objective`,
      );
    idx.push("");
  }

  save(
    "northstar-index",
    "NorthStar/INDEX.md",
    "NorthStar — Life Direction",
    idx.join("\n"),
    "always-read",
    5,
  );

  // --- Vision files ---
  for (const v of visions) {
    const vg = goalsByVision.get(v.id) ?? [];
    const lines = [
      `# ${v.title}`,
      `Status: ${v.status}`,
      `Target: ${v.target_date ?? "none"}`,
      `Description: ${v.description}`,
      "",
      "## Goals",
      "",
    ];
    for (const g of vg) {
      lines.push(
        `- [${g.title}](../goals/${gSlug.get(g.id)}.md) — ${g.status}`,
      );
    }
    if (vg.length === 0) lines.push("(no goals yet)");
    save(
      `ns-v-${slug(v.title)}`,
      `NorthStar/visions/${vSlug.get(v.id)}.md`,
      `Vision: ${v.title}`,
      lines.join("\n"),
    );
  }

  // --- Goal files (with full objective+task listing) ---
  for (const g of goals) {
    const go = objsByGoal.get(g.id) ?? [];
    const visionTitle =
      visions.find((v) => v.id === g.vision_id)?.title ?? "(unlinked)";
    const lines = [
      `# ${g.title}`,
      `Status: ${g.status}`,
      `Vision: ${visionTitle}`,
      `Target: ${g.target_date ?? "none"}`,
    ];
    if (g.description) lines.push(`Description: ${g.description}`);
    lines.push("", "## Objectives", "");

    for (const o of go) {
      const ot = tasksByObj.get(o.id) ?? [];
      lines.push(
        `### [${o.title}](../objectives/${oSlug.get(o.id)}.md) — ${o.status} | ${o.priority}`,
      );
      if (ot.length === 0) {
        lines.push("  (no tasks)");
      }
      for (const t of ot) {
        const rec = t.is_recurring ? " [recurring]" : "";
        lines.push(
          `  - [${t.title}${rec}](../tasks/${tSlug.get(t.id)}.md) — ${t.status}`,
        );
      }
      lines.push("");
    }
    if (go.length === 0) lines.push("(no objectives yet)");
    save(
      `ns-g-${slug(g.title)}`,
      `NorthStar/goals/${gSlug.get(g.id)}.md`,
      `Goal: ${g.title}`,
      lines.join("\n"),
    );
  }

  // --- Objective files ---
  for (const o of objectives) {
    const ot = tasksByObj.get(o.id) ?? [];
    const goalTitle =
      goals.find((g) => g.id === o.goal_id)?.title ?? "(unlinked)";
    const lines = [
      `# ${o.title}`,
      `Status: ${o.status}`,
      `Priority: ${o.priority}`,
      `Goal: ${goalTitle}`,
      `Target: ${o.target_date ?? "none"}`,
    ];
    if (o.description) lines.push(`Description: ${o.description}`);
    lines.push("", "## Tasks", "");

    for (const t of ot) {
      const rec = t.is_recurring ? " [recurring]" : "";
      lines.push(
        `- [${t.title}${rec}](../tasks/${tSlug.get(t.id)}.md) — ${t.status} | ${t.priority}`,
      );
    }
    if (ot.length === 0) lines.push("(no tasks yet)");
    save(
      `ns-o-${slug(o.title)}`,
      `NorthStar/objectives/${oSlug.get(o.id)}.md`,
      `Objective: ${o.title}`,
      lines.join("\n"),
    );
  }

  // --- Task files ---
  for (const t of tasks) {
    const objTitle =
      objectives.find((o) => o.id === t.objective_id)?.title ?? "(unlinked)";
    const rec = t.is_recurring ? " [recurring]" : "";
    const lines = [
      `# ${t.title}${rec}`,
      `Status: ${t.status}`,
      `Priority: ${t.priority}`,
      `Objective: ${objTitle}`,
      `Due: ${t.due_date ?? "none"}`,
    ];
    if (t.description) lines.push(`Description: ${t.description}`);
    if (t.notes) lines.push(`Notes: ${t.notes}`);
    save(
      `ns-t-${slug(t.title)}`,
      `NorthStar/tasks/${tSlug.get(t.id)}.md`,
      `Task: ${t.title}`,
      lines.join("\n"),
    );
  }

  // --- Orphan tasks file ---
  if (orphanTasks.length > 0) {
    for (const t of orphanTasks) {
      const rec = t.is_recurring ? " [recurring]" : "";
      const lines = [
        `# ${t.title}${rec}`,
        `Status: ${t.status}`,
        `Priority: ${t.priority}`,
        `Objective: (unlinked)`,
        `Due: ${t.due_date ?? "none"}`,
      ];
      if (t.description) lines.push(`Description: ${t.description}`);
      if (t.notes) lines.push(`Notes: ${t.notes}`);
      save(
        `ns-t-${slug(t.title)}`,
        `NorthStar/tasks/${tSlug.get(t.id)}.md`,
        `Task: ${t.title}`,
        lines.join("\n"),
      );
    }
  }

  console.log(`NorthStar seeded: ${fileCount} files.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
