/**
 * Schedule tools — let the LLM create, list, and delete recurring scheduled tasks.
 */

import { randomUUID } from "crypto";
import type { Tool } from "../types.js";
import {
  createSchedule,
  listSchedules,
  deleteSchedule,
  type ScheduledTaskRow,
} from "../../rituals/dynamic.js";
import { toMexTime } from "../../lib/timezone.js";

// ---------------------------------------------------------------------------
// schedule_task
// ---------------------------------------------------------------------------

export const scheduleTaskTool: Tool = {
  name: "schedule_task",
  definition: {
    type: "function",
    function: {
      name: "schedule_task",
      description: `Create a recurring scheduled task that runs automatically on a cron schedule.
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

      return JSON.stringify({
        success: true,
        schedule_id: scheduleId,
        name,
        cron: cronExpr,
        delivery,
        message: `Schedule "${name}" created. It will run on cron "${cronExpr}" (Mexico City time) and deliver via ${delivery}.`,
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
  definition: {
    type: "function",
    function: {
      name: "list_schedules",
      description:
        "List all active recurring scheduled tasks. Shows name, cron schedule, delivery method, and last run time.",
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
// delete_schedule
// ---------------------------------------------------------------------------

export const deleteScheduleTool: Tool = {
  name: "delete_schedule",
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
