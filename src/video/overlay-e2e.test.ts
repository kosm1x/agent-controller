/**
 * V3.5 — End-to-end overlay pipeline test.
 *
 * Runs the REAL pipeline (edge-tts + FFmpeg), not mocks.
 * Verifies: TTS per-scene → placeholder images → background → compose → valid MP4.
 *
 * Requires: ffmpeg, ffprobe, edge-tts installed on the system.
 * Timeout: 60s (TTS + FFmpeg encoding takes time).
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { mkdirSync, existsSync, statSync } from "fs";
import { join } from "path";
import { generatePerSceneTTS } from "./tts.js";
import { composeOverlayVideo } from "./composer.js";
import type { VideoScene } from "./types.js";

const TEST_JOB_ID = `e2e-overlay-${Date.now()}`;
const WORK_DIR = join("/tmp", "video-jobs", TEST_JOB_ID);

describe(
  "overlay pipeline E2E",
  () => {
    it("produces valid MP4 from TTS + images + background", async () => {
      mkdirSync(WORK_DIR, { recursive: true });

      // 1. Define 2 test scenes
      const scenes: VideoScene[] = [
        {
          text: "Esta es la primera escena de prueba del modo overlay.",
          duration: 4,
          imageQuery: "test",
        },
        {
          text: "Y esta es la segunda escena con más contenido.",
          duration: 3,
          imageQuery: "test",
        },
      ];

      // 2. Generate per-scene TTS (V1)
      const ttsResult = await generatePerSceneTTS(scenes, WORK_DIR, {
        language: "es",
      });
      expect(ttsResult.files.length).toBe(2);
      expect(ttsResult.durations.length).toBe(2);
      expect(ttsResult.totalDuration).toBeGreaterThan(0);

      // 3. Generate placeholder images (solid colors via FFmpeg)
      const imageFiles: string[] = [];
      const colors = ["blue", "red"];
      for (let i = 0; i < scenes.length; i++) {
        const imgPath = join(
          WORK_DIR,
          `scene-${String(i).padStart(3, "0")}.png`,
        );
        execFileSync(
          "ffmpeg",
          [
            "-y",
            "-f",
            "lavfi",
            "-i",
            `color=c=${colors[i]}:s=1080x1920:d=1`,
            "-frames:v",
            "1",
            imgPath,
          ],
          { timeout: 10_000, stdio: "pipe" },
        );
        imageFiles.push(imgPath);
      }

      // 4. Generate solid color background (skip yt-dlp — no network in test)
      const bgPath = join(WORK_DIR, "background.mp4");
      const bgDuration = Math.ceil(ttsResult.totalDuration) + 2;
      execFileSync(
        "ffmpeg",
        [
          "-y",
          "-f",
          "lavfi",
          "-i",
          `color=c=black:s=1920x1080:d=${bgDuration}`,
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-pix_fmt",
          "yuv420p",
          bgPath,
        ],
        { timeout: 15_000, stdio: "pipe" },
      );

      // 5. Compose overlay video (V3)
      const outputPath = composeOverlayVideo({
        jobId: TEST_JOB_ID,
        backgroundVideo: bgPath,
        imageFiles,
        audioFiles: ttsResult.files,
        durations: ttsResult.durations,
        template: "portrait",
      });

      // 6. Verify output
      expect(existsSync(outputPath)).toBe(true);
      const stat = statSync(outputPath);
      expect(stat.size).toBeGreaterThan(1000); // Not a trivially small file

      // 7. Verify streams via ffprobe
      const probeOutput = execFileSync(
        "ffprobe",
        [
          "-v",
          "quiet",
          "-print_format",
          "json",
          "-show_format",
          "-show_streams",
          outputPath,
        ],
        { timeout: 10_000, encoding: "utf-8" },
      );
      const meta = JSON.parse(probeOutput);
      const duration = parseFloat(meta.format.duration);
      const hasVideo = meta.streams.some(
        (s: { codec_type: string }) => s.codec_type === "video",
      );
      const hasAudio = meta.streams.some(
        (s: { codec_type: string }) => s.codec_type === "audio",
      );

      expect(hasVideo).toBe(true);
      expect(hasAudio).toBe(true);
      expect(duration).toBeGreaterThan(1);
    });
  },
  { timeout: 60_000 },
);
