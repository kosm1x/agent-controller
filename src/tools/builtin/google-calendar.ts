/**
 * Google Calendar tools — list and create events.
 */

import type { Tool } from "../types.js";
import { googleFetch } from "../../google/client.js";

// ---------------------------------------------------------------------------
// calendar_list
// ---------------------------------------------------------------------------

export const calendarListTool: Tool = {
  name: "calendar_list",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "calendar_list",
      description: `List upcoming events from Google Calendar.

USE WHEN:
- The user asks about their schedule, meetings, or events
- You need to check availability before creating an event
- The user asks "what's on my calendar" or "do I have meetings today"`,
      parameters: {
        type: "object",
        properties: {
          time_min: {
            type: "string",
            description:
              "Start of time range (ISO 8601, e.g., '2026-03-17T00:00:00-06:00'). Defaults to now.",
          },
          time_max: {
            type: "string",
            description:
              "End of time range (ISO 8601). Defaults to 7 days from now.",
          },
          max_results: {
            type: "number",
            description: "Max events to return (1-20, default: 10)",
          },
        },
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const now = new Date();
    const timeMin = (args.time_min as string) ?? now.toISOString();
    const weekLater = new Date(now.getTime() + 7 * 86400000);
    const timeMax = (args.time_max as string) ?? weekLater.toISOString();
    const maxResults = Math.min(
      Math.max((args.max_results as number) ?? 10, 1),
      20,
    );

    try {
      const result = await googleFetch<{
        items?: Array<{
          id: string;
          summary: string;
          start: { dateTime?: string; date?: string };
          end: { dateTime?: string; date?: string };
          location?: string;
          description?: string;
          attendees?: Array<{ email: string; responseStatus: string }>;
        }>;
      }>(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&maxResults=${maxResults}&singleEvents=true&orderBy=startTime`,
      );

      const events = (result.items ?? []).map((e) => ({
        id: e.id,
        title: e.summary,
        start: e.start.dateTime ?? e.start.date,
        end: e.end.dateTime ?? e.end.date,
        location: e.location ?? null,
        description: e.description ? e.description.slice(0, 200) : null,
        attendees: e.attendees?.map((a) => a.email) ?? [],
      }));

      return JSON.stringify({ events, total: events.length });
    } catch (err) {
      return JSON.stringify({
        error: `Calendar list failed: ${err instanceof Error ? err.message : err}`,
      });
    }
  },
};

// ---------------------------------------------------------------------------
// calendar_create
// ---------------------------------------------------------------------------

export const calendarCreateTool: Tool = {
  name: "calendar_create",
  requiresConfirmation: true,
  riskTier: "medium",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "calendar_create",
      description: `Create a new event in Google Calendar.

USE WHEN:
- The user asks to schedule a meeting, event, or reminder
- The user says "agenda", "programa", "pon en calendario"

Times must be in ISO 8601 format with timezone offset (e.g., '2026-03-18T10:00:00-06:00' for Mexico City).
Use the current date/time from the prompt to calculate correct dates.

AFTER CREATING: Report the event title, date/time, and calendar link.`,
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Event title",
          },
          start: {
            type: "string",
            description:
              "Start time (ISO 8601 with timezone, e.g., '2026-03-18T10:00:00-06:00')",
          },
          end: {
            type: "string",
            description:
              "End time (ISO 8601 with timezone, e.g., '2026-03-18T11:00:00-06:00')",
          },
          description: {
            type: "string",
            description: "Event description (optional)",
          },
          location: {
            type: "string",
            description: "Event location (optional)",
          },
          attendees: {
            type: "array",
            items: { type: "string" },
            description: "Email addresses of attendees (optional)",
          },
        },
        required: ["title", "start", "end"],
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const title = args.title as string;
    const start = args.start as string;
    const end = args.end as string;
    const description = args.description as string | undefined;
    const location = args.location as string | undefined;
    const attendees = args.attendees as string[] | undefined;

    try {
      const event: Record<string, unknown> = {
        summary: title,
        start: { dateTime: start },
        end: { dateTime: end },
      };
      if (description) event.description = description;
      if (location) event.location = location;
      if (attendees?.length) {
        event.attendees = attendees.map((email) => ({ email }));
      }

      const result = await googleFetch<{
        id: string;
        htmlLink: string;
        summary: string;
      }>("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
        method: "POST",
        body: event,
      });

      return JSON.stringify({
        created: true,
        id: result.id,
        title: result.summary,
        url: result.htmlLink,
        start,
        end,
      });
    } catch (err) {
      return JSON.stringify({
        error: `Calendar create failed: ${err instanceof Error ? err.message : err}`,
      });
    }
  },
};

// ---------------------------------------------------------------------------
// calendar_update
// ---------------------------------------------------------------------------

export const calendarUpdateTool: Tool = {
  name: "calendar_update",
  requiresConfirmation: true,
  riskTier: "medium",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "calendar_update",
      description: `Update or cancel a Google Calendar event.

WORKFLOW: Call calendar_list first to find the event ID, then update it here.
To cancel an event, set status to "cancelled".`,
      parameters: {
        type: "object",
        properties: {
          event_id: {
            type: "string",
            description: "Event ID (from calendar_list)",
          },
          title: { type: "string", description: "New title (optional)" },
          start: {
            type: "string",
            description: "New start time ISO 8601 (optional)",
          },
          end: {
            type: "string",
            description: "New end time ISO 8601 (optional)",
          },
          description: {
            type: "string",
            description: "New description (optional)",
          },
          status: {
            type: "string",
            enum: ["confirmed", "cancelled"],
            description: "Set to 'cancelled' to delete the event",
          },
        },
        required: ["event_id"],
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const eventId = args.event_id as string;

    try {
      const updates: Record<string, unknown> = {};
      if (args.title) updates.summary = args.title;
      if (args.start) updates.start = { dateTime: args.start };
      if (args.end) updates.end = { dateTime: args.end };
      if (args.description) updates.description = args.description;
      if (args.status) updates.status = args.status;

      if (Object.keys(updates).length === 0) {
        return JSON.stringify({ error: "No fields to update" });
      }

      const result = await googleFetch<{ id: string; summary: string }>(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`,
        { method: "PATCH", body: updates },
      );

      return JSON.stringify({
        updated: true,
        id: result.id,
        title: result.summary,
      });
    } catch (err) {
      return JSON.stringify({
        error: `Calendar update failed: ${err instanceof Error ? err.message : err}`,
      });
    }
  },
};
