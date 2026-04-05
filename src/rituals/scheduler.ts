/**
 * Ritual scheduler.
 *
 * Uses node-cron to submit pre-configured tasks at scheduled times.
 * Idempotent: checks if a ritual already ran today before submitting.
 */

import cron, { type ScheduledTask } from "node-cron";
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

  // Mechanical backups (no LLM)
  scheduleKbBackup();
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

export function stopRitualScheduler(): void {
  for (const job of scheduledJobs) {
    job.stop();
  }
  scheduledJobs.length = 0;
  console.log("[rituals] All jobs stopped");
}
