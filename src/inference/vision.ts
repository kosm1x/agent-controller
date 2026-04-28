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
function resolveVisionModel(): string {
  const override = process.env.INFERENCE_VISION_MODEL;
  if (override) return override;

  const primary = getConfig().inferencePrimaryModel;

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
