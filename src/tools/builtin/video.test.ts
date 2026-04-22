/**
 * Video tool tests — verify arg validation and tool registration.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

const mockDb = {
  prepare: vi.fn().mockReturnValue({
    run: vi.fn().mockReturnValue({ changes: 1 }),
    get: vi.fn().mockReturnValue(undefined),
    all: vi.fn().mockReturnValue([]),
  }),
};

vi.mock("../../db/index.js", () => ({
  getDatabase: () => mockDb,
  writeWithRetry: <T>(fn: () => T): T => fn(),
}));

// Mock execFileSync for transition preview tests (no real ffmpeg invocation)
const mockExecFileSync = vi.fn();
vi.mock("child_process", async (importOriginal) => {
  const orig = (await importOriginal()) as typeof import("child_process");
  return {
    ...orig,
    execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  };
});

import {
  videoStatusTool,
  videoScriptTool,
  videoTtsTool,
  videoImageTool,
  videoListProfilesTool,
  videoComposeManifestTool,
  videoJobCancelTool,
  videoJobCleanupTool,
  videoTransitionPreviewTool,
  videoBrandApplyTool,
} from "./video.js";

describe("video tools", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("video_status", () => {
    it("requires job_id", async () => {
      const result = await videoStatusTool.execute({});
      expect(result).toContain("job_id is required");
    });

    it("returns not found for unknown job", async () => {
      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue(undefined),
        run: vi.fn(),
        all: vi.fn(),
      });
      const result = await videoStatusTool.execute({ job_id: "unknown" });
      expect(result).toContain("not found");
    });

    it("returns job details when found", async () => {
      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue({
          job_id: "abc123",
          status: "completed",
          topic: "AI in Mexico",
          duration_seconds: 60,
          template: "landscape",
          output_file: "/tmp/video-jobs/abc123/output.mp4",
          error_message: null,
          created_at: "2026-04-04",
          completed_at: "2026-04-04",
        }),
        run: vi.fn(),
        all: vi.fn(),
      });
      const result = await videoStatusTool.execute({ job_id: "abc123" });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe("completed");
      expect(parsed.outputFile).toContain("output.mp4");
    });
  });

  describe("video_script", () => {
    it("requires topic", async () => {
      const result = await videoScriptTool.execute({});
      expect(result).toContain("topic is required");
    });
  });

  describe("video_tts", () => {
    it("requires text", async () => {
      const result = await videoTtsTool.execute({});
      expect(result).toContain("text is required");
    });
  });

  describe("video_image", () => {
    it("requires query", async () => {
      const result = await videoImageTool.execute({});
      expect(result).toContain("query is required");
    });
  });

  describe("video_list_profiles", () => {
    it("returns all profiles", async () => {
      const result = await videoListProfilesTool.execute({});
      const parsed = JSON.parse(result);
      expect(parsed.landscape).toBeDefined();
      expect(parsed.portrait).toBeDefined();
      expect(parsed.square).toBeDefined();
      expect(parsed.landscape.width).toBe(1920);
    });
  });

  describe("video_compose_manifest (v7.4 S1)", () => {
    it("requires a manifest object", async () => {
      const result = await videoComposeManifestTool.execute({});
      const parsed = JSON.parse(result);
      expect(parsed.error).toMatch(/manifest is required/);
    });

    it("rejects a manifest that fails validation", async () => {
      const result = await videoComposeManifestTool.execute({
        manifest: {
          version: 1,
          title: "",
          template: "portrait",
          fps: 30,
          language: "es",
          scenes: [],
        },
      });
      const parsed = JSON.parse(result);
      expect(parsed.error).toMatch(/title is required|non-empty array/);
    });

    it("rejects manifest JSON over 256KB", async () => {
      const bigText = "x".repeat(2000);
      const manifest = {
        version: 1 as const,
        title: "Big",
        template: "portrait" as const,
        fps: 30 as const,
        language: "es",
        // 140 scenes × 2000 chars ≈ 280 KB JSON → trips byte cap before
        // the 150-scene pre-check fires
        scenes: Array.from({ length: 140 }, (_, i) => ({
          index: i,
          durationSec: 1,
          text: bigText,
        })),
      };
      const result = await videoComposeManifestTool.execute({ manifest });
      const parsed = JSON.parse(result);
      expect(parsed.error).toMatch(/exceeds 262144 bytes/);
    });

    it("rejects manifest with >150 scenes (cheap pre-check before stringify)", async () => {
      const manifest = {
        version: 1 as const,
        title: "Too many scenes",
        template: "portrait" as const,
        fps: 30 as const,
        language: "es",
        scenes: Array.from({ length: 200 }, (_, i) => ({
          index: i,
          durationSec: 1,
          text: "s",
        })),
      };
      const result = await videoComposeManifestTool.execute({ manifest });
      const parsed = JSON.parse(result);
      expect(parsed.error).toMatch(/scene count exceeds hard cap/);
    });
  });

  describe("video_job_cancel (v7.4 S1)", () => {
    it("requires job_id", async () => {
      const result = await videoJobCancelTool.execute({});
      const parsed = JSON.parse(result);
      expect(parsed.error).toMatch(/job_id is required/);
    });

    it("returns ok:false for unknown job", async () => {
      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue(undefined),
        run: vi.fn(),
        all: vi.fn(),
      });
      const result = await videoJobCancelTool.execute({ job_id: "nope" });
      const parsed = JSON.parse(result);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toMatch(/not found/);
    });

    it("short-circuits on already-terminal jobs", async () => {
      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue({
          job_id: "x1",
          status: "completed",
          ffmpeg_pid: null,
        }),
        run: vi.fn(),
        all: vi.fn(),
      });
      const result = await videoJobCancelTool.execute({ job_id: "x1" });
      const parsed = JSON.parse(result);
      expect(parsed.alreadyTerminal).toBe(true);
      expect(parsed.status).toBe("completed");
    });
  });

  describe("video_transition_preview (v7.4 S1)", () => {
    it("requires transition arg", async () => {
      const result = await videoTransitionPreviewTool.execute({});
      const parsed = JSON.parse(result);
      expect(parsed.error).toMatch(/transition is required/);
    });

    it("renders a native transition — passes xfade=fade to ffmpeg", async () => {
      mockExecFileSync.mockReturnValue(Buffer.from(""));
      const result = await videoTransitionPreviewTool.execute({
        transition: "fade",
        duration: 1.0,
      });
      const parsed = JSON.parse(result);
      expect(parsed.native).toBe(true);
      expect(parsed.xfadeName).toBe("fade");
      expect(parsed.path).toMatch(
        /\/tmp\/video-previews\/transition-fade-\d+\.mp4/,
      );
      expect(mockExecFileSync).toHaveBeenCalled();
      const args = mockExecFileSync.mock.calls[0][1] as string[];
      expect(args.some((a) => a.includes("transition=fade"))).toBe(true);
    });

    it("falls back to dissolve for GL-only transitions", async () => {
      mockExecFileSync.mockReturnValue(Buffer.from(""));
      const warnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const result = await videoTransitionPreviewTool.execute({
        transition: "domain-warp",
      });
      const parsed = JSON.parse(result);
      expect(parsed.native).toBe(false);
      expect(parsed.xfadeName).toBe("dissolve");
      warnSpy.mockRestore();
    });

    it("clamps duration at 0.2 floor", async () => {
      mockExecFileSync.mockReturnValue(Buffer.from(""));
      const result = await videoTransitionPreviewTool.execute({
        transition: "fade",
        duration: 0.05,
      });
      const parsed = JSON.parse(result);
      expect(parsed.duration_seconds).toBe(0.2);
    });

    it("clamps duration at 3.0 ceiling", async () => {
      mockExecFileSync.mockReturnValue(Buffer.from(""));
      const result = await videoTransitionPreviewTool.execute({
        transition: "fade",
        duration: 10,
      });
      const parsed = JSON.parse(result);
      expect(parsed.duration_seconds).toBe(3.0);
    });

    it("handles NaN duration (falls back to default 1.0)", async () => {
      mockExecFileSync.mockReturnValue(Buffer.from(""));
      const result = await videoTransitionPreviewTool.execute({
        transition: "fade",
        duration: NaN,
      });
      const parsed = JSON.parse(result);
      expect(parsed.duration_seconds).toBe(1.0);
    });

    it("cleans up orphan MP4 on ffmpeg throw", async () => {
      mockExecFileSync.mockImplementationOnce(() => {
        throw new Error("ffmpeg timed out");
      });
      const result = await videoTransitionPreviewTool.execute({
        transition: "fade",
      });
      const parsed = JSON.parse(result);
      expect(parsed.error).toMatch(/timed out/);
      // the output path shouldn't exist; can't easily check file system here
      // without real FS; the key invariant is that error is returned without
      // crashing (error-swallowing cleanup path)
    });
  });

  describe("video_job_cleanup (v7.4 S1)", () => {
    it("rejects negative hours", async () => {
      const result = await videoJobCleanupTool.execute({
        older_than_hours: -5,
      });
      expect(result).toMatch(/older_than_hours must be/);
    });

    it("rejects non-finite hours", async () => {
      const result = await videoJobCleanupTool.execute({
        older_than_hours: NaN,
      });
      expect(result).toMatch(/older_than_hours must be/);
    });

    it("rejects hours over 720 (30 days)", async () => {
      const result = await videoJobCleanupTool.execute({
        older_than_hours: 1000,
      });
      expect(result).toMatch(/older_than_hours must be/);
    });

    it("returns zero counts when no candidates", async () => {
      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockReturnValue([]),
        run: vi.fn(),
        get: vi.fn(),
      });
      const result = await videoJobCleanupTool.execute({});
      const parsed = JSON.parse(result);
      expect(parsed.removed_count).toBe(0);
      expect(parsed.older_than_hours).toBe(24);
    });
  });

  describe("video_brand_apply (v7.4 S2a)", () => {
    it("rejects non-positive-integer brand_id", async () => {
      let result = await videoBrandApplyTool.execute({ brand_id: 0 });
      expect(result).toMatch(/must be a positive integer/);
      result = await videoBrandApplyTool.execute({ brand_id: -1 });
      expect(result).toMatch(/must be a positive integer/);
      result = await videoBrandApplyTool.execute({ brand_id: 1.5 });
      expect(result).toMatch(/must be a positive integer/);
    });

    it("returns error when brand_id not found", async () => {
      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue(undefined),
        run: vi.fn(),
        all: vi.fn(),
      });
      const result = await videoBrandApplyTool.execute({ brand_id: 99 });
      expect(result).toMatch(/brand_id 99 not found/);
    });

    it("returns brand summary for a valid brand_id", async () => {
      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue({
          id: 42,
          domain: "acme.test",
          brand_name: "Acme",
          profile: JSON.stringify({
            tagline: "Rise above",
            voice: { descriptor: "confident" },
            keywords_lexicon: ["rise", "above"],
            avoid_lexicon: ["cheap"],
          }),
          created_at: "2026-04-21",
        }),
        run: vi.fn(),
        all: vi.fn(),
      });
      const result = await videoBrandApplyTool.execute({ brand_id: 42 });
      const parsed = JSON.parse(result);
      expect(parsed.brand_id).toBe(42);
      expect(parsed.brand_name).toBe("Acme");
      expect(parsed.summary.tagline).toBe("Rise above");
      expect(parsed.summary.keywords_lexicon).toEqual(["rise", "above"]);
    });

    it("handles corrupt profile JSON gracefully (returns undefined fields)", async () => {
      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue({
          id: 7,
          domain: "broken.test",
          brand_name: "Broken",
          profile: "not valid json",
          created_at: "2026-04-21",
        }),
        run: vi.fn(),
        all: vi.fn(),
      });
      const result = await videoBrandApplyTool.execute({ brand_id: 7 });
      const parsed = JSON.parse(result);
      expect(parsed.brand_id).toBe(7);
      expect(parsed.summary.tagline).toBeUndefined();
    });
  });
});
