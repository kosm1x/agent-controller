/**
 * Image fetcher for video scenes.
 * Cascade: Pexels (stock) → Gemini (AI) → HuggingFace (AI) → solid color placeholder.
 */

import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

const PEXELS_API_URL = "https://api.pexels.com/v1/search";
const TIMEOUT_MS = 15_000;

// Gemini
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_MODEL = "gemini-2.5-flash-image";

// HuggingFace
const HF_MODEL = "black-forest-labs/FLUX.1-schnell";
const HF_TIMEOUT_MS = 30_000;

interface PexelsPhoto {
  id: number;
  src: { large2x: string; large: string };
  alt: string;
}

/**
 * Fetch an image for a video scene.
 * Tries Pexels (fast, free stock) → Gemini (AI-generated) → HuggingFace (AI) → placeholder.
 */
export async function fetchImage(
  query: string,
  outputPath: string,
  width: number = 1920,
  height: number = 1080,
): Promise<string> {
  mkdirSync(dirname(outputPath), { recursive: true });

  // --- Provider 1: Pexels (stock photos) ---
  const pexelsKey = process.env.PEXELS_API_KEY;
  if (pexelsKey) {
    try {
      const params = new URLSearchParams({
        query,
        per_page: "1",
        orientation: width > height ? "landscape" : "portrait",
      });
      const res = await fetch(`${PEXELS_API_URL}?${params}`, {
        headers: { Authorization: pexelsKey, Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Pexels ${res.status}`);
      const data = (await res.json()) as { photos: PexelsPhoto[] };
      if (data.photos.length === 0) throw new Error("No results");

      const imageUrl = data.photos[0].src.large2x || data.photos[0].src.large;
      const imgRes = await fetch(imageUrl, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!imgRes.ok) throw new Error(`Download ${imgRes.status}`);
      writeFileSync(outputPath, Buffer.from(await imgRes.arrayBuffer()));
      return outputPath;
    } catch (err) {
      console.warn(
        `[images] Pexels failed for "${query}":`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // --- Provider 2: Gemini (AI-generated) ---
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    try {
      const url = `${GEMINI_API_BASE}/models/${GEMINI_MODEL}:generateContent?key=${geminiKey}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            { parts: [{ text: `Generate a cinematic photo: ${query}` }] },
          ],
          generationConfig: {
            responseModalities: ["IMAGE"],
            imageConfig: {
              aspectRatio: width > height ? "16:9" : "9:16",
            },
          },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS * 2),
      });
      if (!res.ok) throw new Error(`Gemini ${res.status}`);
      const data = (await res.json()) as Record<string, unknown>;
      const candidates = data.candidates as
        | Array<Record<string, unknown>>
        | undefined;
      const parts = (candidates?.[0]?.content as Record<string, unknown>)
        ?.parts as Array<Record<string, unknown>> | undefined;
      const inlineData = parts?.[0]?.inlineData as
        | { mimeType: string; data: string }
        | undefined;
      if (inlineData?.data) {
        writeFileSync(outputPath, Buffer.from(inlineData.data, "base64"));
        return outputPath;
      }
      throw new Error("No image in response");
    } catch (err) {
      console.warn(
        `[images] Gemini failed for "${query}":`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // --- Provider 3: HuggingFace FLUX (AI-generated) ---
  const hfToken = process.env.HUGGINGFACE_TOKEN;
  if (hfToken) {
    try {
      const res = await fetch(
        `https://router.huggingface.co/hf-inference/models/${HF_MODEL}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${hfToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            inputs: `cinematic photo, ${query}, high quality, 4K`,
            parameters: { width, height },
          }),
          signal: AbortSignal.timeout(HF_TIMEOUT_MS),
        },
      );
      if (!res.ok) throw new Error(`HF ${res.status}`);
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.startsWith("image/"))
        throw new Error(`Not an image: ${contentType}`);
      writeFileSync(outputPath, Buffer.from(await res.arrayBuffer()));
      return outputPath;
    } catch (err) {
      console.warn(
        `[images] HuggingFace failed for "${query}":`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // --- Fallback: solid color placeholder ---
  console.warn(
    `[images] All providers failed for "${query}". Using placeholder.`,
  );
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
