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

// ---------------------------------------------------------------------------
// Overlay composition (v6.2 V3)
// ---------------------------------------------------------------------------

/**
 * Compose a video with timed image overlays on a background video.
 * Core mechanic from RedditVideoMakerBot: enable=between(t,start,end)
 * per overlay, synced to per-scene audio durations.
 *
 * Pipeline:
 * 1. Crop background to portrait (9:16)
 * 2. Overlay each image centered with timed enable
 * 3. Concat per-scene audio with silence gaps
 * 4. Mix narration + optional background music
 * 5. Output final MP4
 */
export function composeOverlayVideo(opts: {
  jobId: string;
  backgroundVideo: string;
  imageFiles: string[];
  audioFiles: string[];
  durations: number[];
  template: "landscape" | "portrait" | "square";
  backgroundMusicPath?: string;
  backgroundMusicVolume?: number;
  opacity?: number;
}): string {
  const {
    jobId,
    backgroundVideo,
    imageFiles,
    audioFiles,
    durations,
    template,
    backgroundMusicPath,
    backgroundMusicVolume = 0.15,
    opacity = 0.9,
  } = opts;

  const profile = VIDEO_PROFILES[template];
  const workDir = join("/tmp", "video-jobs", jobId);
  mkdirSync(workDir, { recursive: true });

  // Step 1: Crop background to target aspect ratio
  const croppedBg = join(workDir, "bg-cropped.mp4");
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-i",
      backgroundVideo,
      "-vf",
      `crop=ih*(${profile.width}/${profile.height}):ih`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-an",
      croppedBg,
    ],
    { timeout: FFMPEG_TIMEOUT_MS, stdio: "pipe" },
  );

  // Step 2: Concat per-scene audio into single narration track
  const concatFile = join(workDir, "audio-concat.txt");
  const concatLines = audioFiles.map((f) => `file '${f}'`).join("\n");
  writeFileSync(concatFile, concatLines, "utf-8");

  const narrationFile = join(workDir, "narration.mp3");
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
      narrationFile,
    ],
    { timeout: FFMPEG_TIMEOUT_MS, stdio: "pipe" },
  );

  // Step 3: Build overlay filter graph with timed enable
  // Each image is scaled to 45% of video width, overlaid centered,
  // visible only during its scene's time window.
  const overlayWidth = Math.round(profile.width * 0.45);
  const filterInputs: string[] = ["-i", croppedBg];
  const filterParts: string[] = [];
  let currentLabel = "0:v";

  let timeOffset = 0;
  for (let i = 0; i < imageFiles.length; i++) {
    filterInputs.push("-i", imageFiles[i]);
    const inputIdx = i + 1; // 0 is background
    const start = timeOffset;
    const end = timeOffset + durations[i];
    const outLabel = `v${i}`;

    filterParts.push(
      `[${inputIdx}:v]scale=${overlayWidth}:-1,format=rgba,colorchannelmixer=aa=${opacity}[img${i}]`,
    );
    filterParts.push(
      `[${currentLabel}][img${i}]overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2:enable='between(t,${start.toFixed(2)},${end.toFixed(2)})'[${outLabel}]`,
    );
    currentLabel = outLabel;
    timeOffset = end;
  }

  const filterGraph = filterParts.join(";");

  // Step 4: Mix audio (narration + optional background music)
  let audioInput: string;
  if (backgroundMusicPath && existsSync(backgroundMusicPath)) {
    const mixedAudio = join(workDir, "mixed-audio.mp3");
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-i",
        narrationFile,
        "-i",
        backgroundMusicPath,
        "-filter_complex",
        `[0:a]volume=1.0[narr];[1:a]volume=${backgroundMusicVolume}[music];[narr][music]amix=inputs=2:duration=first[out]`,
        "-map",
        "[out]",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        mixedAudio,
      ],
      { timeout: FFMPEG_TIMEOUT_MS, stdio: "pipe" },
    );
    audioInput = mixedAudio;
  } else {
    audioInput = narrationFile;
  }

  // Step 5: Final output — overlaid video + audio
  const outputFile = join(workDir, "output.mp4");
  execFileSync(
    "ffmpeg",
    [
      "-y",
      ...filterInputs,
      "-i",
      audioInput,
      "-filter_complex",
      filterGraph,
      "-map",
      `[${currentLabel}]`,
      "-map",
      `${imageFiles.length + 1}:a`,
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
      outputFile,
    ],
    { timeout: FFMPEG_TIMEOUT_MS * 3, stdio: "pipe" }, // 6 min for complex filter
  );

  return outputFile;
}

/**
 * Build the FFmpeg filter graph string for overlay composition.
 * Exported for testing — the composeOverlayVideo function uses this internally.
 */
export function buildOverlayFilterGraph(
  imageCount: number,
  durations: number[],
  overlayWidth: number,
  opacity: number,
): string {
  const filterParts: string[] = [];
  let currentLabel = "0:v";
  let timeOffset = 0;

  for (let i = 0; i < imageCount; i++) {
    const inputIdx = i + 1;
    const start = timeOffset;
    const end = timeOffset + durations[i];
    const outLabel = `v${i}`;

    filterParts.push(
      `[${inputIdx}:v]scale=${overlayWidth}:-1,format=rgba,colorchannelmixer=aa=${opacity}[img${i}]`,
    );
    filterParts.push(
      `[${currentLabel}][img${i}]overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2:enable='between(t,${start.toFixed(2)},${end.toFixed(2)})'[${outLabel}]`,
    );
    currentLabel = outLabel;
    timeOffset = end;
  }

  return filterParts.join(";");
}
