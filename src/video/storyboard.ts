/**
 * Storyboard pipeline — v7.4 S2a.
 *
 * Takes a brief + duration + optional brand profile, asks an LLM to emit a
 * structured `VideoCompositionManifest`, then returns the parsed+validated
 * manifest WITHOUT executing a render. Operator inspects the manifest, then
 * pipes into `video_compose_manifest` to actually produce the MP4.
 *
 * Defensive against prompt injection: URLs in the brief are scrubbed before
 * reaching the LLM; brand DNA fields are sanitized at storage boundary via
 * v7.3 P4a defenses; the LLM output is JSON-parsed + validated through
 * `validateManifest` before any downstream consumer sees it.
 */

import { infer } from "../inference/adapter.js";
import { getDatabase } from "../db/index.js";
import {
  validateManifest,
  type VideoCompositionManifest,
  type SceneSpec,
} from "./composition-protocol.js";
import {
  CAMERA_MODIFIERS,
  LIGHTING_STYLES,
  MOOD_ARCHETYPES,
} from "./cinema-prompts.js";

const MAX_BRIEF_LENGTH = 4000;
/**
 * URL / active-content scheme redactor — scrubs full URLs (not just scheme
 * prefix) from user-authored brief text. Includes http(s), ftp, file, data:
 * URIs, and javascript:/mailto: which could prime LLM with active content
 * or PII hints. Per Round-2 S2a W2 audit.
 */
const URL_PATTERN =
  /\b(?:https?|ftp|file|data|javascript|mailto):[^\s<>)"']+/gi;

export interface StoryboardInputs {
  brief: string;
  duration: number;
  template?: "landscape" | "portrait" | "square";
  language?: string;
  style?: "aspirational" | "gritty" | "playful" | "luxurious" | "minimalist";
  fps?: 24 | 30 | 60;
  brand_id?: number;
}

export interface BrandProfileRow {
  id: number;
  domain: string;
  source_url: string | null;
  brand_name: string | null;
  profile: string;
  raw_source_preview: string | null;
  created_at: string;
}

export interface BrandProfileShape {
  brand_name?: string;
  tagline?: string;
  voice?: { descriptor?: string; tone?: string[] };
  colors?: { primary?: string; secondary?: string[]; notes?: string };
  keywords_lexicon?: string[];
  avoid_lexicon?: string[];
}

/**
 * Strip URLs from user-provided brief text. We do NOT fetch them from the
 * storyboard pipeline; if the user wants URL-derived content they should
 * call `ads_brand_dna` first and pass `brand_id`.
 */
function sanitizeBrief(brief: string): string {
  return brief.replace(URL_PATTERN, "[url-redacted]");
}

function loadBrandProfile(
  db: ReturnType<typeof getDatabase>,
  brandId: number,
): BrandProfileShape | null {
  try {
    const row = db
      .prepare("SELECT profile FROM ads_brand_profiles WHERE id = ?")
      .get(brandId) as { profile: string } | undefined;
    if (!row?.profile) return null;
    const parsed = JSON.parse(row.profile) as BrandProfileShape;
    return parsed;
  } catch {
    return null;
  }
}

function buildStoryboardPrompt(
  inputs: StoryboardInputs,
  brand: BrandProfileShape | null,
): string {
  const cleanBrief = sanitizeBrief(inputs.brief).slice(0, MAX_BRIEF_LENGTH);
  const template = inputs.template ?? "landscape";
  const language = inputs.language ?? "es";
  const fps = inputs.fps ?? 30;
  const style = inputs.style;

  const brandSummary = brand
    ? [
        `Brand name: ${brand.brand_name ?? "(unknown)"}`,
        brand.tagline ? `Tagline: ${brand.tagline}` : null,
        brand.voice?.descriptor ? `Voice: ${brand.voice.descriptor}` : null,
        Array.isArray(brand.voice?.tone) && brand.voice.tone.length > 0
          ? `Tone attributes: ${brand.voice.tone.slice(0, 6).join(", ")}`
          : null,
        Array.isArray(brand.keywords_lexicon) &&
        brand.keywords_lexicon.length > 0
          ? `Use these words: ${brand.keywords_lexicon.slice(0, 20).join(", ")}`
          : null,
        Array.isArray(brand.avoid_lexicon) && brand.avoid_lexicon.length > 0
          ? `Avoid these words: ${brand.avoid_lexicon.slice(0, 20).join(", ")}`
          : null,
      ]
        .filter(Boolean)
        .join("\n")
    : "No brand profile supplied — use neutral professional voice.";

  // W1 fix: feed `prompt_fragment` values (not just ids) so the LLM has
  // real cinematography guidance. Limit to 6 per catalog to keep prompt size
  // bounded (~600 chars total budget).
  const cinemaHints = [
    "Camera options (pick 2-4 scene-appropriate):",
    ...CAMERA_MODIFIERS.slice(0, 6).map(
      (m) => `  - ${m.id}: ${m.prompt_fragment}`,
    ),
    "Lighting options:",
    ...LIGHTING_STYLES.slice(0, 6).map(
      (m) => `  - ${m.id}: ${m.prompt_fragment}`,
    ),
    "Mood archetypes:",
    ...MOOD_ARCHETYPES.slice(0, 6).map(
      (m) => `  - ${m.id}: ${m.prompt_fragment}`,
    ),
  ].join("\n");

  const styleGuidance = style
    ? `Overall style archetype: ${style}`
    : "Choose style based on the brief.";

  return `You are a video storyboard director. Produce a VideoCompositionManifest as valid JSON.

Brief: ${cleanBrief}

${brandSummary}

Total duration: ${inputs.duration}s. Template: ${template}. Language: ${language}. FPS: ${fps}. ${styleGuidance}

${cinemaHints}

Constraints:
- 3-8 scenes. Scene durations sum to the total duration.
- Each scene: durationSec (3-15s), text (narration, ${language}, <500 chars), imageQuery (Pexels search string in English, 2-5 words).
- scenes[].index MUST be sequential starting at 0.
- Do NOT include any other top-level fields. Do NOT use imagePath.
- Output ONLY the JSON object. No prose.

Schema:
{"version":1,"title":"...","template":"${template}","fps":${fps},"language":"${language}","scenes":[{"index":0,"durationSec":...,"text":"...","imageQuery":"...","transitionToNext":"fade"}]}`;
}

/**
 * Attempt to extract the first JSON object from an LLM response that may
 * contain stray text around the answer.
 */
function extractJsonBlock(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return trimmed;
  // Try fenced block
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(trimmed);
  if (fence) return fence[1].trim();
  // Try first-{ to matching-} scan (naive but works for well-formed single objects)
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return null;
}

/**
 * Main entry: produce a validated VideoCompositionManifest from a brief.
 * Throws on LLM failure, parse failure, or validation failure.
 */
export async function generateStoryboard(
  inputs: StoryboardInputs,
): Promise<VideoCompositionManifest> {
  if (!inputs.brief || typeof inputs.brief !== "string") {
    throw new Error("generateStoryboard: brief is required");
  }
  if (
    !Number.isFinite(inputs.duration) ||
    inputs.duration < 15 ||
    inputs.duration > 120
  ) {
    throw new Error("generateStoryboard: duration must be in [15, 120]");
  }

  const db = getDatabase();
  const brand =
    typeof inputs.brand_id === "number"
      ? loadBrandProfile(db, inputs.brand_id)
      : null;

  if (typeof inputs.brand_id === "number" && !brand) {
    throw new Error(
      `generateStoryboard: brand_id ${inputs.brand_id} not found in ads_brand_profiles`,
    );
  }

  const prompt = buildStoryboardPrompt(inputs, brand);

  const llmResponse = await infer({
    messages: [
      {
        role: "system",
        content: "You are a concise video storyboard director.",
      },
      { role: "user", content: prompt },
    ],
  });

  const body = llmResponse.content ?? "";
  const jsonBlock = extractJsonBlock(body);
  if (!jsonBlock) {
    throw new Error(
      "generateStoryboard: LLM response contained no JSON object",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonBlock);
  } catch (err) {
    throw new Error(
      `generateStoryboard: LLM JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const manifest = parsed as VideoCompositionManifest;
  // Defensive: force-fill template/fps/language/brandProfileId from caller if LLM drifted
  manifest.template = inputs.template ?? manifest.template ?? "landscape";
  manifest.fps = inputs.fps ?? manifest.fps ?? 30;
  manifest.language = inputs.language ?? manifest.language ?? "es";
  if (typeof inputs.brand_id === "number") {
    manifest.brandProfileId = inputs.brand_id;
  }

  // Re-index scenes defensively (LLM sometimes drifts)
  if (Array.isArray(manifest.scenes)) {
    manifest.scenes = manifest.scenes.map(
      (scene, i) =>
        ({
          ...scene,
          index: i,
        }) as SceneSpec,
    );
  }

  validateManifest(manifest);
  return manifest;
}
