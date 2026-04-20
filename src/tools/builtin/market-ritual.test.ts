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

describe("marketCalendarTool", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("reports a regular weekday as trading", async () => {
    const out = (await marketCalendarTool.execute({
      date: "2026-04-20",
    })) as string;
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

  it("rejects malformed date", async () => {
    const out = (await marketCalendarTool.execute({
      date: "banana",
    })) as string;
    expect(out).toMatch(/must be YYYY-MM-DD/);
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
    expect(out).toContain("alert_budget_status:");
    expect(out).toContain("date=2026-04-20");
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

  it("rejects malformed date", async () => {
    const out = (await alertBudgetStatusTool.execute({
      date: "banana",
    })) as string;
    expect(out).toMatch(/must be YYYY-MM-DD/);
  });
});
