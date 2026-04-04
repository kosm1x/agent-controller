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

import {
  videoStatusTool,
  videoScriptTool,
  videoTtsTool,
  videoImageTool,
  videoListProfilesTool,
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
});
