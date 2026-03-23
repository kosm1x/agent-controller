/**
 * Gemini Image Generation — text-to-image via Google's Generative Language API.
 *
 * Tries Gemini native (generateContent with image modality — free tier) first,
 * then falls back to Imagen (predict endpoint — requires paid plan).
 * Requires a Google API key (from env or user_facts).
 *
 * Flow: gemini_image → saves image to /tmp → returns file path
 * Then: wp_media_upload with the local file path uploads it to WordPress.
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Tool } from "../types.js";
import { getUserFacts } from "../../db/user-facts.js";

const TIMEOUT_MS = 60_000;
const IMAGE_DIR = "/tmp/gemini_images";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_NATIVE_MODEL = "gemini-2.5-flash-image";
const IMAGEN_MODEL = "imagen-4.0-generate-001";

// ---------------------------------------------------------------------------
// Helpers (standalone functions — Tool interface doesn't allow custom methods)
// ---------------------------------------------------------------------------

function getApiKey(): string | null {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  try {
    const facts = getUserFacts("projects");
    const fact = facts.find((f) => f.key === "gemini_api_key");
    if (fact) return fact.value;
  } catch {
    /* DB not ready */
  }
  return null;
}

function saveImage(
  base64Data: string,
  mimeType: string,
  prompt: string,
  aspectRatio: string,
): string {
  if (!existsSync(IMAGE_DIR)) mkdirSync(IMAGE_DIR, { recursive: true });
  const ext = mimeType.includes("png") ? "png" : "jpeg";
  const filename = `img-${Date.now()}.${ext}`;
  const filePath = join(IMAGE_DIR, filename);
  writeFileSync(filePath, Buffer.from(base64Data, "base64"));
  const fileSizeKB = Math.round(
    Buffer.from(base64Data, "base64").length / 1024,
  );
  return JSON.stringify({
    success: true,
    file_path: filePath,
    filename,
    size_kb: fileSizeKB,
    aspect_ratio: aspectRatio,
    prompt_used: prompt.slice(0, 200),
    next_step: `Upload to WordPress: wp_media_upload with image_url="${filePath}" and filename="${filename}"`,
  });
}

async function tryGeminiNative(
  apiKey: string,
  prompt: string,
  aspectRatio: string,
): Promise<string | null> {
  const url = `${API_BASE}/models/${GEMINI_NATIVE_MODEL}:generateContent?key=${apiKey}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `Generate an image: ${prompt}` }] }],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: { aspectRatio },
        },
      }),
      signal: controller.signal,
    });

    const data = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      const error = data.error as Record<string, unknown> | undefined;
      const code = error?.code as number | undefined;
      if (code === 429 || code === 400) return null; // fall through to Imagen
      return JSON.stringify({
        success: false,
        error:
          `Gemini error ${response.status}: ${(error?.message as string) ?? ""}`.slice(
            0,
            300,
          ),
      });
    }

    const candidates = data.candidates as
      | Array<Record<string, unknown>>
      | undefined;
    if (!candidates?.length) return null;

    const content = candidates[0].content as
      | Record<string, unknown>
      | undefined;
    const parts = content?.parts as Array<Record<string, unknown>> | undefined;
    if (!parts) return null;

    for (const part of parts) {
      const inlineData = part.inlineData as
        | { mimeType: string; data: string }
        | undefined;
      if (inlineData?.data) {
        return saveImage(
          inlineData.data,
          inlineData.mimeType,
          prompt,
          aspectRatio,
        );
      }
    }

    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function tryImagen(
  apiKey: string,
  prompt: string,
  negativePrompt: string | undefined,
  aspectRatio: string,
  size: string,
): Promise<string> {
  const url = `${API_BASE}/models/${IMAGEN_MODEL}:predict?key=${apiKey}`;

  const parameters: Record<string, unknown> = {
    sampleCount: 1,
    aspectRatio,
    sampleImageSize: size,
    personGeneration: "allow_adult",
    language: "en",
  };
  if (negativePrompt) parameters.negativePrompt = negativePrompt;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instances: [{ prompt }], parameters }),
      signal: controller.signal,
    });

    const data = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      const error = data.error as Record<string, unknown> | undefined;
      return JSON.stringify({
        success: false,
        error: `Imagen error ${response.status}: ${(error?.message as string) ?? JSON.stringify(data).slice(0, 300)}`,
      });
    }

    const predictions = data.predictions as
      | Array<Record<string, unknown>>
      | undefined;
    if (!predictions?.length) {
      return JSON.stringify({
        success: false,
        error: "No image generated. Prompt may have been safety-filtered.",
      });
    }

    const prediction = predictions[0];
    if (prediction.raiFilteredReason) {
      return JSON.stringify({
        success: false,
        error: `Safety filtered: ${prediction.raiFilteredReason}. Try rephrasing.`,
      });
    }

    const base64Data = prediction.bytesBase64Encoded as string;
    if (!base64Data) {
      return JSON.stringify({ success: false, error: "Empty image data." });
    }

    return saveImage(base64Data, "image/png", prompt, aspectRatio);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({
      success: false,
      error: message.includes("aborted")
        ? `Timed out after ${TIMEOUT_MS / 1000}s.`
        : message,
    });
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const geminiImageTool: Tool = {
  name: "gemini_image",
  requiresConfirmation: true,
  definition: {
    type: "function",
    function: {
      name: "gemini_image",
      description: `Generate an image from a text prompt using Google's Gemini/Imagen API.

USE WHEN:
- The user asks to generate, create, or produce an image
- You need a custom image for a blog post, presentation, or social media
- The user describes a visual concept they want created

WORKFLOW for WordPress posts:
1. Call gemini_image with a detailed English prompt
2. The tool returns a local file path to the generated image
3. Call wp_media_upload with image_url=<file_path> and filename=<filename> to upload to WordPress
4. Use the returned media_id as featured_media in wp_publish

PROMPT TIPS:
- Be specific: "A pair of worn running shoes next to a smartwatch showing VO2 Max metrics, dramatic lighting, photorealistic, dark background"
- Include style: "photorealistic", "watercolor", "minimalist", "editorial photography"
- Include mood: "warm golden hour", "dramatic side lighting", "soft diffused light"
- Negative prompt excludes elements: "blurry, text, watermark, low quality"

DO NOT narrate image generation — call this tool. If it fails, report the actual error.`,
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description:
              "Detailed image description. English recommended. Specify subject, style, lighting, composition.",
          },
          negative_prompt: {
            type: "string",
            description:
              'Elements to exclude. Example: "blurry, text, watermark, low quality, cartoon"',
          },
          aspect_ratio: {
            type: "string",
            enum: ["1:1", "3:4", "4:3", "9:16", "16:9"],
            description:
              'Aspect ratio. Default: "1:1". Use "16:9" for blog headers.',
          },
          size: {
            type: "string",
            enum: ["1K", "2K"],
            description: '"1K"=1024px, "2K"=2048px. Default: "1K".',
          },
        },
        required: ["prompt"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const apiKey = getApiKey();
    if (!apiKey) {
      return JSON.stringify({
        success: false,
        error:
          "No Gemini API key. Set GEMINI_API_KEY env var or store via user_fact_set (category: projects, key: gemini_api_key).",
      });
    }

    const prompt = args.prompt as string;
    const negativePrompt = args.negative_prompt as string | undefined;
    const aspectRatio = (args.aspect_ratio as string) ?? "1:1";
    const size = (args.size as string) ?? "1K";

    // Try Gemini native first (free tier), fall back to Imagen (paid)
    const geminiResult = await tryGeminiNative(apiKey, prompt, aspectRatio);
    if (geminiResult) return geminiResult;

    return tryImagen(apiKey, prompt, negativePrompt, aspectRatio, size);
  },
};
