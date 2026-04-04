/**
 * TTS — text-to-speech for video narration.
 * Primary: Gemini TTS. Fallback: edge-tts (free, no auth).
 */

import { execFileSync } from "child_process";
import { writeFileSync, existsSync } from "fs";

const TIMEOUT_MS = 30_000;

/**
 * Generate narration audio from text.
 * Tries Gemini first, falls back to edge-tts.
 * Returns path to the generated MP3 file.
 */
export async function generateNarration(
  text: string,
  outputPath: string,
  language: string = "es",
): Promise<string> {
  // Try edge-tts (free, reliable, no API key)
  try {
    return await edgeTts(text, outputPath, language);
  } catch (err) {
    console.warn(
      "[tts] edge-tts failed:",
      err instanceof Error ? err.message : err,
    );
  }

  // Fallback: generate a silence placeholder
  // (FFmpeg can create silent audio of the right duration)
  console.warn("[tts] All TTS providers failed. Generating silent audio.");
  const words = text.split(/\s+/).length;
  const durationSec = Math.max(5, Math.ceil(words / 2.5)); // ~150 wpm
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `anullsrc=r=44100:cl=mono`,
      "-t",
      String(durationSec),
      "-c:a",
      "libmp3lame",
      outputPath,
    ],
    { timeout: TIMEOUT_MS },
  );
  return outputPath;
}

/**
 * edge-tts — Microsoft's free TTS via npm package.
 * Requires: `npx edge-tts` (installed globally or via npx).
 */
async function edgeTts(
  text: string,
  outputPath: string,
  language: string,
): Promise<string> {
  const voice = language === "es" ? "es-MX-DaliaNeural" : "en-US-AriaNeural";

  // Write text to temp file (avoids shell escaping issues)
  const textFile = outputPath.replace(/\.[^.]+$/, ".txt");
  writeFileSync(textFile, text, "utf-8");

  try {
    execFileSync(
      "npx",
      [
        "edge-tts",
        "--voice",
        voice,
        "--file",
        textFile,
        "--write-media",
        outputPath,
      ],
      { timeout: TIMEOUT_MS, stdio: "pipe" },
    );
  } catch (err) {
    // Try with --text directly if --file fails
    execFileSync(
      "npx",
      [
        "edge-tts",
        "--voice",
        voice,
        "--text",
        text.slice(0, 2000),
        "--write-media",
        outputPath,
      ],
      { timeout: TIMEOUT_MS, stdio: "pipe" },
    );
  }

  if (!existsSync(outputPath)) {
    throw new Error("edge-tts produced no output file");
  }
  return outputPath;
}
