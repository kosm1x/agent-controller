/**
 * FFmpeg-based video composer — stitches images + audio + subtitles into MP4.
 */

import { execFileSync } from "child_process";
import { writeFileSync, mkdirSync, existsSync, rmSync } from "fs";
import { join } from "path";
import type { VideoScript } from "./types.js";
import { VIDEO_PROFILES } from "./types.js";

const FFMPEG_TIMEOUT_MS = 120_000; // 2 min per step

/**
 * Compose a video from images, audio, and subtitles.
 * Returns the path to the final MP4 file.
 */
export function composeVideo(opts: {
  jobId: string;
  script: VideoScript;
  imageFiles: string[];
  audioFile: string;
  subtitleFile: string;
  template: "landscape" | "portrait" | "square";
}): string {
  const { jobId, script, imageFiles, audioFile, subtitleFile, template } = opts;
  const profile = VIDEO_PROFILES[template];
  const workDir = join("/tmp", "video-jobs", jobId);
  mkdirSync(workDir, { recursive: true });

  // Step 1: Create per-scene video clips from images
  const clipFiles: string[] = [];
  for (let i = 0; i < script.scenes.length; i++) {
    const scene = script.scenes[i];
    const imageFile = imageFiles[i] ?? imageFiles[imageFiles.length - 1]; // reuse last if short
    const clipPath = join(workDir, `clip-${String(i).padStart(3, "0")}.mp4`);

    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-loop",
        "1",
        "-i",
        imageFile,
        "-c:v",
        "libx264",
        "-t",
        String(scene.duration),
        "-pix_fmt",
        "yuv420p",
        "-vf",
        `scale=${profile.width}:${profile.height}:force_original_aspect_ratio=decrease,pad=${profile.width}:${profile.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
        "-r",
        "24",
        clipPath,
      ],
      { timeout: FFMPEG_TIMEOUT_MS, stdio: "pipe" },
    );

    clipFiles.push(clipPath);
  }

  // Step 2: Create concat file
  const concatFile = join(workDir, "concat.txt");
  const concatContent = clipFiles.map((f) => `file '${f}'`).join("\n");
  writeFileSync(concatFile, concatContent, "utf-8");

  // Step 3: Concat clips into raw video
  const rawVideo = join(workDir, "raw.mp4");
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatFile,
      "-c",
      "copy",
      rawVideo,
    ],
    { timeout: FFMPEG_TIMEOUT_MS, stdio: "pipe" },
  );

  // Step 4: Mix audio + burn subtitles
  const outputFile = join(workDir, "output.mp4");
  const ffmpegArgs = [
    "-y",
    "-i",
    rawVideo,
    "-i",
    audioFile,
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "23",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-shortest",
  ];

  // Burn subtitles if the file exists and has content
  if (existsSync(subtitleFile)) {
    // Escape path for FFmpeg filter syntax (colons, backslashes, single quotes)
    const escapedPath = subtitleFile
      .replace(/\\/g, "\\\\")
      .replace(/:/g, "\\:")
      .replace(/'/g, "\\'");
    ffmpegArgs.push(
      "-vf",
      `subtitles=${escapedPath}:force_style='FontSize=24,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,Outline=2'`,
    );
  }

  ffmpegArgs.push(outputFile);

  execFileSync("ffmpeg", ffmpegArgs, {
    timeout: FFMPEG_TIMEOUT_MS * 2, // final encode gets more time
    stdio: "pipe",
  });

  return outputFile;
}

/**
 * Clean up a video job's working directory.
 */
export function cleanupJob(jobId: string): void {
  const workDir = join("/tmp", "video-jobs", jobId);
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // non-fatal
  }
}
