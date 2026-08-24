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
import { parseGateSpecs, type GateSpec } from "../lib/v8-4/gates.js";
import { getRouter } from "../messaging/index.js";
import cron, { type ScheduledTask } from "node-cron";
import { scheduleCron } from "../lib/cron.js";
import { errMsg } from "../lib/err-msg.js";
import { PAUSE_SCHEDULE_TAG } from "../messaging/deliverable-filter.js";
import { cronMatchesAt } from "./cron-next.js";
import { applyRitualDeliveryPolicy } from "./delivery-policy.js";
import {
  consumeDeferralIds,
  deferredBlock,
  handlesIn,
  isMorningSync,
} from "./ritual-controls.js";
import {
  ensureSentItemsTable,
  recordSentItems,
  sentBeforeBlock,
} from "./sent-before.js";
import { getSyncSurfaceScheduleId } from "../lib/v8-2/flags.js";
import {
  markJudgmentSurfaced,
  pickSyncJudgment,
  renderSyncPromptContext,
  renderSyncStrategicLine,
  type StrategicInjection,
} from "../lib/v8-2/sync-surfacing.js";

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
  /** V8.4: JSON array of GateSpec — acceptance gates every run of this schedule must meet. */
  gates?: string | null;
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
  /** V8.4: acceptance gates for every run of this schedule (validated by parseGateSpecs). */
  gates?: GateSpec[];
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
  created_at      TEXT DEFAULT (datetime('now')),
  gates           TEXT
);
`;

export function ensureScheduledTasksTable(): void {
  const db = getDatabase();
  db.exec(CREATE_TABLE_SQL);
  // V8.4 (2026-08-16): additive column probe for pre-existing DBs — this
  // table is created lazily here, outside the schema.sql migration runner.
  const cols = db
    .prepare("SELECT name FROM pragma_table_info('scheduled_tasks')")
    .all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "gates")) {
    db.exec("ALTER TABLE scheduled_tasks ADD COLUMN gates TEXT");
  }
  // H3: Schedule run audit trail
  db.exec(`
    CREATE TABLE IF NOT EXISTS schedule_runs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id     TEXT NOT NULL,
      task_id         TEXT NOT NULL,
      spawned_at      TEXT DEFAULT (datetime('now')),
      status          TEXT DEFAULT 'running',
      result_summary  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sched_runs_schedule ON schedule_runs(schedule_id, spawned_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sched_runs_task ON schedule_runs(task_id);
  `);
}

// ---------------------------------------------------------------------------
// Schedule run tracking (Hermes H3)
// ---------------------------------------------------------------------------

function insertScheduleRun(scheduleId: string, taskId: string): void {
  const db = getDatabase();
  const existing = db
    .prepare(
      `SELECT 1 FROM schedule_runs
       WHERE schedule_id = ? AND spawned_at >= datetime('now', '-1 minute')
       LIMIT 1`,
    )
    .get(scheduleId);
  if (existing) return;
  db.prepare(
    "INSERT INTO schedule_runs (schedule_id, task_id) VALUES (?, ?)",
  ).run(scheduleId, taskId);
}

function updateScheduleRun(
  taskId: string,
  status: string,
  resultSummary?: string,
): void {
  getDatabase()
    .prepare(
      "UPDATE schedule_runs SET status = ?, result_summary = ? WHERE task_id = ?",
    )
    .run(status, resultSummary?.slice(0, 2000) ?? null, taskId);
}

export interface ScheduleRunRow {
  id: number;
  schedule_id: string;
  task_id: string;
  spawned_at: string;
  status: string;
  result_summary: string | null;
}

export function getScheduleRuns(
  scheduleId: string,
  limit = 20,
): ScheduleRunRow[] {
  return getDatabase()
    .prepare(
      `SELECT * FROM schedule_runs
       WHERE schedule_id = ?
       ORDER BY spawned_at DESC
       LIMIT ?`,
    )
    .all(scheduleId, limit) as ScheduleRunRow[];
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function createSchedule(params: CreateScheduleParams): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO scheduled_tasks (schedule_id, name, description, cron_expr, tools, delivery, email_to, email_subject, gates)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    params.scheduleId,
    params.name,
    params.description,
    params.cronExpr,
    JSON.stringify(params.tools),
    params.delivery,
    params.emailTo ?? null,
    params.emailSubject ?? null,
    params.gates?.length ? JSON.stringify(parseGateSpecs(params.gates)) : null,
  );
}

/**
 * V8.4: a schedule's acceptance gates, or [] when unset/malformed (a bad
 * gates column must never stop the ritual from running — it runs ungated
 * and the parse error is logged once per submission).
 */
export function scheduleGates(schedule: ScheduledTaskRow): GateSpec[] {
  if (!schedule.gates) return [];
  try {
    return parseGateSpecs(schedule.gates);
  } catch (err) {
    console.error(
      `[schedules] "${schedule.name}": invalid gates column — running ungated: ${errMsg(err)}`,
    );
    return [];
  }
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

/** `/rituales pausa|reanuda` for DB schedules (Phase 5.5). */
export function setScheduleActive(scheduleId: string, active: boolean): boolean {
  const result = getDatabase()
    .prepare("UPDATE scheduled_tasks SET active = ? WHERE schedule_id = ?")
    .run(active ? 1 : 0, scheduleId);
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

/**
 * Strategic-surface injection (V8.2 sync-surfacing, operator ruling 2026-08-03).
 * When this schedule is the designated Morning Sync surface
 * (`V82_SYNC_SCHEDULE_ID`), pick today's vetted judgment: its prompt block is
 * spliced into the task description, and the compact line travels with the
 * pending-task meta so `handleScheduledTaskResult` can append it to the
 * outbound message and stamp `surfaced_at` after a verified delivery.
 *
 * Exported for tests. Failure-isolated: any V8.2 read error degrades to a plain
 * Sync (null), never sinks the schedule — observability, not a gate.
 */
export function maybeStrategicInjection(
  schedule: ScheduledTaskRow,
): StrategicInjection | null {
  const target = getSyncSurfaceScheduleId();
  if (!target || schedule.schedule_id !== target) return null;
  // The line ships on the telegram broadcast leg only. "email" never
  // broadcasts (qa R1-W3), and "both" loses the line silently when a
  // gmail_send miss short-circuits into the retry branch before the
  // broadcast (qa R2-W2) — so inject for exactly "telegram".
  if (schedule.delivery !== "telegram") return null;
  // One strategic run in flight per schedule: a manual run-now racing the
  // 08:00 cron would otherwise pick the same still-unstamped judgment twice
  // and double-append it to the operator (qa R1-W1). Logged because a leaked
  // entry here would otherwise suppress the surface invisibly (qa R2-C1 —
  // the cancelled-task path now cleans up via handleScheduledTaskFailure).
  for (const [pendingTaskId, pending] of pendingScheduled.entries()) {
    if (pending.scheduleId === schedule.schedule_id && pending.strategic) {
      console.log(
        `[schedules] strategic injection suppressed — run ${pendingTaskId} already in flight for this schedule`,
      );
      return null;
    }
  }
  try {
    const j = pickSyncJudgment();
    if (!j) return null;
    return {
      judgmentId: j.id,
      line: renderSyncStrategicLine(j),
      promptBlock: renderSyncPromptContext(j),
    };
  } catch (err) {
    console.error(
      `[schedules] strategic injection failed (sync unaffected): ${errMsg(err)}`,
    );
    return null;
  }
}

/**
 * Execute a schedule immediately (v6.4 OH1.5).
 * Called after schedule creation so the user gets instant feedback
 * that the report works without waiting for the next cron match.
 */
/**
 * Phase 5 prompt blocks: the Morning Sync receives yesterday's deferred
 * pushes (5.6/5.5); every other schedule receives its own sent-before list
 * (5.1) — the only lever for email-delivered schedules the seam never sees.
 * Failures degrade to "" (the schedule runs as before).
 */
export function promptExtras(schedule: ScheduledTaskRow): { text: string; deferralIds: number[] } {
  try {
    if (isMorningSync(schedule)) {
      const d = deferredBlock();
      return { text: d.block, deferralIds: d.ids };
    }
    ensureSentItemsTable();
    return { text: sentBeforeBlock(`schedule:${schedule.schedule_id}`), deferralIds: [] };
  } catch (err) {
    console.error(`[schedules] prompt extras failed for "${schedule.name}":`, errMsg(err));
    return { text: "", deferralIds: [] };
  }
}

export async function executeScheduleNow(
  scheduleId: string,
): Promise<string | null> {
  const schedule = getSchedule(scheduleId);
  if (!schedule) return null;

  const now = new Date();
  const todayLabel = now.toLocaleDateString("en-CA", {
    timeZone: process.env.RITUALS_TIMEZONE ?? "America/Mexico_City",
  });
  const tools = JSON.parse(schedule.tools) as string[];

  let deliveryInstructions = "";
  if (schedule.delivery === "email" || schedule.delivery === "both") {
    deliveryInstructions += `\n\nEnvía el resultado por email usando gmail_send a ${schedule.email_to ?? "fede@eurekamd.net"} con asunto "${schedule.email_subject ?? schedule.name} — ${todayLabel}".`;
    if (!tools.includes("gmail_send")) tools.push("gmail_send");
  }
  if (schedule.delivery === "telegram" || schedule.delivery === "both") {
    deliveryInstructions +=
      "\n\nTu texto final ES el mensaje que se enviará automáticamente por Telegram. NO busques ni intentes usar herramientas de envío (Telegram, Gmail, etc.) ni menciones limitaciones de entrega — solo compón el contenido.";
  }

  const strategic = maybeStrategicInjection(schedule);
  const dateContext = buildDateContext(now, true);
  const extras = promptExtras(schedule);
  const result = await submitTask({
    title: `[Scheduled] ${schedule.name} — ${todayLabel}`,
    description: `${dateContext}${schedule.description}${extras.text}${strategic ? `\n${strategic.promptBlock}` : ""}${deliveryInstructions}`,
    agentType: "fast",
    tools,
    gates: scheduleGates(schedule),
    gatesSource: "ritual",
    tags: ["scheduled", "immediate", `schedule:${schedule.schedule_id}`],
    interactive: false,
  });

  insertScheduleRun(schedule.schedule_id, result.taskId);
  watchScheduledTask(result.taskId, schedule, 0, strategic, true, extras.deferralIds);
  markExecuted(schedule.schedule_id);
  return result.taskId;
}

// ---------------------------------------------------------------------------
// Execution engine
// ---------------------------------------------------------------------------

const TIMEZONE = process.env.RITUALS_TIMEZONE ?? "America/Mexico_City";
let pollingJob: ScheduledTask | null = null;

/**
 * Build a precise date+time context header for scheduled task prompts.
 * Injects the authoritative date, day-of-week, and time in CDMX timezone
 * so agents never need to calculate or infer the current day themselves.
 * This prevents day-of-week calculation bugs (e.g. 2026-06-29 = lunes
 * being miscalculated as domingo).
 */
function buildDateContext(now: Date, manual = false): string {
  const dateLabel = now.toLocaleDateString("en-CA", { timeZone: TIMEZONE }); // YYYY-MM-DD
  const dayName = now.toLocaleDateString("es-MX", {
    timeZone: TIMEZONE,
    weekday: "long",
  }); // lunes, martes, etc.
  const timeLabel = now.toLocaleTimeString("es-MX", {
    timeZone: TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }); // HH:MM
  // Phase 0.2 (usability plan 2026-08-22): a manual "run now" fires outside
  // the schedule's window — the 2026-08-03 "Son las 8am del lunes" brief went
  // out at 17:15. Say so, so the prompt's own clock words don't win.
  const manualNote = manual
    ? "[Ejecución manual fuera del horario programado — usa la fecha y hora reales de arriba, no las del horario.]\n\n"
    : "";
  return `[Hoy: ${dateLabel} (${dayName}), ${timeLabel} CDMX]\n\n${manualNote}`;
}

/**
 * Start the dynamic schedule executor.
 * Checks every minute if any scheduled tasks are due.
 */
export function startDynamicScheduler(): void {
  ensureScheduledTasksTable();

  // Check every minute if any cron expressions match
  pollingJob = scheduleCron(
    "dynamic-schedules-poller",
    "* * * * *",
    () => {
      checkAndExecuteSchedules().catch((err) => {
        console.error(`[schedules] Execution error: ${errMsg(err)}`);
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
        deliveryInstructions += `\n\nEnvía el resultado por email usando gmail_send a ${schedule.email_to ?? "fede@eurekamd.net"} con asunto "${schedule.email_subject ?? schedule.name} — ${todayLabel}".`;
        if (!tools.includes("gmail_send")) tools.push("gmail_send");
      }
      if (schedule.delivery === "telegram" || schedule.delivery === "both") {
        deliveryInstructions +=
          "\n\nTu texto final ES el mensaje que se enviará automáticamente por Telegram. NO busques ni intentes usar herramientas de envío (Telegram, Gmail, etc.) ni menciones limitaciones de entrega — solo compón el contenido.";
      }

      const strategic = maybeStrategicInjection(schedule);
      const dateContext = buildDateContext(now);
      const extras = promptExtras(schedule);
      const result = await submitTask({
        title: `[Scheduled] ${schedule.name} — ${todayLabel}`,
        description: `${dateContext}${schedule.description}${extras.text}${strategic ? `\n${strategic.promptBlock}` : ""}${deliveryInstructions}`,
        agentType: "fast",
        tools,
        gates: scheduleGates(schedule),
        gatesSource: "ritual",
        tags: ["scheduled", `schedule:${schedule.schedule_id}`],
        interactive: false,
      });

      // H3: Record execution in audit trail
      insertScheduleRun(schedule.schedule_id, result.taskId);
      // Watch for result to verify delivery and broadcast
      watchScheduledTask(result.taskId, schedule, 0, strategic, false, extras.deferralIds);
    } catch (err) {
      const message = errMsg(err);
      console.error(
        `[schedules] Failed to submit "${schedule.name}": ${message}`,
      );
      // markExecuted already ran, so this day's slot is consumed with no
      // retry until the next cron match — at minimum the failure must be
      // observable by the reaction rules that watch schedule.run_failed
      // (previously this was a log-only dead end).
      try {
        const { getEventBus } = await import("../lib/event-bus.js");
        getEventBus().emitEvent("schedule.run_failed", {
          ritual_id: schedule.schedule_id,
          error: message.slice(0, 1000),
          phase: "submit",
        });
      } catch (busErr) {
        console.error(
          `[schedules] run_failed event emit failed:`,
          errMsg(busErr),
        );
      }
    }
  }
}

/**
 * Check if a cron expression matches the current time (1-minute window, in
 * the scheduler timezone). The matcher itself lives in cron-next.ts so
 * `/rituales` can reuse it for next-fire computation.
 */
function cronMatchesNow(cronExpr: string, now: Date): boolean {
  if (!cron.validate(cronExpr)) return false;
  return cronMatchesAt(cronExpr, now, TIMEZONE);
}

// ---------------------------------------------------------------------------
// Task watching (for Telegram broadcast + delivery verification)
// ---------------------------------------------------------------------------

interface PendingSchedule {
  name: string;
  delivery: string;
  emailTo: string | null;
  scheduleId: string;
  /** How many times this execution has been retried after delivery miss. */
  retryCount: number;
  /** Set when this run carries the day's strategic reading (sync-surfacing):
   *  the line is appended to the outbound message and `surfaced_at` stamped on
   *  verified delivery. In-memory only — a restart between submit and
   *  completion loses it, which fails SAFE (no stamp, judgment stays eligible). */
  strategic?: StrategicInjection | null;
  /** Operator-triggered run (`/run`): never muted or budget-deferred. */
  manual?: boolean;
  /** Morning Sync only: deferral ids folded into its prompt — consumed on delivery of their handles. */
  deferralIds?: number[];
}

const pendingScheduled = new Map<string, PendingSchedule>();

/** Exported for tests (the strategic-delivery seam is exercised through
 *  `handleScheduledTaskResult`, which reads this map). */
export function watchScheduledTask(
  taskId: string,
  schedule: ScheduledTaskRow,
  retryCount = 0,
  strategic: StrategicInjection | null = null,
  manual = false,
  deferralIds: number[] = [],
): void {
  pendingScheduled.set(taskId, {
    name: schedule.name,
    delivery: schedule.delivery,
    emailTo: schedule.email_to,
    scheduleId: schedule.schedule_id,
    retryCount,
    strategic,
    manual,
    deferralIds,
  });
}

/**
 * Handle a completed scheduled task. Broadcasts result via Telegram.
 * Verifies email delivery actually happened (gmail_send was called).
 * Called from the messaging router on task completion.
 */

/** Re-submit a scheduled task after delivery miss (v6.4 ST1). */
async function retryScheduledTask(
  schedule: ScheduledTaskRow,
  retryCount: number,
): Promise<void> {
  const now = new Date();
  const todayLabel = now.toLocaleDateString("en-CA", { timeZone: TIMEZONE });
  const tools = JSON.parse(schedule.tools) as string[];

  let deliveryInstructions = "";
  if (schedule.delivery === "email" || schedule.delivery === "both") {
    deliveryInstructions += `\n\nIMPORTANT: THIS IS A RETRY — the previous attempt failed to send email. You MUST call gmail_send to ${schedule.email_to ?? "fede@eurekamd.net"} with subject "${schedule.email_subject ?? schedule.name} — ${todayLabel}". Do NOT skip the email step.`;
    if (!tools.includes("gmail_send")) tools.push("gmail_send");
  }

  const dateContext = buildDateContext(now);
  const extras = promptExtras(schedule);
  const result = await submitTask({
    title: `[Retry] ${schedule.name} — ${todayLabel}`,
    description: `${dateContext}${schedule.description}${extras.text}${deliveryInstructions}`,
    agentType: "fast",
    tools,
    gates: scheduleGates(schedule),
    gatesSource: "ritual",
    tags: ["scheduled", "retry", `schedule:${schedule.schedule_id}`],
    interactive: false,
  });

  insertScheduleRun(schedule.schedule_id, result.taskId);
  watchScheduledTask(result.taskId, schedule, retryCount, null, false, extras.deferralIds);
}

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
    // Auto-retry once on delivery miss (v6.4 ST1)
    if (meta.retryCount < 1) {
      console.warn(
        `[schedules] DELIVERY MISS — retrying "${meta.name}" (attempt ${meta.retryCount + 1})`,
      );
      updateScheduleRun(taskId, "delivery_miss", result?.slice(0, 500));
      const schedule = getSchedule(meta.scheduleId);
      if (schedule) {
        retryScheduledTask(schedule, meta.retryCount + 1).catch((err) => {
          console.error(
            `[schedules] Retry failed for "${meta.name}": ${errMsg(err)}`,
          );
        });
        return;
      }
    }

    // Retry exhausted or schedule not found — alert user
    const alert =
      `⚠️ Scheduled task "${meta.name}" completed but email was NOT sent` +
      (meta.emailTo ? ` (to: ${meta.emailTo})` : "") +
      (meta.retryCount > 0
        ? ". Auto-retry also failed."
        : status === "completed_with_concerns"
          ? ". Task had inference issues (wrap-up recovery)."
          : ". gmail_send was never called.");
    console.warn(`[schedules] DELIVERY MISS: ${alert}`);
    if (router) {
      router.broadcastToAll(alert, undefined, { raw: true }).catch((err) => {
        console.error(`[schedules] Delivery alert broadcast failed: ${err}`);
      });
    }
    return;
  }

  // Delivery verified — mark as completed in audit trail (after delivery check, audit C2)
  updateScheduleRun(taskId, "completed", result?.slice(0, 500));

  // Phase 0.3 (operator ruling 1, 2026-08-22): a schedule whose prompt
  // decides it has repeated unanswered too often ends its text with
  // PAUSE_SCHEDULE_TAG. The scheduler deactivates the row here — the model
  // has no tool for that — and the broadcast below carries the question
  // (the tag itself is stripped by the deliverable filter). Re-enable:
  //   ./mc-ctl db "UPDATE scheduled_tasks SET active=1 WHERE schedule_id='<id>'"
  if (result?.includes(PAUSE_SCHEDULE_TAG)) {
    const paused = deactivateSchedule(meta.scheduleId);
    console.warn(
      `[schedules] "${meta.name}" requested pause (${PAUSE_SCHEDULE_TAG}) — ${paused ? "deactivated" : "already inactive"}`,
    );
  }

  const ritualKey = `schedule:${meta.scheduleId}`;

  // Phase 5.1: an email-only schedule (Pharma) never reaches the broadcast
  // seam — its items are ledgered here so the next run's prompt lists them.
  if (meta.delivery === "email" && result) {
    try {
      ensureSentItemsTable();
      recordSentItems(ritualKey, taskId, result);
    } catch (err) {
      console.error(`[schedules] sent-before ledger failed for "${meta.name}":`, errMsg(err));
    }
  }

  // Broadcast result via Telegram if needed
  if (
    (meta.delivery === "telegram" || meta.delivery === "both") &&
    router &&
    result
  ) {
    // Sync-surfacing: the strategic line is appended DETERMINISTICALLY (the
    // prompt block is flavor; this is the delivery contract), and the consent
    // stamp is written only when ≥1 channel actually delivered — a resolved
    // broadcast with 0 sends must not claim the operator saw the judgment.
    const strategic = meta.strategic;
    const composed = strategic ? `${result}\n\n${strategic.line}` : result;
    // Phase 5: scheduled broadcasts go through the same seam as rituals
    // (sent-before, mute, reading budget). Morning Sync always delivers.
    const decision = applyRitualDeliveryPolicy(ritualKey, taskId, composed, {
      displayName: meta.name,
      scheduleId: meta.scheduleId,
      emailed: meta.delivery === "both",
      forced: meta.manual === true,
    });
    if (!decision.deliver) {
      console.log(
        `[schedules] "${meta.name}" not broadcast (${decision.reason})` +
          (strategic ? ` — strategic reading NOT stamped: judgment #${strategic.judgmentId}` : ""),
      );
      return;
    }
    const outbound = decision.text;
    const folded = meta.deferralIds ?? [];
    router
      .broadcastToAll(outbound)
      .then((tally) => {
        // Phase 5.6 (R2 W5 / R3 W2): the deferrals folded into this Morning
        // Sync are consumed only once it was delivered AND only those whose
        // handle the delivered text actually carries — a dropped fold stays
        // pending and re-lists tomorrow.
        if (folded.length > 0 && tally.sent > 0) {
          try {
            const echoed = handlesIn(outbound).filter((id) => folded.includes(id));
            const n = consumeDeferralIds(echoed);
            const missing = folded.length - echoed.length;
            console.log(
              `[schedules] "${meta.name}" delivered — ${n} deferral(s) consumed` +
                (missing > 0 ? `, ${missing} NOT echoed by the model (still pending)` : ""),
            );
          } catch (err) {
            console.error(`[schedules] consumeDeferrals failed:`, errMsg(err));
          }
        }
        if (!strategic) return;
        if (tally.sent > 0) {
          try {
            const stamped = markJudgmentSurfaced(strategic.judgmentId);
            console.log(
              `[schedules] strategic reading surfaced: judgment #${strategic.judgmentId}` +
                (stamped ? "" : " (already stamped)"),
            );
          } catch (err) {
            console.error(
              `[schedules] surfaced_at stamp failed for judgment #${strategic.judgmentId}: ${errMsg(err)}`,
            );
          }
        } else {
          console.warn(
            `[schedules] strategic reading NOT stamped (0 channels delivered): judgment #${strategic.judgmentId}`,
          );
        }
      })
      .catch((err) => {
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
  updateScheduleRun(taskId, "failed", error?.slice(0, 500));

  const alert = `⚠️ Scheduled task "${meta.name}" FAILED: ${error}`;
  console.error(`[schedules] ${alert}`);

  const router = getRouter();
  if (router) {
    router.broadcastToAll(alert, undefined, { raw: true }).catch((err) => {
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
