/**
 * Ritual scheduler.
 *
 * Uses node-cron to submit pre-configured tasks at scheduled times.
 * Idempotent: checks if a ritual already ran today before submitting.
 */

import cron, { type ScheduledTask } from "node-cron";
import { execFileSync } from "child_process";
import { getDatabase } from "../db/index.js";
import { submitTask, type TaskSubmission } from "../dispatch/dispatcher.js";
import { getRouter } from "../messaging/index.js";
import { rituals, RITUALS_TIMEZONE, type RitualDefinition } from "./config.js";
import { createMorningBriefing } from "./morning.js";
import { createNightlyClose } from "./nightly.js";
import { createEvolutionLogEntry } from "./evolution-log.js";
import { createEvolutionRitual } from "./evolution.js";
import { createWeeklyReview } from "./weekly-review.js";
import { createSignalIntelligence } from "./signal-intelligence.js";
import { executeOvernightTuning } from "./overnight-tuning.js";
import { getConfig } from "../config.js";

const scheduledJobs: ScheduledTask[] = [];

function todayLabel(): string {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: RITUALS_TIMEZONE,
  });
}

function getTaskTemplate(ritual: RitualDefinition): TaskSubmission {
  const date = todayLabel();
  switch (ritual.id) {
    case "signal-intelligence":
      return createSignalIntelligence(date);
    case "morning-briefing":
      return createMorningBriefing(date);
    case "nightly-close":
      return createNightlyClose(date);
    case "skill-evolution":
      return createEvolutionRitual(date);
    case "evolution-log":
      return createEvolutionLogEntry(date);
    case "weekly-review":
      return createWeeklyReview(date);
    default:
      throw new Error(`Unknown ritual: ${ritual.id}`);
  }
}

/**
 * Check if a ritual already ran today by looking for a task with a matching
 * title prefix and today's date in the title.
 */
function alreadyRanToday(ritual: RitualDefinition): boolean {
  const db = getDatabase();
  const date = todayLabel();
  const titlePattern = `${ritual.title} — ${date}`;

  const row = db
    .prepare(
      "SELECT 1 FROM tasks WHERE title = ? AND status != 'cancelled' LIMIT 1",
    )
    .get(titlePattern);

  return row !== undefined;
}

async function executeRitual(ritual: RitualDefinition): Promise<void> {
  if (alreadyRanToday(ritual)) {
    console.log(
      `[rituals] ${ritual.id}: already ran today (${todayLabel()}), skipping`,
    );
    return;
  }

  // Overnight tuning runs its own async loop instead of submitting a task.
  // It needs 25+ cycles with state carried across them, exceeding fast-runner limits.
  if (ritual.id === "overnight-tuning") {
    await executeOvernightTuning();
    return;
  }

  const template = getTaskTemplate(ritual);

  try {
    const result = await submitTask(template);
    console.log(
      `[rituals] ${ritual.id}: submitted task ${result.taskId} (agent: ${result.agentType}) at ${new Date().toISOString()}`,
    );

    // Notify messaging router to broadcast ritual result on completion
    const router = getRouter();
    if (router) {
      router.watchRitualTask(result.taskId, ritual.id);
    }
  } catch (err) {
    console.error(`[rituals] ${ritual.id}: failed to submit —`, err);
  }
}

export function startRitualScheduler(): void {
  const config = getConfig();

  for (const ritual of rituals) {
    // Overnight tuning is gated by TUNING_ENABLED env var, not static config
    const isEnabled =
      ritual.id === "overnight-tuning" ? config.tuningEnabled : ritual.enabled;

    if (!isEnabled) {
      console.log(`[rituals] ${ritual.id}: disabled, skipping`);
      continue;
    }

    const job = cron.schedule(ritual.cron, () => void executeRitual(ritual), {
      timezone: RITUALS_TIMEZONE,
    });

    scheduledJobs.push(job);
    console.log(
      `[rituals] ${ritual.id}: scheduled (${ritual.cron}, tz=${RITUALS_TIMEZONE})`,
    );
  }

  // Mechanical backups + autonomous improvement + safeguards
  scheduleKbBackup();
  scheduleAutonomousImprovement();
  scheduleDiffDigest();
}

// ---------------------------------------------------------------------------
// SG5: Pre-cycle git tags for autonomous improvement rollback
// ---------------------------------------------------------------------------

const MC_DIR = "/root/claude/mission-control";

/** Create an annotated git tag before autonomous improvement. Non-fatal. */
export function createPreCycleTag(): void {
  const date = new Date().toISOString().slice(0, 10);
  const tagName = `pre-auto-${date}`;

  try {
    const existing = execFileSync("git", ["tag", "-l", tagName], {
      cwd: MC_DIR,
      timeout: 5000,
      encoding: "utf-8",
    }).trim();
    if (existing) {
      console.log(
        `[rituals] pre-cycle tag ${tagName} already exists, skipping`,
      );
      return;
    }

    execFileSync(
      "git",
      ["tag", "-a", tagName, "-m", "Pre-autonomous-improvement snapshot"],
      { cwd: MC_DIR, timeout: 10_000, encoding: "utf-8" },
    );
    console.log(`[rituals] Created pre-cycle tag: ${tagName}`);

    pruneOldTags();
  } catch (err) {
    console.error("[rituals] Failed to create pre-cycle tag:", err);
  }
}

/** Prune pre-auto-* tags: keep last 10, delete any older than 30 days. */
export function pruneOldTags(): void {
  try {
    const raw = execFileSync(
      "git",
      ["tag", "-l", "pre-auto-*", "--sort=-version:refname"],
      { cwd: MC_DIR, timeout: 5000, encoding: "utf-8" },
    ).trim();
    const tags = raw ? raw.split("\n").filter(Boolean) : [];

    if (tags.length <= 10) return;

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    for (const tag of tags.slice(10)) {
      const dateStr = tag.replace("pre-auto-", "");
      const tagDate = new Date(dateStr);
      if (tagDate < thirtyDaysAgo) {
        execFileSync("git", ["tag", "-d", tag], {
          cwd: MC_DIR,
          timeout: 5000,
          encoding: "utf-8",
        });
        console.log(`[rituals] Pruned old tag: ${tag}`);
      }
    }
  } catch (err) {
    console.error("[rituals] Tag pruning failed:", err);
  }
}

/** Autonomous improvement — detects issues, creates fix branch + PR. */
function scheduleAutonomousImprovement(): void {
  // 1:30 AM Tue/Thu/Sat — right after overnight tuning (1:00 AM)
  const job = cron.schedule(
    "30 1 * * 2,4,6",
    async () => {
      try {
        // SG5: Create pre-cycle snapshot tag
        createPreCycleTag();

        const { createImprovementTask } =
          await import("./autonomous-improvement.js");
        const task = createImprovementTask();
        if (!task) return; // no candidates or gates blocked

        const result = await submitTask(task);
        console.log(
          `[rituals] autonomous-improvement: submitted task ${result.taskId} (agent: ${result.agentType})`,
        );

        const router = getRouter();
        if (router) {
          router.watchRitualTask(result.taskId, "autonomous-improvement");
        }
      } catch (err) {
        console.error("[rituals] autonomous-improvement failed:", err);
      }
    },
    { timezone: RITUALS_TIMEZONE },
  );
  scheduledJobs.push(job);
  console.log(
    `[rituals] autonomous-improvement: scheduled (30 1 * * 2,4,6, tz=${RITUALS_TIMEZONE})`,
  );
}

/** Mechanical KB backup — no LLM, just pushes jarvis_files to Postgres. */
function scheduleKbBackup(): void {
  // 10:30 PM daily — right after nightly close
  const job = cron.schedule(
    "30 22 * * *",
    async () => {
      try {
        const { syncKbToRemote } = await import("../db/kb-backup.js");
        const result = await syncKbToRemote();
        console.log(
          `[rituals] kb-backup: ${result.pushed} files synced to db.mycommit.net (${result.duration_ms}ms)`,
        );
      } catch (err) {
        console.error("[rituals] kb-backup failed:", err);
      }
    },
    { timezone: RITUALS_TIMEZONE },
  );
  scheduledJobs.push(job);
  console.log(
    `[rituals] kb-backup: scheduled (30 22 * * *, tz=${RITUALS_TIMEZONE})`,
  );
}

/** Weekly diff digest — SG1 safeguard. Summarizes autonomous activity. */
function scheduleDiffDigest(): void {
  // Sunday 8 PM — same timezone as weekly review
  const job = cron.schedule(
    "0 20 * * 0",
    async () => {
      try {
        const { executeDiffDigest } = await import("./diff-digest.js");
        const result = await executeDiffDigest();
        console.log(
          `[rituals] diff-digest: sent=${result.sent}, sections=${result.sections}`,
        );
      } catch (err) {
        console.error("[rituals] diff-digest failed:", err);
      }
    },
    { timezone: RITUALS_TIMEZONE },
  );
  scheduledJobs.push(job);
  console.log(
    `[rituals] diff-digest: scheduled (0 20 * * 0, tz=${RITUALS_TIMEZONE})`,
  );
}

export function stopRitualScheduler(): void {
  for (const job of scheduledJobs) {
    job.stop();
  }
  scheduledJobs.length = 0;
  console.log("[rituals] All jobs stopped");
}
