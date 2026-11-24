import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { resolve } from "path";

let db: Database.Database;

function freshDb() {
  const d = new Database(":memory:");
  const schema = readFileSync(
    resolve(__dirname, "../../db/schema.sql"),
    "utf8",
  );
  const f1 = schema.substring(schema.indexOf("-- F1 Data Layer"));
  d.exec(f1);
  return d;
}

vi.mock("../../db/index.js", () => ({
  getDatabase: () => db,
}));

import { marketCalendarTool, alertBudgetStatusTool } from "./market-ritual.js";

/**
 * A failure is one JSON object whose first key is `error`, with nothing
 * before the opening brace: the registry and the fast runner read the start
 * of the text to decide that a call failed. Returns the error words.
 */
function errorWords(out: string): string {
  expect(out.startsWith('{"error":')).toBe(true);
  const parsed = JSON.parse(out) as Record<string, unknown>;
  expect(Object.keys(parsed)[0]).toBe("error");
  expect(typeof parsed.error).toBe("string");
  return parsed.error as string;
}

describe("marketCalendarTool", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("reports a regular weekday as trading", async () => {
    const out = (await marketCalendarTool.execute({
      date: "2026-04-20",
    })) as string;
    expect(
      out.startsWith("market_calendar: date=2026-04-20  trading=true"),
    ).toBe(true);
    expect(out).toContain("trading=true");
    expect(out).toContain("early_close=false");
    expect(out).toContain("prev_trading=");
    expect(out).toContain("next_trading=");
  });

  it("reports a holiday", async () => {
    const out = (await marketCalendarTool.execute({
      date: "2026-05-25",
    })) as string;
    expect(out).toContain("trading=false");
    expect(out).toMatch(/holiday:.*Memorial/);
  });

  it("reports an early-close day", async () => {
    const out = (await marketCalendarTool.execute({
      date: "2026-11-27",
    })) as string;
    expect(out).toContain("early_close=true");
    expect(out).toMatch(/13:00 ET/);
  });

  it("reports a weekend", async () => {
    const out = (await marketCalendarTool.execute({
      date: "2026-04-18", // Saturday
    })) as string;
    expect(out).toContain("trading=false");
  });

  it("rejects a malformed date with an error object", async () => {
    const out = (await marketCalendarTool.execute({
      date: "banana",
    })) as string;
    expect(errorWords(out)).toBe(
      "market_calendar: date must be YYYY-MM-DD (got 'banana').",
    );
  });
});

describe("alertBudgetStatusTool", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("returns defaults for an untouched date", async () => {
    const out = (await alertBudgetStatusTool.execute({
      date: "2026-04-20",
    })) as string;
    expect(out.startsWith("alert_budget_status: date=2026-04-20")).toBe(true);
    expect(out).toMatch(/no rituals consumed budget yet|market-morning-scan/);
  });

  it("returns per-ritual status when ritual_id given", async () => {
    const out = (await alertBudgetStatusTool.execute({
      ritual_id: "market-morning-scan",
      date: "2026-04-20",
    })) as string;
    expect(out).toContain("ritual=market-morning-scan");
    expect(out).toContain("consumed=0/");
    expect(out).toContain("exhausted=false");
  });

  it("rejects a malformed date with an error object", async () => {
    const out = (await alertBudgetStatusTool.execute({
      date: "banana",
    })) as string;
    expect(errorWords(out)).toBe(
      "alert_budget_status: date must be YYYY-MM-DD (got 'banana').",
    );
  });
});

// Description pins: each tool's whole description text as registered.
describe("tool description texts", () => {
  it("pins the whole alert_budget_status description", () => {
    expect(alertBudgetStatusTool.definition.function.description).toBe(`Return the daily token budget remaining for a market scan ritual (or both). Used by the morning/EOD scan rituals to degrade gracefully when the day's cap is exhausted.

USE WHEN: a ritual is deciding whether to fire the expensive LLM path, or the operator asks "cuánto budget queda hoy", "alert budget left".

Read-only. Budget resets at midnight America/New_York.

DO NOT USE WHEN:
- You want market-data provider call counts or rate limits: this tool reads only the token budget of the two market scan rituals — use market_budget_stats when it is among your tools.
- You want the token use of another ritual, a chat or a task: only the two ritual_id values are ever counted.
- You want the budget raised, reset or spent: it only reads.`);
  });
});
