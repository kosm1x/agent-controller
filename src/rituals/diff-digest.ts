/**
 * Weekly Diff Digest — SG1.
 *
 * Mechanical ritual (no LLM). Runs Sunday 8 PM.
 * Queries autonomous activity from the past 7 days:
 *   - Auto-improvement tasks (PRs opened, status)
 *   - KB changes (directives, proposals, execution patterns)
 *   - Git commits on jarvis/* branches
 * Formats HTML → sends via Telegram.
 */

import { execFileSync } from "child_process";
import { getDatabase } from "../db/index.js";
import { getRouter } from "../messaging/index.js";

const MC_DIR = "/root/claude/mission-control";

// ---------------------------------------------------------------------------
// Data queries
// ---------------------------------------------------------------------------

interface ImprovementTask {
  task_id: string;
  title: string;
  status: string;
  created_at: string;
}

interface KbChange {
  path: string;
  title: string;
  updated_at: string;
}

function queryAutoImprovementTasks(): ImprovementTask[] {
  try {
    const db = getDatabase();
    return db
      .prepare(
        `SELECT task_id, title, status, created_at FROM tasks
         WHERE title LIKE '%Auto-improvement%'
           AND created_at > datetime('now', '-7 days')
         ORDER BY created_at DESC`,
      )
      .all() as ImprovementTask[];
  } catch {
    return [];
  }
}

function queryKbChanges(): KbChange[] {
  try {
    const db = getDatabase();
    return db
      .prepare(
        `SELECT path, title, updated_at FROM jarvis_files
         WHERE (path LIKE 'knowledge/proposals/%'
            OR path LIKE 'logs/decisions/%'
            OR path LIKE 'directives/%'
            OR path LIKE 'knowledge/execution-patterns/%')
           AND updated_at > datetime('now', '-7 days')
         ORDER BY updated_at DESC`,
      )
      .all() as KbChange[];
  } catch {
    return [];
  }
}

function queryJarvisCommits(): string[] {
  try {
    const raw = execFileSync(
      "git",
      ["log", "--oneline", "--since=7.days.ago", "--all", "--grep=jarvis/"],
      { cwd: MC_DIR, timeout: 10_000, encoding: "utf-8" },
    ).trim();
    return raw ? raw.split("\n") : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// HTML formatter
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatDigestHtml(
  tasks: ImprovementTask[],
  kbChanges: KbChange[],
  commits: string[],
): { html: string; sections: number } {
  const parts: string[] = [];
  let sections = 0;

  parts.push("<b>📊 Weekly Autonomous Activity Digest</b>\n");

  if (tasks.length > 0) {
    sections++;
    parts.push("<b>Auto-improvement Tasks</b>");
    for (const t of tasks) {
      const icon =
        t.status === "completed" ? "✅" : t.status === "failed" ? "❌" : "⏳";
      parts.push(
        `${icon} ${escapeHtml(t.title)} (${t.status}) — ${t.created_at.slice(0, 10)}`,
      );
    }
    parts.push("");
  }

  if (kbChanges.length > 0) {
    sections++;
    parts.push("<b>Directive / Pattern Changes</b>");
    for (const c of kbChanges) {
      parts.push(`• ${escapeHtml(c.path)} — ${c.updated_at.slice(0, 10)}`);
    }
    parts.push("");
  }

  if (commits.length > 0) {
    sections++;
    parts.push("<b>Git Commits (jarvis/* branches)</b>");
    for (const line of commits.slice(0, 20)) {
      parts.push(`• ${escapeHtml(line)}`);
    }
    if (commits.length > 20) {
      parts.push(`... and ${commits.length - 20} more`);
    }
    parts.push("");
  }

  if (sections === 0) {
    parts.push("No autonomous activity this week.");
  }

  return { html: parts.join("\n"), sections };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeDiffDigest(): Promise<{
  sent: boolean;
  sections: number;
}> {
  const tasks = queryAutoImprovementTasks();
  const kbChanges = queryKbChanges();
  const commits = queryJarvisCommits();

  const { html, sections } = formatDigestHtml(tasks, kbChanges, commits);

  const router = getRouter();
  if (!router) {
    console.log("[diff-digest] No messaging router — skipping send");
    return { sent: false, sections };
  }

  try {
    await router.broadcastToAll(html);
    return { sent: true, sections };
  } catch (err) {
    console.error("[diff-digest] Failed to send:", err);
    return { sent: false, sections };
  }
}
