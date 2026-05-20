/**
 * Detection aggregator test (V8.1 Phase 5 B3) — runDetection().
 *
 * §12 Phase 5 item 3 asks for "detection on synthetic data + held-out
 * historical period". The synthetic-data half is these unit tests + the
 * per-detector suites. The held-out-historical half is a live verification
 * step: the detectors are run against the real `data/mc.db` (4 objectives /
 * 193 failed tasks / 10 stalled candidates) at ship time — it cannot be a
 * unit test (no historical fixture is checked into the repo).
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

  it("aggregates signals across every detector", () => {
    const db = getDatabase();
    // A stalled task.
    db.prepare(
      `INSERT INTO tasks (task_id, title, description, status, updated_at)
       VALUES ('stall-1', 'stalled', 'd', 'running', datetime('now','-20 days'))`,
    ).run();
    // A recurring blocker — 3 failed tasks, one signature.
    for (let i = 0; i < 3; i++) {
      db.prepare(
        `INSERT INTO tasks (task_id, title, description, status, error)
         VALUES (?, 'f', 'd', 'failed', 'shared blocker')`,
      ).run(`fail-${i}`);
    }
    const kinds = new Set(runDetection().map((s) => s.kind));
    expect(kinds.has("stalled_task")).toBe(true);
    expect(kinds.has("recurring_blocker")).toBe(true);
  });
});
