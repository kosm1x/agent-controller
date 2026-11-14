/**
 * The video-jobs SQL of the video tools on the real schema through
 * initDatabase(":memory:"): job creation, the status updates of a pipeline,
 * the shared concurrency cap, cancel, clean-up and the brand lookup.
 *
 * Every effect besides the database is stubbed. The script writer, image
 * fetcher, subtitles, narration, composer, HTML parser and HTML renderer are
 * mocked; child processes throw if started; and `fs` calls on a path under
 * the live work folders are neutralised (folder creation recorded and
 * skipped, existence reported false, removal refused) while every other path
 * reaches the real `fs`. The JS clock is fixed so expiry and cut-off values
 * are exact; the lazy expiry compares against the database clock, so those
 * seeds use explicit UTC strings far in the past or future.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => ({
  LIVE: ["/tmp/video-jobs", "/root/tmp-video-html", "/root/tmp-video-frames"],
  liveMkdir: [] as string[],
  liveExists: [] as string[],
  cleanupJob: vi.fn(),
  composeVideo: vi.fn(),
  generateScript: vi.fn(),
  fetchImage: vi.fn(),
  generateSubtitles: vi.fn(),
  generateNarration: vi.fn(),
  parseHtmlComposition: vi.fn(),
  renderHtmlComposition: vi.fn(),
}));

// Fail closed: folder creation under a live folder is recorded and skipped,
// the database setup's `mkdirSync(dirname(":memory:"))` (the current folder,
// which exists) is skipped, every other folder creation and every removal
// throws.
vi.mock("fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("fs")>();
  const live = (p: unknown): boolean =>
    typeof p === "string" &&
    m.LIVE.some((root) => p === root || p.startsWith(`${root}/`));
  return {
    ...real,
    mkdirSync: ((p: string) => {
      if (live(p)) {
        m.liveMkdir.push(p);
        return undefined;
      }
      if (p === ".") return undefined;
      throw new Error(`refused: unexpected mkdirSync ${String(p)}`);
    }) as typeof real.mkdirSync,
    existsSync: (p: string) => {
      if (live(p)) {
        m.liveExists.push(p);
        return false;
      }
      return real.existsSync(p);
    },
    rmSync: ((p: string) => {
      throw new Error(`refused: rmSync ${String(p)}`);
    }) as typeof real.rmSync,
  };
});

// Every export of child_process throws: no process can start.
vi.mock("child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("child_process")>();
  const refuse = () => {
    throw new Error("refused: no child process in this test");
  };
  const refused = Object.fromEntries(
    Object.keys(real)
      .filter((k) => k !== "default")
      .map((k) => [k, refuse]),
  );
  return { ...refused, default: refused };
});

vi.mock("../../video/composer.js", () => ({
  cleanupJob: m.cleanupJob,
  composeVideo: m.composeVideo,
}));
vi.mock("../../video/script-generator.js", () => ({
  generateScript: m.generateScript,
}));
vi.mock("../../video/images.js", () => ({ fetchImage: m.fetchImage }));
vi.mock("../../video/subtitles.js", () => ({
  generateSubtitles: m.generateSubtitles,
}));
vi.mock("../../video/tts.js", () => ({
  generateNarration: m.generateNarration,
}));
vi.mock("../../video/html-parser.js", () => ({
  parseHtmlComposition: m.parseHtmlComposition,
}));
vi.mock("../../video/html-renderer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../video/html-renderer.js")>()),
  renderHtmlComposition: m.renderHtmlComposition,
}));

import { existsSync } from "fs";
import { initDatabase, closeDatabase } from "../../db/index.js";
import {
  videoCreateTool,
  videoStatusTool,
  videoComposeManifestTool,
  videoJobCancelTool,
  videoJobCleanupTool,
  videoBrandApplyTool,
  videoHtmlComposeTool,
} from "./video.js";

const NOW = new Date("2030-06-15T10:00:00.000Z");
const NOW_ISO = NOW.toISOString();
const NOW_PLUS_24H = "2030-06-16T10:00:00.000Z";
const hoursAgo = (h: number): string =>
  new Date(NOW.getTime() - h * 3600_000).toISOString();
const PAST = "2000-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";

let db: ReturnType<typeof initDatabase>;

function seedJob(
  jobId: string,
  status: string,
  opts: { completedAt?: string | null; expiresAt?: string } = {},
): void {
  db.prepare(
    `INSERT INTO video_jobs (job_id, topic, status, completed_at, expires_at)
     VALUES (?, 'synthetic', ?, ?, ?)`,
  ).run(jobId, status, opts.completedAt ?? null, opts.expiresAt ?? FUTURE);
}

type JobRow = Record<string, unknown>;
const jobRow = (jobId: string): JobRow | undefined =>
  db.prepare("SELECT * FROM video_jobs WHERE job_id = ?").get(jobId) as
    | JobRow
    | undefined;
const jobIds = (): string[] =>
  (
    db.prepare("SELECT job_id FROM video_jobs ORDER BY job_id").all() as Array<{
      job_id: string;
    }>
  ).map((r) => r.job_id);

/**
 * Waits (bounded) until a started pipeline has written its terminal status.
 * It yields to the event loop instead of vi.waitFor, which would advance the
 * fixed clock.
 */
async function settled(jobId: string): Promise<JobRow> {
  for (let i = 0; i < 200; i++) {
    const status = jobRow(jobId)?.status;
    if (status === "completed" || status === "failed") break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return jobRow(jobId) as JobRow;
}

const SCRIPT = {
  title: "Synthetic",
  scenes: [
    { text: "Scene one.", duration: 10, imageQuery: "q1", transition: "fade" },
    { text: "Scene two.", duration: 10, imageQuery: "q2", transition: "fade" },
  ],
  totalDuration: 20,
  language: "es",
};

const MANIFEST = {
  version: 1,
  title: "Synthetic manifest",
  template: "portrait",
  fps: 30,
  language: "es",
  scenes: [
    { index: 0, durationSec: 4.4, text: "First." },
    { index: 1, durationSec: 5.2, text: "Second.", imageQuery: "q" },
  ],
};

const COMPOSITION = {
  htmlPath: "/synthetic/composition.html",
  totalDurationSec: 2.5,
  dataDrivenDurationSec: 2.5,
  elements: [{}, {}],
  hasSeekFn: false,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  db = initDatabase(":memory:");
  // The live-folder stub must be in place before any handler builds a path
  // under a live folder: a read-only existence probe proves it, or no case
  // runs.
  m.liveExists.length = 0;
  existsSync("/tmp/video-jobs");
  if (m.liveExists.length !== 1) throw new Error("live-folder fs stub missing");
  m.liveMkdir.length = 0;
  m.liveExists.length = 0;
  m.generateScript.mockResolvedValue(SCRIPT);
  m.fetchImage.mockResolvedValue(undefined);
  m.generateNarration.mockImplementation(async (_t: string, out: string) => out);
  m.composeVideo.mockResolvedValue("/synthetic/output.mp4");
  m.parseHtmlComposition.mockReturnValue(COMPOSITION);
});

afterEach(() => {
  closeDatabase();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("video_create on the real schema", () => {
  it("creates the job, runs the pipeline's updates to completed, and expires only finished jobs past their expiry", async () => {
    seedJob("old-done", "completed", { expiresAt: PAST });
    seedJob("old-live", "pending", { expiresAt: PAST });
    seedJob("new-done", "failed", { expiresAt: FUTURE });

    const out = JSON.parse(
      await videoCreateTool.execute({
        topic: "Synthetic topic",
        duration: 30,
        template: "square",
      }),
    ) as { jobId: string; status: string };
    expect(out.status).toBe("pending");

    const row = await settled(out.jobId);
    expect(m.liveMkdir).toEqual([`/tmp/video-jobs/${out.jobId}`]);
    expect(row).toMatchObject({
      status: "completed",
      topic: "Synthetic topic",
      duration_seconds: 30,
      template: "square",
      expires_at: NOW_PLUS_24H,
      output_file: "/synthetic/output.mp4",
      completed_at: NOW_ISO,
      error_message: null,
    });
    expect(JSON.parse(row.script_json as string)).toEqual(SCRIPT);
    expect(JSON.parse(row.assets_json as string)).toEqual({
      audio: `/tmp/video-jobs/${out.jobId}/narration.mp3`,
      images: [0, 1].map((i) => `/tmp/video-jobs/${out.jobId}/scene-00${i}.jpg`),
      subtitles: `/tmp/video-jobs/${out.jobId}/subtitles.srt`,
    });

    expect(jobIds()).toEqual([out.jobId, "new-done", "old-live"].sort());
    expect(m.cleanupJob).toHaveBeenCalledTimes(1);
    expect(m.cleanupJob).toHaveBeenCalledWith("old-done");
  });

  it("records the failure on the row when the pipeline throws", async () => {
    m.generateScript.mockRejectedValue(new Error("synthetic script failure"));
    const out = JSON.parse(await videoCreateTool.execute({ topic: "t" })) as {
      jobId: string;
    };
    const row = await settled(out.jobId);
    expect(row).toMatchObject({
      status: "failed",
      error_message: "synthetic script failure",
      template: "landscape",
      duration_seconds: 60,
    });
  });

  it("refuses at two jobs in an active status and counts no other status", async () => {
    seedJob("a-1", "generating_assets");
    seedJob("a-2", "composing");
    const refused = await videoCreateTool.execute({ topic: "t" });
    expect(refused).toContain("Too many active video jobs (2/2)");
    expect(jobIds()).toEqual(["a-1", "a-2"]);
  });
});

describe("video_status on the real schema", () => {
  it("reads the job row by id", async () => {
    seedJob("s-1", "failed", { completedAt: hoursAgo(1) });
    db.prepare(
      "UPDATE video_jobs SET error_message = 'synthetic error', output_file = '/synthetic/o.mp4' WHERE job_id = 's-1'",
    ).run();
    const status = JSON.parse(
      await videoStatusTool.execute({ job_id: "s-1" }),
    ) as Record<string, unknown>;
    expect(status).toMatchObject({
      jobId: "s-1",
      status: "failed",
      topic: "synthetic",
      duration: 60,
      template: "landscape",
      outputFile: "/synthetic/o.mp4",
      error: "synthetic error",
    });
    expect(await videoStatusTool.execute({ job_id: "missing" })).toContain(
      "Job missing not found",
    );
  });
});

describe("video_compose_manifest on the real schema", () => {
  it("stores the manifest row and runs its pipeline to completed", async () => {
    // Statuses outside the active list do not count toward the cap.
    seedJob("p-1", "pending");
    seedJob("c-1", "completed");
    seedJob("f-1", "failed");
    seedJob("a-1", "scripting");

    const out = JSON.parse(
      await videoComposeManifestTool.execute({ manifest: MANIFEST }),
    ) as { jobId: string; status: string; total_duration_seconds: number };
    expect(out.status).toBe("pending");
    expect(out.total_duration_seconds).toBe(10);

    const row = await settled(out.jobId);
    expect(m.liveMkdir).toEqual([`/tmp/video-jobs/${out.jobId}`]);
    expect(row).toMatchObject({
      status: "completed",
      topic: "Synthetic manifest",
      duration_seconds: 10,
      template: "portrait",
      expires_at: NOW_PLUS_24H,
      output_file: "/synthetic/output.mp4",
      completed_at: NOW_ISO,
    });
    expect(JSON.parse(row.manifest_json as string)).toEqual(MANIFEST);
    expect(JSON.parse(row.script_json as string).scenes).toHaveLength(2);
  });

  it("refuses at two jobs in an active status", async () => {
    seedJob("a-1", "scripting");
    seedJob("a-2", "composing");
    const refused = await videoComposeManifestTool.execute({
      manifest: MANIFEST,
    });
    expect(refused).toContain("Too many active video jobs (2/2)");
    expect(jobIds()).toEqual(["a-1", "a-2"]);
  });
});

describe("video_html_compose on the real schema", () => {
  it("inserts the job as composing and marks it completed after the render", async () => {
    // A render in progress counts toward the job cap only while its row is
    // in an active status: the status is read when the render starts.
    let statusAtRender: unknown;
    m.renderHtmlComposition.mockImplementation(
      async (_c: unknown, jobId: string) => {
        statusAtRender = jobRow(jobId)?.status;
        return { outputPath: "/synthetic/html.mp4", frameCount: 60, elapsedMs: 1 };
      },
    );
    const out = JSON.parse(
      await videoHtmlComposeTool.execute({
        html_path: "/synthetic/composition.html",
        width: 1080,
        height: 1920,
      }),
    ) as { jobId: string; status: string };
    expect(out.status).toBe("composing");

    const row = await settled(out.jobId);
    expect(statusAtRender).toBe("composing");
    expect(row).toMatchObject({
      status: "completed",
      topic: "html: /synthetic/composition.html",
      duration_seconds: 3,
      template: "portrait",
      expires_at: NOW_PLUS_24H,
      output_file: "/synthetic/html.mp4",
      completed_at: NOW_ISO,
    });
    expect(JSON.parse(row.manifest_json as string)).toMatchObject({
      kind: "html",
      fps: 24,
      width: 1080,
      height: 1920,
      elementCount: 2,
    });
  });

  it("records the render failure on the row", async () => {
    m.renderHtmlComposition.mockRejectedValue(new Error("synthetic render failure"));
    const out = JSON.parse(
      await videoHtmlComposeTool.execute({ html_path: "/synthetic/composition.html" }),
    ) as { jobId: string };
    const row = await settled(out.jobId);
    expect(row).toMatchObject({
      status: "failed",
      error_message: "synthetic render failure",
      template: "landscape",
    });
  });

  it("refuses at two jobs in an active status", async () => {
    seedJob("a-1", "composing");
    seedJob("a-2", "generating_assets");
    const refused = await videoHtmlComposeTool.execute({
      html_path: "/synthetic/composition.html",
    });
    expect(refused).toContain("Too many active video jobs (2/2)");
    expect(jobIds()).toEqual(["a-1", "a-2"]);
    expect(m.renderHtmlComposition).not.toHaveBeenCalled();
  });
});

describe("video_job_cancel on the real schema", () => {
  it("marks an active job cancelled and leaves a terminal job as it is", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("refused: no signal in this test");
    });
    seedJob("run-1", "composing");
    seedJob("done-1", "completed", { completedAt: hoursAgo(2) });

    const out = JSON.parse(
      await videoJobCancelTool.execute({ job_id: "run-1" }),
    ) as Record<string, unknown>;
    expect(out).toMatchObject({ ok: true, jobId: "run-1", pid_killed: false });
    expect(jobRow("run-1")).toMatchObject({
      status: "cancelled",
      error_message: "Cancelled by operator",
      completed_at: NOW_ISO,
    });

    const terminal = JSON.parse(
      await videoJobCancelTool.execute({ job_id: "done-1" }),
    ) as Record<string, unknown>;
    expect(terminal).toEqual({ ok: true, alreadyTerminal: true, status: "completed" });
    expect(jobRow("done-1")).toMatchObject({
      status: "completed",
      completed_at: hoursAgo(2),
    });
    expect(kill).not.toHaveBeenCalled();
  });
});

describe("video_job_cleanup on the real schema", () => {
  it("deletes terminal jobs finished before the cut-off or never stamped, and keeps the rest", async () => {
    seedJob("a001", "completed", { completedAt: hoursAgo(25) });
    seedJob("a002", "failed", { completedAt: null });
    seedJob("a003", "cancelled", { completedAt: hoursAgo(30) });
    seedJob("b001", "completed", { completedAt: hoursAgo(23) });
    seedJob("b002", "composing", { completedAt: null });
    // An id outside the safe job-id shape is never touched.
    seedJob("NOT_SAFE", "completed", { completedAt: hoursAgo(48) });

    const out = JSON.parse(await videoJobCleanupTool.execute({})) as Record<
      string,
      unknown
    >;
    expect(out).toEqual({ older_than_hours: 24, removed_count: 3, bytes_freed: 0 });
    expect(jobIds()).toEqual(["NOT_SAFE", "b001", "b002"]);
    expect([...m.liveExists].sort()).toEqual(
      ["a001", "a002", "a003"].map((id) => `/tmp/video-jobs/${id}`),
    );
  });
});

describe("video_brand_apply on the real schema", () => {
  it("reads the brand profile by id", async () => {
    const { lastInsertRowid } = db
      .prepare(
        "INSERT INTO ads_brand_profiles (domain, brand_name, profile) VALUES (?, ?, ?)",
      )
      .run(
        "example.test",
        "Example",
        JSON.stringify({ tagline: "Synthetic tagline", voice: "calm" }),
      );
    const out = JSON.parse(
      await videoBrandApplyTool.execute({ brand_id: Number(lastInsertRowid) }),
    ) as Record<string, unknown>;
    expect(out).toMatchObject({
      brand_id: Number(lastInsertRowid),
      domain: "example.test",
      brand_name: "Example",
      summary: { tagline: "Synthetic tagline", voice: "calm" },
    });
    expect(typeof out.created_at).toBe("string");
    expect(
      await videoBrandApplyTool.execute({ brand_id: Number(lastInsertRowid) + 1 }),
    ).toContain("not found in ads_brand_profiles");
  });
});
