/**
 * Test helper, not a test file: the environment names that a test worker
 * never inherits from the shell that starts the run. Each name, set alone or
 * together with the others its client needs, switches on a call to an outside
 * service (model providers and vision, embeddings, speech, image generation,
 * research, search and page reading, the shadow scorer, the memory service)
 * from code a test can reach. A test supplies the keys it needs itself.
 *
 * Imports nothing: the per-worker setup file loads it before any test file.
 */

export const OUTSIDE_CALL_ENV = [
  "INFERENCE_PRIMARY_URL",
  "INFERENCE_PRIMARY_KEY",
  "INFERENCE_FALLBACK_URL",
  "INFERENCE_FALLBACK_KEY",
  "INFERENCE_TERTIARY_URL",
  "INFERENCE_TERTIARY_KEY",
  "INFERENCE_VISION_URL",
  "INFERENCE_VISION_KEY",
  "GEMINI_API_KEY",
  "EMBEDDING_KEY",
  "WHISPER_API_KEY",
  "HUGGINGFACE_TOKEN",
  "PEXELS_API_KEY",
  "JINA_API_KEY",
  "BRAVE_SEARCH_API_KEY",
  "EXA_API_KEY",
  "EXPAND_API_KEY",
  "TYPESAFE_API_KEY",
  "HINDSIGHT_ENABLED",
] as const;

/** Deletes every listed name from `env`; returns how many were present. */
export function dropOutsideCallEnv(env: Record<string, string | undefined>): number {
  let removed = 0;
  for (const name of OUTSIDE_CALL_ENV) {
    if (name in env) {
      delete env[name];
      removed++;
    }
  }
  return removed;
}
