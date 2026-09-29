/**
 * Schedule tools — let the LLM create, list, run now, and delete recurring scheduled tasks.
 */

import { randomUUID } from "crypto";
import type { Tool } from "../types.js";
import { defineTool } from "../define-tool.js";
import {
  createSchedule,
  listSchedules,
  getSchedule,
  deleteSchedule,
  executeScheduleNow,
  inFlightScheduleRun,
  type ScheduledTaskRow,
} from "../../rituals/dynamic.js";
import { toMexTime } from "../../lib/timezone.js";
import { errMsg } from "../../lib/err-msg.js";
import {
  currentRunOrigin,
  currentRunTaskId,
  outsideRunToolContext,
} from "../rule-of-two.js";
import {
  declareReadbackGate,
  withdrawReadbackGate,
} from "../../lib/v8-4/readback.js";

// ---------------------------------------------------------------------------
// schedule_task
// ---------------------------------------------------------------------------

export const scheduleTaskTool: Tool = {
  name: "schedule_task",
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
  triggerPhrases: [
    "programa un reporte",
    "hazlo cada día",
    "repite esto todos los lunes",
    "schedule a daily report",
    "avísame cada hora",
  ],
  definition: {
    type: "function",
    function: {
      name: "schedule_task",
      description: `Create a recurring scheduled task that runs automatically on a cron schedule.

DO NOT USE WHEN: the user wants a calendar appointment or an entry on their agenda → calendar_create (a schedule runs Jarvis tasks; it is not a calendar event).
Use this when the user asks for recurring reports, daily summaries, periodic checks, or any task that should repeat on a schedule.

The task will be executed autonomously — you write the task description (what to do), specify the tools needed, and choose the delivery method (telegram, email, or both).

Examples:
- "Send me a daily AI news report at 8am" → cron "0 8 * * *", tools: ["web_search", "gmail_send"], delivery: "email"
- "Every Monday remind me of my weekly goals" → cron "0 9 * * 1", tools: ["jarvis_file_read"], delivery: "telegram"
- "Check my overdue tasks twice a day" → cron "0 9,18 * * *", tools: ["jarvis_file_read"], delivery: "telegram"

Cron format: minute hour day-of-month month day-of-week
- "0 8 * * *" = every day at 8:00 AM
- "0 8 * * 1-5" = weekdays at 8:00 AM
- "0 9,18 * * *" = twice daily at 9:00 AM and 6:00 PM
- "30 7 * * 1" = every Monday at 7:30 AM

All times are in the user's timezone (Mexico City).

DO NOT schedule tasks that send emails or modify data without explicit user request.
Scheduled tasks run AUTONOMOUSLY — only schedule read/report tasks unless the user specifically asks for write actions.

AFTER CREATING: Report the schedule name, cron in human-readable form, and delivery method.`,
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Short name for the schedule (e.g., 'AI News Report', 'Weekly Goals Review')",
          },
          description: {
            type: "string",
            description:
              "Full task description — what the agent should do when the schedule fires. Be specific: what to search, what to include, what format to use. This is the prompt the agent will receive.",
          },
          cron: {
            type: "string",
            description:
              'Cron expression (5 fields: minute hour dom month dow). Examples: "0 8 * * *" (daily 8am), "0 9 * * 1-5" (weekdays 9am). All times in Mexico City timezone.',
          },
          tools: {
            type: "array",
            items: { type: "string" },
            description:
              'Tool names the task needs. Common: ["web_search", "web_read"] for reports, ["jarvis_file_read"] for NorthStar tasks, ["gmail_send"] for email delivery.',
          },
          delivery: {
            type: "string",
            enum: ["telegram", "email", "both"],
            description:
              "How to deliver the result. 'telegram' = broadcast to chat, 'email' = send via gmail_send, 'both' = both channels.",
          },
          email_to: {
            type: "string",
            description:
              "Email recipient (required if delivery is 'email' or 'both'). Default: fede@eurekamd.net",
          },
          email_subject: {
            type: "string",
            description:
              "Email subject template (date appended automatically). Default: schedule name.",
          },
        },
        required: ["name", "description", "cron", "tools", "delivery"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const name = args.name as string;
    const description = args.description as string;
    const cronExpr = args.cron as string;
    const tools = args.tools as string[];
    const delivery = args.delivery as "telegram" | "email" | "both";
    const emailTo = args.email_to as string | undefined;
    const emailSubject = args.email_subject as string | undefined;

    // Validate cron (basic check)
    const cronParts = cronExpr.trim().split(/\s+/);
    if (cronParts.length !== 5) {
      return JSON.stringify({
        error:
          "Invalid cron expression — must have 5 fields: minute hour day-of-month month day-of-week",
      });
    }

    if ((delivery === "email" || delivery === "both") && !emailTo) {
      return JSON.stringify({
        error: "email_to is required when delivery is 'email' or 'both'",
      });
    }

    const scheduleId = randomUUID();
    try {
      createSchedule({
        scheduleId,
        name,
        description,
        cronExpr,
        tools,
        delivery,
        emailTo,
        emailSubject,
      });

      // Phase 2 read-back: the row must exist, be active and carry this cron.
      declareReadbackGate(
        currentRunTaskId(),
        "schedule_task",
        `schedule:${scheduleId}`,
        `Schedule «${name}» creado y activo`,
        { schedule_id: scheduleId, cron_expr: cronExpr },
      );

      // v6.4 OH1.5: Execute immediately so the user gets instant feedback
      // that the schedule works. Runs asynchronously — doesn't block the
      // tool response. Errors are logged, not propagated. Submitted outside
      // this chat run's context so it runs as a root task like the cron's
      // (see run_schedule below).
      outsideRunToolContext(() => executeScheduleNow(scheduleId)).catch(
        (err) => {
          console.error(
            `[schedule_task] Immediate execution failed: ${err instanceof Error ? err.message : err}`,
          );
        },
      );

      // CONTRACT: the top-level `schedule_id` field feeds V8.3's delete_inverse
      // completion (CREATION_BY_TOOL in lib/v8-3/gated-execution.ts). Renaming
      // it silently degrades every schedule_task decision to an unreplayable
      // null-pk reversal op — update that map in the same change.
      return JSON.stringify({
        success: true,
        schedule_id: scheduleId,
        name,
        cron: cronExpr,
        delivery,
        message: `Schedule "${name}" created and executing now. It will also run on cron "${cronExpr}" (Mexico City time) and deliver via ${delivery}.`,
      });
    } catch (err) {
      return JSON.stringify({
        error: `Failed to create schedule: ${err instanceof Error ? err.message : err}`,
      });
    }
  },
};

// ---------------------------------------------------------------------------
// list_schedules
// ---------------------------------------------------------------------------

export const listSchedulesTool: Tool = {
  name: "list_schedules",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
  definition: {
    type: "function",
    function: {
      name: "list_schedules",
      description: `List all active recurring scheduled tasks (reports, monitors, syncs). Shows: name, cron schedule, delivery method, and last run time.

DO NOT USE WHEN:
- The user asks about their agenda, meetings or events → use calendar_list.

USE WHEN:
- User asks "qué tareas tengo programadas", "mis schedules", "tareas recurrentes"
- User wants to verify a report is scheduled
- Before creating/deleting a schedule — check what already exists

RELATED: schedule_task (create), run_schedule (run now), delete_schedule (remove)`,
      parameters: {
        type: "object",
        properties: {
          include_inactive: {
            type: "boolean",
            description: "Include deactivated schedules. Default: false.",
          },
        },
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const includeInactive = args.include_inactive === true;
    const schedules = listSchedules(!includeInactive);

    if (schedules.length === 0) {
      return JSON.stringify({
        schedules: [],
        message: "No scheduled tasks found.",
      });
    }

    return JSON.stringify({
      schedules: schedules.map((s: ScheduledTaskRow) => ({
        schedule_id: s.schedule_id,
        name: s.name,
        cron: s.cron_expr,
        delivery: s.delivery,
        email_to: s.email_to,
        active: s.active === 1,
        last_run_at: toMexTime(s.last_run_at),
        created_at: toMexTime(s.created_at),
      })),
      count: schedules.length,
    });
  },
};

// ---------------------------------------------------------------------------
// run_schedule
// ---------------------------------------------------------------------------

/**
 * Schedules whose run_schedule submission is still being set up. Once
 * submitted, dynamic.ts tracks the run until its result or failure lands
 * (`inFlightScheduleRun`), so together they refuse a second run end to end.
 */
const runsStarting = new Set<string>();

// No V8.4 read-back gate and no provenance keys: the only claim is "started,
// task X", that task row is written before this tool returns, and delivery is
// checked by the spawned task's own ledger (handleScheduledTaskResult).
export const runScheduleTool: Tool = defineTool({
  name: "run_schedule",
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
  requiresConfirmation: true,
  triggerPhrases: [
    "ejecuta ahora el schedule",
    "corre el reporte ahora",
    "lanza la rutina",
    "run the schedule now",
  ],
  description: `Run an EXISTING recurring schedule now, on demand, outside its cron time. It is the same run the cron starts (same prompt, tools, gates and delivery: Telegram, email or both), marked as a manual run. It starts in the background and this tool returns at once; the report arrives later through the schedule's own delivery, not in this reply.

USE WHEN:
- "ejecuta ahora el schedule X", "corre el reporte ahora", "lanza la rutina de pharma", "run the daily report now"
- The user wants one extra run of a schedule that already exists

DO NOT USE WHEN:
- The schedule does not exist yet → schedule_task (it also runs once on creation)
- The user only wants to see the schedules or their last run → list_schedules
- The user wants to stop or remove a schedule → delete_schedule

Get schedule_id from list_schedules first. If the request does not make clear WHICH schedule, ask the user before calling: the run delivers, possibly an email to a third party. Refused when the id is unknown, the schedule is inactive (paused), a run of it is still in progress (no duplicate deliveries), or the caller is a background task (only a conversation with the user can start a run).

It is an extra run, not a re-send: it leaves out items already sent in earlier runs, and the items it sends count as sent for the next run. It does not re-send the last report.

AFTER STARTING: tell the user the run started and where the result will arrive (delivery, email_to).`,
  parameters: {
    type: "object",
    properties: {
      schedule_id: {
        type: "string",
        description:
          "The schedule_id of an existing schedule, as returned by list_schedules.",
      },
    },
    required: ["schedule_id"],
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    // No unbounded loops: a background run (cron, ritual, a run this tool
    // started) must not start schedules, or schedule A → B → A never ends.
    // The confirmation gate is skipped for non-interactive tasks, so this is
    // the only bound. No run context at all = the router's confirmed call.
    if (currentRunTaskId() && currentRunOrigin().source === "background") {
      return JSON.stringify({
        error:
          "run_schedule solo está disponible en una conversación con el operador; no se puede usar desde una tarea en segundo plano (programada, ritual o automática).",
      });
    }
    const scheduleId =
      typeof args.schedule_id === "string" ? args.schedule_id.trim() : "";
    if (!scheduleId) {
      return JSON.stringify({
        error: "Falta schedule_id — obtenlo con list_schedules.",
      });
    }
    const schedule = getSchedule(scheduleId);
    if (!schedule) {
      return JSON.stringify({
        error: `No existe el schedule ${scheduleId}. Usa list_schedules para obtener un schedule_id válido.`,
      });
    }
    if (schedule.active !== 1) {
      return JSON.stringify({
        error: `El schedule «${schedule.name}» está inactivo (pausado); no lo ejecuté. Reanúdalo con /rituales reanuda ${schedule.name} (o en el host: ./mc-ctl schedule-resume ${scheduleId}) y vuelve a pedirlo.`,
      });
    }
    const runningTaskId = inFlightScheduleRun(scheduleId);
    if (runsStarting.has(scheduleId) || runningTaskId) {
      return JSON.stringify({
        error: `Ya hay una ejecución de «${schedule.name}» en curso${runningTaskId ? ` (task ${runningTaskId})` : ""}; no inicio otra. Su resultado llegará por ${deliveryLabel(schedule)}.`,
      });
    }

    runsStarting.add(scheduleId);
    try {
      // Submitted OUTSIDE this chat run's context, like the cron poller: a
      // nested submit would share the chat run's tool set (both runs' Rule of
      // Two priors and failure records) and ledger the run as `operator` on
      // the chat thread instead of `background`. submitTask returns once the
      // task row exists — it does not wait for the report.
      const taskId = await outsideRunToolContext(() =>
        executeScheduleNow(scheduleId),
      );
      if (!taskId) {
        return JSON.stringify({
          error: `No existe el schedule ${scheduleId}. Usa list_schedules para obtener un schedule_id válido.`,
        });
      }
      return JSON.stringify({
        success: true,
        schedule_id: scheduleId,
        task_id: taskId,
        name: schedule.name,
        delivery: schedule.delivery,
        email_to: schedule.email_to,
        message: `Ejecución de «${schedule.name}» iniciada (task ${taskId}). El resultado llegará por ${deliveryLabel(schedule)} en unos minutos; no viene en esta respuesta.`,
      });
    } catch (err) {
      console.error(
        `[run_schedule] Failed to start "${schedule.name}" (${scheduleId}): ${errMsg(err)}`,
      );
      return JSON.stringify({
        error: `No pude iniciar «${schedule.name}»: ${errMsg(err)}`,
      });
    } finally {
      runsStarting.delete(scheduleId);
    }
  },
});

/** Where a schedule's result lands, in the words the user reads. */
function deliveryLabel(schedule: ScheduledTaskRow): string {
  const email = `email a ${schedule.email_to ?? "el destinatario por defecto"}`;
  if (schedule.delivery === "email") return email;
  if (schedule.delivery === "both") return `Telegram y ${email}`;
  return "Telegram";
}

// ---------------------------------------------------------------------------
// delete_schedule
// ---------------------------------------------------------------------------

export const deleteScheduleTool: Tool = {
  name: "delete_schedule",
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
  deferred: true,
  triggerPhrases: [
    "elimina la rutina",
    "elimina el schedule",
    "borra la rutina",
    "delete schedule",
    "quita esa programación",
    "cancela la rutina",
  ],
  definition: {
    type: "function",
    function: {
      name: "delete_schedule",
      description:
        "Delete a recurring scheduled task by its schedule_id. Use list_schedules first to find the ID.",
      parameters: {
        type: "object",
        properties: {
          schedule_id: {
            type: "string",
            description: "The schedule_id to delete.",
          },
        },
        required: ["schedule_id"],
      },
    },
  },
  requiresConfirmation: true,

  async execute(args: Record<string, unknown>): Promise<string> {
    const scheduleId = args.schedule_id as string;
    const deleted = deleteSchedule(scheduleId);

    if (deleted) {
      // A schedule created and deleted in the same task: its read-back is
      // moot, not failed (R1 audit C1).
      withdrawReadbackGate(
        currentRunTaskId(),
        "schedule_task",
        `schedule:${scheduleId}`,
        "deleted in the same task",
      );
      return JSON.stringify({
        success: true,
        message: `Schedule ${scheduleId} deleted.`,
      });
    }
    return JSON.stringify({
      error: `Schedule ${scheduleId} not found.`,
    });
  },
};
