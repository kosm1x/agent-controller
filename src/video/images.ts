/**
 * Stock image fetcher — Pexels API (free, no auth for basic usage).
 */

import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

const PEXELS_API_URL = "https://api.pexels.com/v1/search";
const TIMEOUT_MS = 10_000;

interface PexelsPhoto {
  id: number;
  src: {
    original: string;
    large2x: string;
    large: string;
    medium: string;
  };
  alt: string;
}

interface PexelsResponse {
  photos: PexelsPhoto[];
  total_results: number;
}

/**
 * Fetch a stock image from Pexels for the given query.
 * Downloads to outputPath. Returns the path on success.
 * Falls back to a solid color placeholder if Pexels fails.
 */
export async function fetchImage(
  query: string,
  outputPath: string,
  width: number = 1920,
  height: number = 1080,
): Promise<string> {
  mkdirSync(dirname(outputPath), { recursive: true });

  const apiKey = process.env.PEXELS_API_KEY;

  try {
    const params = new URLSearchParams({
      query,
      per_page: "1",
      orientation: width > height ? "landscape" : "portrait",
    });

    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey) headers.Authorization = apiKey;

    const res = await fetch(`${PEXELS_API_URL}?${params}`, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) throw new Error(`Pexels ${res.status}`);

    const data = (await res.json()) as PexelsResponse;
    if (data.photos.length === 0) throw new Error("No results");

    // Download the image
    const imageUrl = data.photos[0].src.large2x || data.photos[0].src.large;
    const imgRes = await fetch(imageUrl, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!imgRes.ok) throw new Error(`Image download ${imgRes.status}`);

    const buffer = Buffer.from(await imgRes.arrayBuffer());
    writeFileSync(outputPath, buffer);
    return outputPath;
  } catch (err) {
    console.warn(
      `[images] Pexels failed for "${query}":`,
      err instanceof Error ? err.message : err,
    );

    // Fallback: generate a solid color placeholder with FFmpeg
    const { execFileSync } = await import("child_process");
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        `color=c=0x1a1a2e:s=${width}x${height}:d=1`,
        "-frames:v",
        "1",
        outputPath,
      ],
      { timeout: TIMEOUT_MS },
    );
    return outputPath;
  }
}
