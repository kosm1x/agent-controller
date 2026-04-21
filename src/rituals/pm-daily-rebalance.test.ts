import { describe, it, expect } from "vitest";
import { createPmDailyRebalance } from "./pm-daily-rebalance.js";
import { rituals } from "./config.js";

describe("createPmDailyRebalance", () => {
  it("submission wires the 3-tool PM pipeline", () => {
    const sub = createPmDailyRebalance("2026-04-21");
    expect(sub.tools).toContain("prediction_markets");
    expect(sub.tools).toContain("pm_alpha_run");
    expect(sub.tools).toContain("pm_paper_rebalance");
  });

  it("requires pm_paper_rebalance (the terminal write)", () => {
    const sub = createPmDailyRebalance("2026-04-21");
    expect(sub.requiredTools).toEqual(["pm_paper_rebalance"]);
  });

  it("agentType=fast (fast-runner tool loop)", () => {
    const sub = createPmDailyRebalance("2026-04-21");
    expect(sub.agentType).toBe("fast");
  });

  it("description teaches cadence='daily' on the rebalance call", () => {
    const sub = createPmDailyRebalance("2026-04-21");
    expect(sub.description).toMatch(/cadence="daily"/);
  });

  it("description instructs pipeline order refresh → alpha → rebalance", () => {
    const sub = createPmDailyRebalance("2026-04-21");
    const idxRefresh = sub.description.indexOf("prediction_markets");
    const idxAlpha = sub.description.indexOf("pm_alpha_run");
    const idxRebal = sub.description.indexOf("pm_paper_rebalance");
    expect(idxRefresh).toBeGreaterThan(-1);
    expect(idxAlpha).toBeGreaterThan(idxRefresh);
    expect(idxRebal).toBeGreaterThan(idxAlpha);
  });
});

describe("pm-daily-rebalance ritual config", () => {
  it("is registered in rituals[] with correct cron + tz", () => {
    const r = rituals.find((x) => x.id === "pm-daily-rebalance");
    expect(r).toBeDefined();
    expect(r?.cron).toBe("0 6 * * *");
    expect(r?.timezone).toBe("America/New_York");
    expect(r?.enabled).toBe(true);
  });

  it("cron fires daily (no weekday restriction)", () => {
    const r = rituals.find((x) => x.id === "pm-daily-rebalance");
    // Cron syntax: dow field is last (*/all days). equity rituals use "1-5".
    expect(r?.cron.split(" ").pop()).toBe("*");
  });
});
