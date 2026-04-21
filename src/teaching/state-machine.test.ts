import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDatabase, closeDatabase } from "../db/index.js";
import {
  createPlanWithUnits,
  updateUnitStatus,
  getPlan,
  getUnit,
} from "./persist.js";
import { advance, resolveUnit, targetDifficulty } from "./state-machine.js";

beforeEach(() => {
  initDatabase(":memory:");
});
afterEach(() => {
  closeDatabase();
});

function makePlan(unitCount: number): string {
  const units = Array.from({ length: unitCount }, (_, i) => ({
    title: `unit ${i}`,
    summary: "s",
    predicted_difficulties: [],
    prerequisites: i === 0 ? [] : [i - 1],
  }));
  return createPlanWithUnits({ topic: "t", units });
}

describe("advance", () => {
  it("blocks advance when current unit mastery < 0.7", () => {
    const plan_id = makePlan(3);
    updateUnitStatus(plan_id, 0, "in_progress", 0.4);
    const r = advance(plan_id);
    expect(r.advanced).toBe(false);
    expect(r.reason).toMatch(/mastery/);
  });

  it("advances when current unit mastery >= 0.7", () => {
    const plan_id = makePlan(3);
    updateUnitStatus(plan_id, 0, "in_progress", 0.75);
    const r = advance(plan_id);
    expect(r.advanced).toBe(true);
    expect(r.next_unit?.index).toBe(1);
    expect(getUnit(plan_id, 0)?.status).toBe("mastered");
    expect(getUnit(plan_id, 1)?.status).toBe("ready");
    expect(getPlan(plan_id)?.current_unit).toBe(1);
  });

  it("force=true bypasses mastery threshold", () => {
    const plan_id = makePlan(3);
    const r = advance(plan_id, true);
    expect(r.advanced).toBe(true);
    expect(r.next_unit?.index).toBe(1);
  });

  it("force=true marks low-mastery current as 'skipped' (not fabricated mastered)", () => {
    const plan_id = makePlan(2);
    // mastery_score stays at 0 (default); force bypasses the block.
    advance(plan_id, true);
    const unit0 = getUnit(plan_id, 0);
    expect(unit0?.status).toBe("skipped");
    expect(unit0?.mastery_score).toBe(0); // not fabricated to 0.7
  });

  it("force=true on genuinely mastered current still uses 'mastered' status", () => {
    const plan_id = makePlan(2);
    updateUnitStatus(plan_id, 0, "in_progress", 0.9);
    advance(plan_id, true);
    expect(getUnit(plan_id, 0)?.status).toBe("mastered");
  });

  it("skipped units satisfy prereq for next-next advance", () => {
    // Plan where unit 2 requires unit 1 — if unit 1 is skipped, unit 2 should
    // still be able to advance.
    const plan_id = createPlanWithUnits({
      topic: "t",
      units: [
        {
          title: "a",
          summary: "s",
          predicted_difficulties: [],
          prerequisites: [],
        },
        {
          title: "b",
          summary: "s",
          predicted_difficulties: [],
          prerequisites: [0],
        },
        {
          title: "c",
          summary: "s",
          predicted_difficulties: [],
          prerequisites: [1],
        },
      ],
    });
    // Force-advance past 0 (low mastery → skipped), then past 1 (also low).
    advance(plan_id, true);
    advance(plan_id, true);
    const unit2 = getUnit(plan_id, 2);
    expect(unit2?.status).toBe("ready");
  });

  it("blocks when current unit has low mastery and force is not set", () => {
    const plan_id = createPlanWithUnits({
      topic: "t",
      units: [
        {
          title: "a",
          summary: "s",
          predicted_difficulties: [],
          prerequisites: [],
        },
        {
          title: "b",
          summary: "s",
          predicted_difficulties: [],
          prerequisites: [0],
        },
      ],
    });
    updateUnitStatus(plan_id, 0, "in_progress", 0.3); // below threshold
    const r = advance(plan_id);
    expect(r.advanced).toBe(false);
    expect(r.reason).toMatch(/mastery/);
  });

  it("marks plan completed when all units mastered", () => {
    const plan_id = makePlan(2);
    updateUnitStatus(plan_id, 0, "in_progress", 0.8);
    const r1 = advance(plan_id);
    expect(r1.advanced).toBe(true);
    updateUnitStatus(plan_id, 1, "in_progress", 0.8);
    const r2 = advance(plan_id);
    expect(r2.advanced).toBe(true);
    expect(r2.plan_status).toBe("completed");
    expect(getPlan(plan_id)?.status).toBe("completed");
  });

  it("returns descriptive error on missing plan", () => {
    const r = advance("no-such-plan");
    expect(r.advanced).toBe(false);
    expect(r.reason).toMatch(/not found/);
  });
});

describe("resolveUnit", () => {
  it("falls back to current_unit when unit_index omitted", () => {
    const plan_id = makePlan(2);
    const u = resolveUnit(plan_id);
    expect(u?.unit_index).toBe(0);
  });

  it("returns null for unknown plan", () => {
    expect(resolveUnit("unknown")).toBeNull();
  });
});

describe("targetDifficulty", () => {
  it("< 0.3 → easy", () => {
    expect(targetDifficulty(0.1)).toBe("easy");
  });
  it("0.3-0.7 → medium", () => {
    expect(targetDifficulty(0.5)).toBe("medium");
  });
  it("> 0.7 → hard", () => {
    expect(targetDifficulty(0.85)).toBe("hard");
  });
});
