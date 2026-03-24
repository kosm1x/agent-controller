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

const scheduledJobs: ScheduledTask[] = [];

function todayLabel(): string {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: RITUALS_TIMEZONE,
  });
}

function getTaskTemplate(ritual: RitualDefinition): TaskSubmission {
  const date = todayLabel();
  switch (ritual.id) {
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
  for (const ritual of rituals) {
    if (!ritual.enabled) {
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
}

export function stopRitualScheduler(): void {
  for (const job of scheduledJobs) {
    job.stop();
  }
  scheduledJobs.length = 0;
  console.log("[rituals] All jobs stopped");
}
