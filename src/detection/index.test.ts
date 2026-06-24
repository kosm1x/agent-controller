/**
 * Detection aggregator test — runDetection().
 *
 * As of 2026-06-23 the only production detector is `detectStalledProjects`
 * (day-log-grounded). The legacy NorthStar / task-table detectors are RETIRED
 * (operator ruling — the day-log is the only record of work done); this test
 * pins that runDetection emits `stalled_project` and NEVER the retired kinds,
 * even when the conditions those detectors fired on are present.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { runDetection } from "./index.js";

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

describe("runDetection", () => {
  it("returns an empty list when nothing is detectable", () => {
    expect(runDetection()).toEqual([]);
  });

  it("emits stalled_project from the day-log and NOT the retired detector kinds", () => {
    const db = getDatabase();
    // An active project with no day-log mention → should surface.
    db.prepare(
      `INSERT INTO projects (id, slug, name) VALUES ('p1','salones-wa','Salones WA')`,
    ).run();
    db.prepare(
      `INSERT INTO jarvis_files (id, path, title, content)
       VALUES ('dl','logs/day-logs/2026-06-23.md','Day Log','trabajé en pipesong')`,
    ).run();
    // Conditions the RETIRED detectors used to fire on — a stalled task + a
    // recurring blocker. They must NOT appear, proving the detectors are off.
    db.prepare(
      `INSERT INTO tasks (task_id, title, description, status, updated_at)
       VALUES ('stall-1','stalled','d','running', datetime('now','-20 days'))`,
    ).run();
    for (let i = 0; i < 3; i++) {
      db.prepare(
        `INSERT INTO tasks (task_id, title, description, status, error)
         VALUES (?, 'f', 'd', 'failed', 'shared blocker')`,
      ).run(`fail-${i}`);
    }
    const kinds = new Set(runDetection().map((s) => s.kind));
    expect(kinds.has("stalled_project")).toBe(true);
    expect(kinds.has("stalled_task")).toBe(false);
    expect(kinds.has("recurring_blocker")).toBe(false);
    expect(kinds.has("dormant_objective")).toBe(false);
  });
});
