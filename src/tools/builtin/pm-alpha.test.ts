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

import { pmAlphaRunTool, pmAlphaLatestTool } from "./pm-alpha.js";

/** Seed enough prediction_markets + sentiment for a meaningful run. */
function seedMarkets(
  opts: {
    count?: number;
    category?: string;
    cryptoQuestions?: boolean;
    resolutionDate?: string;
    liquidity?: number;
  } = {},
) {
  const n = opts.count ?? 5;
  const category = opts.category ?? "Politics";
  const resDate = opts.resolutionDate ?? "2026-07-15T00:00:00Z";
  const liq = opts.liquidity ?? 50_000;
  const insert = db.prepare(
    `INSERT INTO prediction_markets
      (source, market_id, slug, question, category, resolution_date,
       outcome_tokens, volume_usd, liquidity_usd, is_neg_risk)
     VALUES ('polymarket', ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  );
  for (let i = 0; i < n; i++) {
    const outcomes = JSON.stringify([
      { id: `yes-${i}`, label: "Yes", price: 0.4 },
      { id: `no-${i}`, label: "No", price: 0.6 },
    ]);
    const question = opts.cryptoQuestions
      ? `Will BTC reach $200K by month ${i}?`
      : `Will event ${i} happen?`;
    insert.run(
      `0xmarket-${i}`,
      `slug-${i}`,
      question,
      category,
      resDate,
      outcomes,
      100_000,
      liq,
    );
  }
}

function seedSentiment(fg: number) {
  db.prepare(
    `INSERT INTO sentiment_readings
      (source, indicator, symbol, value, value_text, observed_at)
     VALUES ('alternative_me', 'fear_greed', NULL, ?, ?, '2026-04-20T00:00:00Z')`,
  ).run(fg, fg < 25 ? "Extreme Fear" : fg > 75 ? "Extreme Greed" : "Neutral");
}

describe("pmAlphaRunTool", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("reports clear error when no markets exist", async () => {
    const out = (await pmAlphaRunTool.execute({})) as string;
    expect(out).toMatch(/no prediction_markets rows/);
  });

  it("runs end-to-end and persists to pm_signal_weights", async () => {
    seedMarkets({ count: 3 });
    seedSentiment(50);
    const out = (await pmAlphaRunTool.execute({})) as string;
    expect(out).toContain("pm_alpha_run:");
    expect(out).toContain("run_id=");
    expect(out).toContain("nMarkets=3");

    const rowCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM pm_signal_weights`).get() as {
        n: number;
      }
    ).n;
    // 3 markets × 2 outcomes = 6 rows
    expect(rowCount).toBe(6);
  });

  it("crypto-UP + extreme fear produces non-zero weights", async () => {
    seedMarkets({ count: 2, cryptoQuestions: true });
    seedSentiment(15); // extreme fear
    const out = (await pmAlphaRunTool.execute({})) as string;
    expect(out).toContain("pm_alpha_run:");
    // Should surface at least one token in top list
    expect(out).toMatch(/top \d+ by \|weight\|/);
  });

  it("override_config applies custom kelly scale", async () => {
    seedMarkets({ count: 2, cryptoQuestions: true });
    seedSentiment(15);
    const out = (await pmAlphaRunTool.execute({
      override_config: JSON.stringify({ kellyScale: 0.01 }),
    })) as string;
    // smaller kelly scale → smaller total exposure
    expect(out).toContain("pm_alpha_run:");
  });

  it("rejects malformed override_config JSON", async () => {
    seedMarkets({ count: 1 });
    const out = (await pmAlphaRunTool.execute({
      override_config: "{not json",
    })) as string;
    expect(out).toMatch(/invalid JSON/);
  });

  it("rejects override_config with non-numeric field", async () => {
    seedMarkets({ count: 1 });
    const out = (await pmAlphaRunTool.execute({
      override_config: JSON.stringify({ kellyScale: "high" }),
    })) as string;
    expect(out).toMatch(/must be a finite number/);
  });

  it("surfaces exclusion breakdown when markets excluded", async () => {
    // Near-resolution markets (< 1 day from now)
    seedMarkets({
      count: 3,
      resolutionDate: new Date(Date.now() + 2 * 3600_000).toISOString(), // 2h out
    });
    const out = (await pmAlphaRunTool.execute({})) as string;
    expect(out).toMatch(/exclusions:/);
    expect(out).toMatch(/near_resolution/);
  });
});

describe("pmAlphaLatestTool", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("returns no-runs message when empty", async () => {
    const out = (await pmAlphaLatestTool.execute({})) as string;
    expect(out).toMatch(/no runs found/);
  });

  it("returns latest run summary after pm_alpha_run", async () => {
    seedMarkets({ count: 2 });
    seedSentiment(50);
    await pmAlphaRunTool.execute({});
    const out = (await pmAlphaLatestTool.execute({})) as string;
    expect(out).toContain("pm_alpha_latest:");
    expect(out).toContain("run_id=");
    expect(out).toMatch(/nMarkets=2/);
  });
});
