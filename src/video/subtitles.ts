/**
 * SRT subtitle generator — pure TypeScript, no dependencies.
 */

import type { VideoScript } from "./types.js";
import { writeFileSync } from "fs";

/**
 * Generate an SRT subtitle file from a VideoScript.
 * Each scene becomes one subtitle entry.
 */
export function generateSubtitles(
  script: VideoScript,
  outputPath: string,
): string {
  const entries: string[] = [];
  let currentTime = 0;

  for (let i = 0; i < script.scenes.length; i++) {
    const scene = script.scenes[i];
    const startTime = formatSrtTime(currentTime);
    const endTime = formatSrtTime(currentTime + scene.duration);

    entries.push(`${i + 1}`);
    entries.push(`${startTime} --> ${endTime}`);
    entries.push(scene.text);
    entries.push("");

    currentTime += scene.duration;
  }

  const content = entries.join("\n");
  writeFileSync(outputPath, content, "utf-8");
  return outputPath;
}

/** Format seconds as SRT timestamp: HH:MM:SS,mmm */
function formatSrtTime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const millis = Math.round((totalSeconds % 1) * 1000);

  return (
    String(hours).padStart(2, "0") +
    ":" +
    String(minutes).padStart(2, "0") +
    ":" +
    String(seconds).padStart(2, "0") +
    "," +
    String(millis).padStart(3, "0")
  );
}
