/**
 * TTS — text-to-speech for video narration (v6.2 V1 upgrade).
 *
 * Features:
 * - Per-scene TTS: one MP3 per scene with accurate duration via ffprobe
 * - Voice selection: 324 edge-tts voices, configurable per call
 * - Long text splitting: sentence-boundary split + silence injection
 * - Backward-compatible: generateNarration() unchanged
 *
 * Primary: edge-tts (free, 324 voices, no API key)
 * Fallback: silent placeholder (word count → estimated duration)
 */

import { execFileSync } from "child_process";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { VideoScene } from "./types.js";

const TIMEOUT_MS = 30_000;
const MAX_CHARS_PER_CHUNK = 2000;
const SILENCE_GAP_SEC = 0.3;
const DEFAULT_VOICE_ES = "es-MX-DaliaNeural";
const DEFAULT_VOICE_EN = "en-US-AriaNeural";

// ---------------------------------------------------------------------------
// ffprobe duration
// ---------------------------------------------------------------------------

/**
 * Get the duration of an audio file in seconds via ffprobe.
 * Returns 0 on failure (never throws).
 */
export function probeAudioDuration(filePath: string): number {
  try {
    const output = execFileSync(
      "ffprobe",
      ["-v", "quiet", "-print_format", "json", "-show_format", filePath],
      { timeout: 10_000, encoding: "utf-8" },
    );
    const meta = JSON.parse(output);
    return parseFloat(meta.format?.duration ?? "0");
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Text splitting
// ---------------------------------------------------------------------------

/**
 * Split text at sentence boundaries when it exceeds max chars.
 * Returns array of chunks, each under maxChars.
 */
export function splitTextAtSentences(
  text: string,
  maxChars = MAX_CHARS_PER_CHUNK,
): string[] {
  if (text.length <= maxChars) return [text];

  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    // Hard-split fallback: if a single sentence exceeds maxChars,
    // split at commas/semicolons or word boundaries (V1 audit fix)
    if (sentence.length > maxChars) {
      if (current.trim()) chunks.push(current.trim());
      current = "";
      const subParts = sentence.split(/(?<=[,;])\s+/);
      let sub = "";
      for (const part of subParts) {
        if (sub.length + part.length + 1 > maxChars && sub.length > 0) {
          chunks.push(sub.trim());
          sub = part;
        } else {
          sub += (sub ? " " : "") + part;
        }
      }
      if (sub.trim()) {
        // If still over limit, hard-cut at maxChars
        while (sub.length > maxChars) {
          chunks.push(sub.slice(0, maxChars));
          sub = sub.slice(maxChars);
        }
        if (sub.trim()) chunks.push(sub.trim());
      }
      continue;
    }

    if (current.length + sentence.length + 1 > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += (current ? " " : "") + sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks;
}

// ---------------------------------------------------------------------------
// Core edge-tts call
// ---------------------------------------------------------------------------

/**
 * Generate a single MP3 from text using edge-tts.
 * Handles long text by splitting + silence-gap concat.
 */
async function edgeTts(
  text: string,
  outputPath: string,
  voice: string,
): Promise<string> {
  const chunks = splitTextAtSentences(text);

  if (chunks.length === 1) {
    // Single chunk — direct generation
    return edgeTtsSingle(chunks[0], outputPath, voice);
  }

  // Multiple chunks — generate parts, concat with silence gaps
  const dir = outputPath.replace(/\.[^.]+$/, "_parts");
  mkdirSync(dir, { recursive: true });

  const partFiles: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const partPath = join(dir, `part-${String(i).padStart(3, "0")}.mp3`);
    await edgeTtsSingle(chunks[i], partPath, voice);
    partFiles.push(partPath);
  }

  // Generate silence gap
  const silencePath = join(dir, "silence.mp3");
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `anullsrc=r=44100:cl=mono`,
      "-t",
      String(SILENCE_GAP_SEC),
      "-c:a",
      "libmp3lame",
      silencePath,
    ],
    { timeout: 10_000, stdio: "pipe" },
  );

  // Build concat list: part0 silence part1 silence part2...
  const concatList = partFiles
    .flatMap((f, i) =>
      i < partFiles.length - 1
        ? [`file '${f}'`, `file '${silencePath}'`]
        : [`file '${f}'`],
    )
    .join("\n");
  const concatFile = join(dir, "concat.txt");
  writeFileSync(concatFile, concatList, "utf-8");

  // Concat via FFmpeg
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
      outputPath,
    ],
    { timeout: TIMEOUT_MS, stdio: "pipe" },
  );

  return outputPath;
}

/**
 * Generate a single MP3 from a text chunk (under 2000 chars).
 */
function edgeTtsSingle(
  text: string,
  outputPath: string,
  voice: string,
): string {
  const textFile = outputPath.replace(/\.[^.]+$/, ".txt");
  writeFileSync(textFile, text, "utf-8");

  try {
    execFileSync(
      "edge-tts",
      ["--voice", voice, "--file", textFile, "--write-media", outputPath],
      { timeout: TIMEOUT_MS, stdio: "pipe" },
    );
  } catch {
    // Fallback: --text directly (truncated)
    execFileSync(
      "edge-tts",
      [
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

// ---------------------------------------------------------------------------
// Silent fallback
// ---------------------------------------------------------------------------

function generateSilence(outputPath: string, durationSec: number): string {
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

// ---------------------------------------------------------------------------
// Public API — backward compatible
// ---------------------------------------------------------------------------

/**
 * Resolve voice name from language + optional override.
 */
export function resolveVoice(language: string, voice?: string): string {
  if (voice) return voice;
  return language === "es" ? DEFAULT_VOICE_ES : DEFAULT_VOICE_EN;
}

/**
 * Generate narration audio from text (backward-compatible).
 * Returns path to the generated MP3 file.
 */
export async function generateNarration(
  text: string,
  outputPath: string,
  language: string = "es",
  voice?: string,
): Promise<string> {
  const resolvedVoice = resolveVoice(language, voice);

  try {
    return await edgeTts(text, outputPath, resolvedVoice);
  } catch (err) {
    console.warn(
      "[tts] edge-tts failed:",
      err instanceof Error ? err.message : err,
    );
  }

  // Fallback: silent placeholder
  console.warn("[tts] All TTS providers failed. Generating silent audio.");
  const words = text.split(/\s+/).length;
  const durationSec = Math.max(5, Math.ceil(words / 2.5));
  return generateSilence(outputPath, durationSec);
}

// ---------------------------------------------------------------------------
// Per-scene TTS (v6.2 V1)
// ---------------------------------------------------------------------------

export interface PerSceneTTSResult {
  /** Per-scene MP3 file paths. */
  files: string[];
  /** Per-scene durations in seconds. */
  durations: number[];
  /** Total duration of all scenes. */
  totalDuration: number;
}

/**
 * Generate one MP3 per scene with accurate duration via ffprobe.
 * Returns per-scene file paths + durations for overlay timing sync.
 */
export async function generatePerSceneTTS(
  scenes: VideoScene[],
  outputDir: string,
  options?: { language?: string; voice?: string },
): Promise<PerSceneTTSResult> {
  mkdirSync(outputDir, { recursive: true });

  const language = options?.language ?? "es";
  const resolvedVoice = resolveVoice(language, options?.voice);

  const files: string[] = [];
  const durations: number[] = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const outputPath = join(
      outputDir,
      `scene-${String(i).padStart(3, "0")}.mp3`,
    );

    try {
      await edgeTts(scene.text, outputPath, resolvedVoice);
      const duration = probeAudioDuration(outputPath);
      files.push(outputPath);
      durations.push(duration > 0 ? duration : scene.duration);
    } catch (err) {
      console.warn(
        `[tts] Scene ${i} failed:`,
        err instanceof Error ? err.message : err,
      );
      // Fallback: silent audio matching scene duration
      generateSilence(outputPath, scene.duration);
      files.push(outputPath);
      durations.push(scene.duration);
    }
  }

  const totalDuration = durations.reduce((s, d) => s + d, 0);

  return { files, durations, totalDuration };
}

// ---------------------------------------------------------------------------
// Voice catalog
// ---------------------------------------------------------------------------

export interface VoiceInfo {
  name: string;
  gender: string;
  locale: string;
}

/**
 * List available edge-tts voices, optionally filtered by language prefix.
 */
export function listVoices(languageFilter?: string): VoiceInfo[] {
  try {
    const output = execFileSync("edge-tts", ["--list-voices"], {
      timeout: 15_000,
      encoding: "utf-8",
    });

    const lines = output.split("\n").slice(2); // skip header + dashes separator
    const voices: VoiceInfo[] = [];

    for (const line of lines) {
      const parts = line.split(/\s{2,}/);
      if (parts.length < 2) continue;
      const name = parts[0].trim();
      const gender = parts[1]?.trim() ?? "";
      const locale = name.split("-").slice(0, 2).join("-");

      if (languageFilter && !locale.startsWith(languageFilter)) continue;
      voices.push({ name, gender, locale });
    }

    return voices;
  } catch {
    return [];
  }
}
