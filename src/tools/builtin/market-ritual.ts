/**
 * F9 Morning/EOD Rituals — read-only helper tools.
 *
 * market_calendar       — is today an NYSE trading day? early close?
 * alert_budget_status   — how much daily token budget is left for a ritual?
 *
 * Both deferred, both read-only. Used by the morning/EOD ritual templates to
 * gate expensive paths.
 */

import type { Tool } from "../types.js";
import {
  holidayFor,
  isEarlyClose,
  isNyseTradingDay,
  nextTradingDay,
  prevTradingDay,
  toNyDate,
} from "../../finance/market-calendar.js";
import {
  DEFAULT_LIMITS,
  getBudgetForDate,
  getBudgetStatus,
} from "../../rituals/alert-budget.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// market_calendar
// ---------------------------------------------------------------------------

export const marketCalendarTool: Tool = {
  name: "market_calendar",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "market_calendar",
      description: `Check whether a date is an NYSE trading day, early-close half-day, or full-day holiday. Also returns the next + previous trading days for scheduling follow-ups.

USE WHEN: a ritual needs to decide whether to fire (gate on trading-day), or when the operator asks "is tomorrow / next Friday a trading day?", "mercado abre mañana?", "feriado", "half-day".

NOT WHEN: you need intraday market hours (returns day-granular data only).

Read-only, <1ms. Covers NYSE 2024–2027.`,
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description:
              "YYYY-MM-DD in America/New_York. Defaults to today in NY.",
          },
        },
        required: [],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const raw = args.date as string | undefined;
    if (raw != null && !DATE_RE.test(raw)) {
      return `market_calendar: date must be YYYY-MM-DD (got '${raw}').`;
    }
    const iso = raw ? toNyDate(raw) : toNyDate(new Date());
    const trading = isNyseTradingDay(iso);
    const early = isEarlyClose(iso);
    const h = holidayFor(iso);
    const next = nextTradingDay(iso);
    const prev = prevTradingDay(iso);
    const lines: string[] = [];
    lines.push(
      `market_calendar: date=${iso}  trading=${trading}  early_close=${early}`,
    );
    if (h) {
      lines.push(
        `  holiday: ${h.reason}${h.earlyClose ? " (early close 13:00 ET)" : ""}`,
      );
    }
    lines.push(`  prev_trading=${prev}  next_trading=${next}`);
    return lines.join("\n");
  },
};

// ---------------------------------------------------------------------------
// alert_budget_status
// ---------------------------------------------------------------------------

export const alertBudgetStatusTool: Tool = {
  name: "alert_budget_status",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "alert_budget_status",
      description: `Return the daily token budget remaining for a ritual (or all rituals). Used by the morning/EOD scan rituals to degrade gracefully when the day's cap is exhausted.

USE WHEN: a ritual is deciding whether to fire the expensive LLM path, or the operator asks "cuánto budget queda hoy", "alert budget left".

Read-only, <1ms. Budget resets at midnight America/New_York.`,
      parameters: {
        type: "object",
        properties: {
          ritual_id: {
            type: "string",
            enum: ["market-morning-scan", "market-eod-scan"],
            description:
              "Filter to a specific ritual. Omit to list all tracked rituals for the date.",
          },
          date: {
            type: "string",
            description:
              "YYYY-MM-DD in America/New_York. Defaults to today in NY.",
          },
        },
        required: [],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const ritualId = args.ritual_id as string | undefined;
    const raw = args.date as string | undefined;
    if (raw != null && !DATE_RE.test(raw)) {
      return `alert_budget_status: date must be YYYY-MM-DD (got '${raw}').`;
    }
    const iso = raw ? toNyDate(raw) : toNyDate(new Date());

    if (ritualId) {
      // Audit W2 round 1: read-only by design. When no row exists yet
      // (fresh day), synthesize a zero-consumption default from DEFAULT_LIMITS
      // instead of writing a row. The DB write now happens only through
      // `consumeBudget`, preserving the tool description's read-only claim.
      const existing = getBudgetStatus(ritualId, iso);
      if (existing) {
        return `alert_budget_status: date=${iso} ritual=${ritualId} consumed=${existing.consumed}/${existing.limit} remaining=${existing.remaining} exhausted=${existing.exhausted}`;
      }
      const limit = DEFAULT_LIMITS[ritualId] ?? 10_000;
      return `alert_budget_status: date=${iso} ritual=${ritualId} consumed=0/${limit} remaining=${limit} exhausted=false`;
    }

    // All known rituals for the date
    const all = getBudgetForDate(iso);
    const lines: string[] = [];
    lines.push(`alert_budget_status: date=${iso}`);
    if (all.length === 0) {
      lines.push(
        `  (no rituals consumed budget yet today; defaults: ${Object.entries(
          DEFAULT_LIMITS,
        )
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")})`,
      );
    } else {
      for (const s of all) {
        lines.push(
          `  ${s.ritualId.padEnd(22)} consumed=${s.consumed}/${s.limit} remaining=${s.remaining} exhausted=${s.exhausted}`,
        );
      }
    }
    return lines.join("\n");
  },
};

export const marketRitualTools: Tool[] = [
  marketCalendarTool,
  alertBudgetStatusTool,
];
