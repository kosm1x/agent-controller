/**
 * Video script generator — LLM call that produces a structured VideoScript.
 */

import type { VideoScript } from "./types.js";

const SCRIPT_PROMPT = `You are a video script writer. Generate a structured video script as JSON.

RULES:
- Each scene has: text (narration), duration (seconds), imageQuery (Pexels search term)
- Total duration must match the requested duration (±5 seconds)
- Scenes should be 5-15 seconds each
- imageQuery must be a clear, specific search term for stock imagery
- Language matches the user's language (default: Spanish)
- Text should be conversational, suited for voice narration
- Keep narration concise — ~2-3 sentences per scene max

OUTPUT FORMAT (JSON only, no markdown):
{
  "title": "Video Title",
  "scenes": [
    { "text": "narration text", "duration": 8, "imageQuery": "stock photo query", "transition": "fade" }
  ],
  "totalDuration": 60,
  "language": "es"
}`;

/**
 * Generate a video script from a topic and duration.
 * Returns parsed VideoScript or throws on failure.
 */
export async function generateScript(
  topic: string,
  durationSeconds: number,
  language: string = "es",
): Promise<VideoScript> {
  const { infer } = await import("../inference/adapter.js");

  const result = await infer({
    messages: [
      { role: "system", content: SCRIPT_PROMPT },
      {
        role: "user",
        content: `Create a ${durationSeconds}-second video about: "${topic}". Language: ${language}.`,
      },
    ],
    max_tokens: 1500,
  });

  const raw = result.content ?? "";

  // Extract JSON from response (may be wrapped in markdown code fences)
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(
      `Script generation failed: no JSON in response. Got: ${raw.slice(0, 200)}`,
    );
  }

  const script = JSON.parse(jsonMatch[0]) as VideoScript;

  // Validate structure
  if (
    !script.scenes ||
    !Array.isArray(script.scenes) ||
    script.scenes.length === 0
  ) {
    throw new Error("Script has no scenes");
  }

  for (const scene of script.scenes) {
    if (!scene.text || !scene.duration || !scene.imageQuery) {
      throw new Error(`Invalid scene: missing text, duration, or imageQuery`);
    }
  }

  // Recalculate total
  script.totalDuration = script.scenes.reduce((sum, s) => sum + s.duration, 0);
  script.language = language;

  return script;
}
