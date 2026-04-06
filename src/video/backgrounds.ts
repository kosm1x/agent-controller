/**
 * Background Media Library (v6.2 V2)
 *
 * Downloads, caches, and extracts subclips from background videos
 * for overlay composition (V3). Uses yt-dlp for downloading and
 * FFmpeg for subclip extraction.
 *
 * Cache: /tmp/video-backgrounds/{name}/ with metadata.json
 * Subclips: random start offset, skip first 180s, match target duration.
 */

import { execFileSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "fs";
import { join } from "path";

const CACHE_DIR = "/tmp/video-backgrounds";
const SKIP_SECONDS = 180; // skip first 3 minutes (intros, title cards)

// ---------------------------------------------------------------------------
// Background catalog — royalty-free Pexels videos
// ---------------------------------------------------------------------------

export interface BackgroundEntry {
  name: string;
  url: string;
  credit: string;
  description: string;
}

/**
 * Pre-seeded catalog of royalty-free background videos.
 * All from Pexels (free, no attribution required but credited).
 */
export const BACKGROUND_CATALOG: BackgroundEntry[] = [
  {
    name: "ocean-waves",
    url: "https://www.pexels.com/download/video/1093662/",
    credit: "Pexels / Zlatin Georgiev",
    description: "Calm ocean waves on a beach, aerial view",
  },
  {
    name: "city-timelapse",
    url: "https://www.pexels.com/download/video/3129671/",
    credit: "Pexels / Taryn Elliott",
    description: "City skyline timelapse at night with lights",
  },
  {
    name: "abstract-particles",
    url: "https://www.pexels.com/download/video/3163534/",
    credit: "Pexels / Rostislav Uzunov",
    description: "Abstract floating particles on dark background",
  },
  {
    name: "nature-forest",
    url: "https://www.pexels.com/download/video/3571264/",
    credit: "Pexels / Ian Beckley",
    description: "Sunlight through forest trees, slow pan",
  },
  {
    name: "clouds-sky",
    url: "https://www.pexels.com/download/video/1851190/",
    credit: "Pexels / Engin Akyurt",
    description: "Clouds moving across blue sky, timelapse",
  },
];

// ---------------------------------------------------------------------------
// Cache management
// ---------------------------------------------------------------------------

interface CachedBackground {
  name: string;
  filePath: string;
  durationSeconds: number;
  credit: string;
  downloadedAt: string;
}

function getCacheDir(name: string): string {
  return join(CACHE_DIR, name);
}

function getMetadataPath(name: string): string {
  return join(getCacheDir(name), "metadata.json");
}

/**
 * Check if a background video is already cached.
 */
export function isCached(name: string): boolean {
  const metaPath = getMetadataPath(name);
  if (!existsSync(metaPath)) return false;
  try {
    const meta = JSON.parse(
      readFileSync(metaPath, "utf-8"),
    ) as CachedBackground;
    return existsSync(meta.filePath);
  } catch {
    return false;
  }
}

/**
 * Get cached background metadata.
 */
export function getCachedMeta(name: string): CachedBackground | null {
  try {
    const metaPath = getMetadataPath(name);
    if (!existsSync(metaPath)) return null;
    return JSON.parse(readFileSync(metaPath, "utf-8")) as CachedBackground;
  } catch {
    return null;
  }
}

/**
 * List all cached backgrounds.
 */
export function listCachedBackgrounds(): CachedBackground[] {
  if (!existsSync(CACHE_DIR)) return [];
  const entries: CachedBackground[] = [];
  for (const dir of readdirSync(CACHE_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const meta = getCachedMeta(dir.name);
    if (meta) entries.push(meta);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Download + probe
// ---------------------------------------------------------------------------

/**
 * Get video duration in seconds via ffprobe.
 */
function probeDuration(filePath: string): number {
  try {
    const output = execFileSync(
      "ffprobe",
      ["-v", "quiet", "-print_format", "json", "-show_format", filePath],
      { timeout: 15_000, encoding: "utf-8" },
    );
    return parseFloat(JSON.parse(output).format?.duration ?? "0");
  } catch {
    return 0;
  }
}

/**
 * Download a background video using yt-dlp.
 * Caches the file in /tmp/video-backgrounds/{name}/.
 * Returns the cached metadata on success, null on failure.
 */
export function downloadBackground(
  name: string,
  url: string,
  credit: string,
): CachedBackground | null {
  // Return cached version if available
  const existing = getCachedMeta(name);
  if (existing && existsSync(existing.filePath)) return existing;

  const cacheDir = getCacheDir(name);
  mkdirSync(cacheDir, { recursive: true });
  const outputPath = join(cacheDir, `${name}.mp4`);

  try {
    console.log(`[backgrounds] Downloading ${name} from ${url}...`);

    // Pexels direct download URLs use curl (yt-dlp has no Pexels extractor).
    // YouTube/other URLs fall back to yt-dlp.
    const isPexelsOrDirect =
      url.includes("pexels.com") || url.match(/\.(mp4|webm|mov)(\?|$)/i);

    if (isPexelsOrDirect) {
      execFileSync(
        "curl",
        ["-L", "-o", outputPath, "-s", "--max-time", "120", url],
        { timeout: 130_000, stdio: "pipe" },
      );
    } else {
      execFileSync(
        "yt-dlp",
        [
          "-f",
          "bestvideo[height<=1080][ext=mp4]/best[height<=1080]",
          "-o",
          outputPath,
          "--no-playlist",
          "--quiet",
          url,
        ],
        { timeout: 120_000, stdio: "pipe" },
      );
    }

    if (!existsSync(outputPath)) {
      console.warn(`[backgrounds] Download produced no file: ${name}`);
      return null;
    }

    const duration = probeDuration(outputPath);
    const meta: CachedBackground = {
      name,
      filePath: outputPath,
      durationSeconds: duration,
      credit,
      downloadedAt: new Date().toISOString(),
    };

    writeFileSync(getMetadataPath(name), JSON.stringify(meta, null, 2));
    console.log(
      `[backgrounds] Cached ${name}: ${duration.toFixed(0)}s, ${outputPath}`,
    );
    return meta;
  } catch (err) {
    console.warn(
      `[backgrounds] Download failed for ${name}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Subclip extraction
// ---------------------------------------------------------------------------

/**
 * Extract a random subclip from a cached background video.
 * Skips first SKIP_SECONDS (180s) to avoid intros.
 * Returns path to the extracted subclip.
 */
export function extractSubclip(
  name: string,
  targetDurationSec: number,
  outputPath: string,
): string | null {
  const meta = getCachedMeta(name);
  if (!meta || !existsSync(meta.filePath)) {
    console.warn(`[backgrounds] ${name} not cached`);
    return null;
  }

  // Dynamic skip: use full SKIP_SECONDS for long videos, 10% for short ones
  // (C2 audit fix: stock clips are often 15-60s, 180s skip makes them unusable)
  const skipActual = Math.min(SKIP_SECONDS, meta.durationSeconds * 0.1);
  const available = meta.durationSeconds - skipActual;
  if (available <= 0) {
    console.warn(`[backgrounds] ${name} too short for subclip`);
    return null;
  }

  // Random start within available range
  const maxStart = Math.max(0, available - targetDurationSec);
  const startOffset = skipActual + Math.random() * maxStart;
  const duration = Math.min(targetDurationSec, available);

  try {
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-ss",
        String(Math.floor(startOffset)),
        "-i",
        meta.filePath,
        "-t",
        String(Math.ceil(duration)),
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-an", // no audio from background video
        outputPath,
      ],
      { timeout: 60_000, stdio: "pipe" },
    );

    if (!existsSync(outputPath)) return null;
    return outputPath;
  } catch (err) {
    console.warn(
      `[backgrounds] Subclip extraction failed:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
