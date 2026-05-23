/**
 * Vision inference — describe images using a vision-language model.
 *
 * Auto-detects the correct VL model from the primary model name.
 * Override via INFERENCE_VISION_MODEL env var.
 * Raw fetch, zero vendor SDKs — same pattern as adapter.ts.
 */

import { getConfig } from "../config.js";

const DEFAULT_PROMPT =
  "Describe esta imagen en detalle. Incluye texto visible, objetos, personas, contexto y cualquier información relevante.";

/**
 * Derive the vision-language model name from the primary model.
 * Each provider family has its own VL model naming convention.
 */
/**
 * @internal Exported for direct unit testing only. Production callers
 * should use {@link describeImage} — calling this directly bypasses the
 * URL/key resolution and HTTP layer.
 */
export function resolveVisionModel(): string {
  const override = process.env.INFERENCE_VISION_MODEL;
  if (override) return override;

  const primary = getConfig().inferencePrimaryModel;

  // Hermes May Tier-2 #8 audit foot-gun guard (2026-05-23): under the
  // claude-sdk routing (current production), `inferencePrimaryModel` is
  // EMPTY STRING. None of the prefix checks below match, and the bottom
  // `return "qwen-vl-max"` would silently switch vision to a different
  // vendor + key combination. Fail loud instead so the operator sees the
  // misconfiguration immediately on the next vision call.
  if (!primary) {
    throw new Error(
      "Vision model unresolved: INFERENCE_VISION_MODEL env var must be set when INFERENCE_PRIMARY_PROVIDER=claude-sdk (the SDK path leaves inferencePrimaryModel empty, so the prefix-derivation fallback below has no signal). " +
        "Recommended config: `INFERENCE_VISION_MODEL=meta-llama/llama-4-scout-17b-16e-instruct` plus `INFERENCE_VISION_URL` and `INFERENCE_VISION_KEY` pointing at a vision-capable provider (e.g., Groq) — without the URL/KEY pair the call would fall back to the SDK creds, which is not a vision endpoint.",
    );
  }

  // Zhipu/BigModel (glm-5, glm-4, etc.)
  if (primary.startsWith("glm-")) return "glm-4v-plus";
  // Qwen/DashScope
  if (primary.startsWith("qwen")) return "qwen-vl-max";
  // DeepSeek
  if (primary.startsWith("deepseek")) return "deepseek-ai/deepseek-vl2";
  // OpenAI
  if (primary.startsWith("gpt-")) return "gpt-4o";
  // Claude
  if (primary.startsWith("claude-")) return "claude-sonnet-4-20250514";

  return "qwen-vl-max";
}

/**
 * Describe an image using a vision-language model.
 *
 * @param imageBase64Url  Base64 data URL (data:image/jpeg;base64,...)
 * @param prompt          Optional prompt — defaults to a detailed Spanish description request
 * @returns               Text description of the image
 */
export async function describeImage(
  imageBase64Url: string,
  prompt?: string,
): Promise<string> {
  const config = getConfig();
  const visionModel = resolveVisionModel();
  // Vision routing: optional dedicated provider via env, falls back to primary.
  // Needed because some primary endpoints (e.g. DashScope coding-intl) only
  // support text/code models and reject vision-language model names.
  const baseUrl = (
    process.env.INFERENCE_VISION_URL ?? config.inferencePrimaryUrl
  ).replace(/\/+$/, "");
  const apiKey = process.env.INFERENCE_VISION_KEY ?? config.inferencePrimaryKey;
  const url = `${baseUrl}/chat/completions`;
  console.log(`[vision] Using model: ${visionModel} @ ${baseUrl}`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: visionModel,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt || DEFAULT_PROMPT },
            { type: "image_url", image_url: { url: imageBase64Url } },
          ],
        },
      ],
      max_tokens: 1024,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Vision inference failed: HTTP ${response.status}: ${text.slice(0, 200)}`,
    );
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return (
    data.choices?.[0]?.message?.content ?? "[No se pudo describir la imagen]"
  );
}
