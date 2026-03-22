/**
 * Dynamic scheduled tasks — user-defined recurring tasks via LLM tools.
 *
 * Provides a self-creating SQLite table for scheduled task definitions
 * and a poll loop that checks every minute for tasks due to execute.
 * Integrates with the existing dispatcher (submitTask) and messaging
 * router (broadcastToAll) for delivery.
 *
 * The LLM creates schedules via schedule_task tool. The system executes
 * them autonomously — search the web, compose email, broadcast result.
 */

import { getDatabase } from "../db/index.js";
import { submitTask } from "../dispatch/dispatcher.js";
import { getRouter } from "../messaging/index.js";
import cron, { type ScheduledTask } from "node-cron";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScheduledTaskRow {
  id: number;
  schedule_id: string;
  name: string;
  description: string;
  cron_expr: string;
  tools: string; // JSON array
  delivery: string; // "telegram" | "email" | "both"
  email_to: string | null;
  email_subject: string | null;
  active: number;
  last_run_at: string | null;
  created_at: string;
}

export interface CreateScheduleParams {
  scheduleId: string;
  name: string;
  description: string;
  cronExpr: string;
  tools: string[];
  delivery: "telegram" | "email" | "both";
  emailTo?: string;
  emailSubject?: string;
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id     TEXT UNIQUE NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL,
  cron_expr       TEXT NOT NULL,
  tools           TEXT DEFAULT '[]',
  delivery        TEXT DEFAULT 'telegram',
  email_to        TEXT,
  email_subject   TEXT,
  active          INTEGER DEFAULT 1,
  last_run_at     TEXT,
  created_at      TEXT DEFAULT (datetime('now'))
);
`;

export function ensureScheduledTasksTable(): void {
  getDatabase().exec(CREATE_TABLE_SQL);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function createSchedule(params: CreateScheduleParams): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO scheduled_tasks (schedule_id, name, description, cron_expr, tools, delivery, email_to, email_subject)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    params.scheduleId,
    params.name,
    params.description,
    params.cronExpr,
    JSON.stringify(params.tools),
    params.delivery,
    params.emailTo ?? null,
    params.emailSubject ?? null,
  );
}

export function listSchedules(activeOnly = true): ScheduledTaskRow[] {
  const db = getDatabase();
  const where = activeOnly ? "WHERE active = 1" : "";
  return db
    .prepare(`SELECT * FROM scheduled_tasks ${where} ORDER BY created_at ASC`)
    .all() as ScheduledTaskRow[];
}

export function getSchedule(scheduleId: string): ScheduledTaskRow | null {
  const db = getDatabase();
  return (
    (db
      .prepare("SELECT * FROM scheduled_tasks WHERE schedule_id = ?")
      .get(scheduleId) as ScheduledTaskRow) ?? null
  );
}

export function deleteSchedule(scheduleId: string): boolean {
  const db = getDatabase();
  const result = db
    .prepare("DELETE FROM scheduled_tasks WHERE schedule_id = ?")
    .run(scheduleId);
  return result.changes > 0;
}

export function deactivateSchedule(scheduleId: string): boolean {
  const db = getDatabase();
  const result = db
    .prepare("UPDATE scheduled_tasks SET active = 0 WHERE schedule_id = ?")
    .run(scheduleId);
  return result.changes > 0;
}

function markExecuted(scheduleId: string): void {
  const db = getDatabase();
  db.prepare(
    "UPDATE scheduled_tasks SET last_run_at = datetime('now') WHERE schedule_id = ?",
  ).run(scheduleId);
}

// ---------------------------------------------------------------------------
// Execution engine
// ---------------------------------------------------------------------------

const TIMEZONE = process.env.RITUALS_TIMEZONE ?? "America/Mexico_City";
let pollingJob: ScheduledTask | null = null;

/**
 * Start the dynamic schedule executor.
 * Checks every minute if any scheduled tasks are due.
 */
export function startDynamicScheduler(): void {
  ensureScheduledTasksTable();

  // Check every minute if any cron expressions match
  pollingJob = cron.schedule(
    "* * * * *",
    () => {
      checkAndExecuteSchedules().catch((err) => {
        console.error(
          `[schedules] Execution error: ${err instanceof Error ? err.message : err}`,
        );
      });
    },
    { timezone: TIMEZONE },
  );

  const count = listSchedules().length;
  console.log(
    `[mc] Dynamic scheduler started (${count} active schedule${count !== 1 ? "s" : ""})`,
  );
}

export function stopDynamicScheduler(): void {
  if (pollingJob) {
    pollingJob.stop();
    pollingJob = null;
  }
}

/**
 * Check all active schedules. For each one whose cron expression matches
 * the current minute, submit a task.
 */
async function checkAndExecuteSchedules(): Promise<void> {
  const schedules = listSchedules(true);
  if (schedules.length === 0) return;

  const now = new Date();
  // Build a date string in the target timezone for idempotency check
  const todayLabel = now.toLocaleDateString("en-CA", { timeZone: TIMEZONE });

  for (const schedule of schedules) {
    // Check if this cron expression matches the current time
    if (!cronMatchesNow(schedule.cron_expr, now)) continue;

    // Idempotency: don't run if already ran this minute
    if (schedule.last_run_at) {
      const lastRun = new Date(schedule.last_run_at + "Z");
      const diffMs = now.getTime() - lastRun.getTime();
      if (diffMs < 59_000) continue; // Ran less than 59s ago
    }

    console.log(
      `[schedules] Executing "${schedule.name}" (${schedule.schedule_id})`,
    );
    markExecuted(schedule.schedule_id);

    try {
      const tools = JSON.parse(schedule.tools) as string[];

      // Build task description with delivery instructions
      let deliveryInstructions = "";
      if (schedule.delivery === "email" || schedule.delivery === "both") {
        deliveryInstructions += `\n\nEnvía el resultado por email usando gmail_send a ${schedule.email_to ?? "fede@eureka.md"} con asunto "${schedule.email_subject ?? schedule.name} — ${todayLabel}".`;
        if (!tools.includes("gmail_send")) tools.push("gmail_send");
      }
      if (schedule.delivery === "telegram" || schedule.delivery === "both") {
        deliveryInstructions +=
          "\n\nEl resultado será enviado automáticamente por Telegram.";
      }

      const result = await submitTask({
        title: `[Scheduled] ${schedule.name} — ${todayLabel}`,
        description: `${schedule.description}${deliveryInstructions}`,
        agentType: "fast",
        tools,
        tags: ["scheduled", `schedule:${schedule.schedule_id}`],
      });

      // Watch for result to verify delivery and broadcast
      watchScheduledTask(result.taskId, schedule);
    } catch (err) {
      console.error(
        `[schedules] Failed to submit "${schedule.name}": ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

/**
 * Check if a cron expression matches the current time.
 * Uses node-cron's validate + a 1-minute window check.
 */
function cronMatchesNow(cronExpr: string, now: Date): boolean {
  if (!cron.validate(cronExpr)) return false;

  // Parse cron fields: minute hour dom month dow
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 5) return false;

  // Get current time in target timezone
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  const timeParts = formatter.formatToParts(now);
  const currentHour = parseInt(
    timeParts.find((p) => p.type === "hour")?.value ?? "0",
  );
  const currentMinute = parseInt(
    timeParts.find((p) => p.type === "minute")?.value ?? "0",
  );

  const dayFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    weekday: "short",
  });
  const currentDow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    dayFormatter.format(now),
  );

  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    day: "numeric",
    month: "numeric",
  });
  const dateParts = dateFormatter.formatToParts(now);
  const currentDom = parseInt(
    dateParts.find((p) => p.type === "day")?.value ?? "1",
  );
  const currentMonth = parseInt(
    dateParts.find((p) => p.type === "month")?.value ?? "1",
  );

  return (
    fieldMatches(parts[0], currentMinute, 0, 59) &&
    fieldMatches(parts[1], currentHour, 0, 23) &&
    fieldMatches(parts[2], currentDom, 1, 31) &&
    fieldMatches(parts[3], currentMonth, 1, 12) &&
    fieldMatches(parts[4], currentDow, 0, 6)
  );
}

/** Check if a single cron field matches a value. Supports *, ranges, lists, steps. */
function fieldMatches(
  field: string,
  value: number,
  min: number,
  max: number,
): boolean {
  if (field === "*") return true;

  for (const part of field.split(",")) {
    if (part.includes("/")) {
      const [range, stepStr] = part.split("/");
      const step = parseInt(stepStr);
      const start = range === "*" ? min : parseInt(range);
      for (let i = start; i <= max; i += step) {
        if (i === value) return true;
      }
    } else if (part.includes("-")) {
      const [startStr, endStr] = part.split("-");
      if (value >= parseInt(startStr) && value <= parseInt(endStr)) return true;
    } else {
      if (parseInt(part) === value) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Task watching (for Telegram broadcast + delivery verification)
// ---------------------------------------------------------------------------

interface PendingSchedule {
  name: string;
  delivery: string;
  emailTo: string | null;
}

const pendingScheduled = new Map<string, PendingSchedule>();

function watchScheduledTask(taskId: string, schedule: ScheduledTaskRow): void {
  pendingScheduled.set(taskId, {
    name: schedule.name,
    delivery: schedule.delivery,
    emailTo: schedule.email_to,
  });
}

/**
 * Handle a completed scheduled task. Broadcasts result via Telegram.
 * Verifies email delivery actually happened (gmail_send was called).
 * Called from the messaging router on task completion.
 */
export function handleScheduledTaskResult(
  taskId: string,
  result: string,
  status?: string,
  toolCalls?: string[],
): void {
  const meta = pendingScheduled.get(taskId);
  if (!meta) return;
  pendingScheduled.delete(taskId);

  const router = getRouter();

  // Verify email delivery: if the schedule required email, check gmail_send was called
  const expectsEmail = meta.delivery === "email" || meta.delivery === "both";
  const emailSent = toolCalls?.includes("gmail_send") ?? false;

  if (expectsEmail && !emailSent) {
    const alert =
      `⚠️ Scheduled task "${meta.name}" completed but email was NOT sent` +
      (meta.emailTo ? ` (to: ${meta.emailTo})` : "") +
      (status === "completed_with_concerns"
        ? ". Task had inference issues (wrap-up recovery)."
        : ". gmail_send was never called.");
    console.warn(`[schedules] DELIVERY MISS: ${alert}`);
    if (router) {
      router.broadcastToAll(alert).catch((err) => {
        console.error(`[schedules] Delivery alert broadcast failed: ${err}`);
      });
    }
    return;
  }

  // Broadcast result via Telegram if needed
  if (
    (meta.delivery === "telegram" || meta.delivery === "both") &&
    router &&
    result
  ) {
    router.broadcastToAll(result).catch((err) => {
      console.error(`[schedules] Broadcast failed: ${err}`);
    });
    console.log(`[schedules] Broadcast scheduled task result: ${taskId}`);
  }
}

/**
 * Handle a failed scheduled task. Alerts via Telegram.
 * Called from the messaging router on task failure.
 */
export function handleScheduledTaskFailure(
  taskId: string,
  error: string,
): void {
  const meta = pendingScheduled.get(taskId);
  if (!meta) return;
  pendingScheduled.delete(taskId);

  const alert = `⚠️ Scheduled task "${meta.name}" FAILED: ${error}`;
  console.error(`[schedules] ${alert}`);

  const router = getRouter();
  if (router) {
    router.broadcastToAll(alert).catch((err) => {
      console.error(`[schedules] Failure alert broadcast failed: ${err}`);
    });
  }
}

/**
 * Check if a task is a scheduled task (for router integration).
 */
export function isScheduledTask(taskId: string): boolean {
  return pendingScheduled.has(taskId);
}
