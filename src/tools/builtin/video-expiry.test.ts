/**
 * video_create's lazy clean-up of expired jobs, on the real schema.
 *
 * `video_jobs.expires_at` is written with toISOString() (`T…Z`), so the
 * "has expired" bound must be ISO too: a zone-less datetime('now') bound sorts
 * below every ISO value of its own calendar date, and a job would only expire
 * once the UTC date changed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The clean-up removes each expired job's work folder; mocked so no path on
// disk is touched.
const cleanupJob = vi.hoisted(() => vi.fn());
vi.mock("../../video/composer.js", () => ({ cleanupJob }));

import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import { videoCreateTool } from "./video.js";

beforeEach(() => initDatabase(":memory:"));
afterEach(() => {
  closeDatabase();
  vi.clearAllMocks();
});

describe("video_create — lazy clean-up of expired jobs", () => {
  it("deletes a finished job that expired a second ago and keeps one expiring in a minute", async () => {
    const isoIn = (ms: number): string => new Date(Date.now() + ms).toISOString();
    const ins = getDatabase().prepare(
      "INSERT INTO video_jobs (job_id, topic, status, expires_at) VALUES (?, 't', ?, ?)",
    );
    ins.run("expired", "completed", isoIn(-1_000));
    ins.run("live", "completed", isoIn(60_000));
    // Two active jobs fill the concurrency cap, so the handler stops right
    // after the clean-up and starts no pipeline.
    ins.run("busy-1", "composing", isoIn(60_000));
    ins.run("busy-2", "composing", isoIn(60_000));

    const out = await videoCreateTool.execute({ topic: "t" });
    expect(out).toContain("Too many active video jobs");

    const left = getDatabase()
      .prepare("SELECT job_id FROM video_jobs ORDER BY job_id")
      .all() as Array<{ job_id: string }>;
    expect(left.map((r) => r.job_id)).toEqual(["busy-1", "busy-2", "live"]);
    await vi.waitFor(() => expect(cleanupJob).toHaveBeenCalledWith("expired"));
    expect(cleanupJob).toHaveBeenCalledTimes(1);
  });
});
