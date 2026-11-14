/**
 * The ritual scheduler's two exported task statements on the real schema
 * (`initDatabase(":memory:")`), run directly — the scheduler itself is never
 * started (no cron, no timers). One ritual title has a row in every status;
 * titles dated the day before and the day after must stay out, and a title
 * with only a cancelled row has a later-dated title after it. Fixtures are
 * synthetic.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { ALREADY_RAN_TODAY_SQL, ATTEMPTS_ON_SQL } from "./scheduler.js";

const TITLE = "Nightly close — 2026-11-05";
const BEFORE = "Nightly close — 2026-11-04";
const AFTER = "Nightly close — 2026-11-06";
const ONLY_CANCELLED = "Nightly close — 2026-11-07";

const STATUSES = [
  "pending", "classifying", "queued", "running", "completed",
  "completed_with_concerns", "needs_context", "blocked", "failed", "cancelled",
];

let seq = 0;
function task(title: string, status: string, metadata: string | null): void {
  seq++;
  getDatabase()
    .prepare("INSERT INTO tasks (task_id, title, description, status, metadata) VALUES (?, ?, 'd', ?, ?)")
    .run(`t-sched-${seq}`, title, status, metadata);
}

beforeEach(() => {
  initDatabase(":memory:");
  for (const s of STATUSES) task(TITLE, s, `{"attempt":"${s}"}`);
  task(BEFORE, "failed", '{"attempt":"before"}');
  task(AFTER, "failed", '{"attempt":"after"}');
  task(ONLY_CANCELLED, "cancelled", null);
  task("Nightly close — 2026-11-08", "failed", null);
});
afterEach(() => closeDatabase());

describe("ATTEMPTS_ON_SQL", () => {
  it("returns every non-cancelled attempt of this title with its metadata", () => {
    const rows = getDatabase().prepare(ATTEMPTS_ON_SQL).all(TITLE) as Array<{
      status: string;
      metadata: string;
    }>;
    const expected = STATUSES.filter((s) => s !== "cancelled")
      .map((s) => ({ status: s, metadata: `{"attempt":"${s}"}` }))
      .sort((x, y) => x.status.localeCompare(y.status));
    expect([...rows].sort((x, y) => x.status.localeCompare(y.status))).toEqual(expected);
  });
});

describe("ALREADY_RAN_TODAY_SQL", () => {
  it("finds a non-cancelled row of this title; a title with only a cancelled row finds none", () => {
    expect(getDatabase().prepare(ALREADY_RAN_TODAY_SQL).get(TITLE)).toEqual({ 1: 1 });
    expect(getDatabase().prepare(ALREADY_RAN_TODAY_SQL).get(ONLY_CANCELLED)).toBeUndefined();
  });
});
