/**
 * ads_creative_gen — Generate ad creative variants from a brand brief + framework.
 *
 * Loads a stored brand profile (by brief_id) OR takes an inline brief, renders
 * the selected framework's prompt template with brand voice cues, and asks the
 * LLM for N creative variants (headline + body + CTA per variant).
 *
 * Output is persisted to `ads_creatives` so variants can be revisited, A/B
 * results logged, or fed back into ads_audit as the creative inventory.
 *
 * Part of v7.3 Phase 4 — Digital Marketing Buyer (P4a slice).
 */

import type { Tool } from "../types.js";
import { infer } from "../../inference/adapter.js";
import { getDatabase, writeWithRetry } from "../../db/index.js";
import {
  ALL_FRAMEWORK_IDS,
  CREATIVE_FRAMEWORKS,
  renderFrameworkPrompt,
  type FrameworkId,
} from "./ads-references/creative-frameworks.js";

const VALID_PLATFORMS = [
  "google_search",
  "google_display",
  "meta_feed",
  "linkedin_feed",
  "tiktok_feed",
  "youtube_preroll",
  "microsoft_search",
  "apple_search_ads",
] as const;
type CreativePlatform = (typeof VALID_PLATFORMS)[number];

const VALID_OBJECTIVES = [
  "awareness",
  "traffic",
  "engagement",
  "leads",
  "app_installs",
  "conversions",
  "sales",
  "retargeting",
] as const;
type AdObjective = (typeof VALID_OBJECTIVES)[number];

interface LoadedBrief {
  brand: string;
  audience: string;
  voice_descriptor: string;
  keywords_lexicon: string[];
  avoid_lexicon: string[];
}

function loadBriefFromDb(brief_id: number): LoadedBrief | null {
  try {
    const db = getDatabase();
    const row = db
      .prepare(
        "SELECT brand_name, profile FROM ads_brand_profiles WHERE id = ?",
      )
      .get(brief_id) as { brand_name: string; profile: string } | undefined;
    if (!row) return null;
    const profile = JSON.parse(row.profile) as Record<string, unknown>;
    const voice = (profile.voice ?? {}) as Record<string, unknown>;
    return {
      brand: row.brand_name,
      audience: Array.isArray(profile.audience_hints)
        ? (profile.audience_hints as string[]).join(", ")
        : "",
      voice_descriptor:
        typeof voice.descriptor === "string"
          ? (voice.descriptor as string)
          : "",
      keywords_lexicon: Array.isArray(profile.keywords_lexicon)
        ? (profile.keywords_lexicon as string[])
        : [],
      avoid_lexicon: Array.isArray(profile.avoid_lexicon)
        ? (profile.avoid_lexicon as string[])
        : [],
    };
  } catch (err) {
    console.warn(
      `[ads_creative_gen] Failed to load brief ${brief_id}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

interface Variant {
  headline: string;
  body: string;
  cta: string;
  framework_sections?: Record<string, string>;
}

function persistCreatives(
  brand: string,
  framework: FrameworkId,
  platform: CreativePlatform,
  objective: AdObjective,
  variants: Variant[],
  brief_id: number | null,
): number | null {
  try {
    return writeWithRetry(() => {
      const db = getDatabase();
      const stmt = db.prepare(
        `INSERT INTO ads_creatives
          (brand_name, framework, platform, objective, brief_id, variants)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const info = stmt.run(
        brand,
        framework,
        platform,
        objective,
        brief_id,
        JSON.stringify(variants),
      );
      return typeof info.lastInsertRowid === "bigint"
        ? Number(info.lastInsertRowid)
        : (info.lastInsertRowid as number);
    });
  } catch (err) {
    console.warn(
      `[ads_creative_gen] Failed to persist creatives: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

function coerceVariants(raw: unknown): Variant[] {
  if (!Array.isArray(raw)) return [];
  const out: Variant[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const obj = v as Record<string, unknown>;
    const headline = typeof obj.headline === "string" ? obj.headline : "";
    const body = typeof obj.body === "string" ? obj.body : "";
    const cta = typeof obj.cta === "string" ? obj.cta : "";
    if (!headline && !body) continue;
    const variant: Variant = { headline, body, cta };
    if (obj.framework_sections && typeof obj.framework_sections === "object") {
      const sections: Record<string, string> = {};
      for (const [k, val] of Object.entries(
        obj.framework_sections as Record<string, unknown>,
      )) {
        if (typeof val === "string") sections[k] = val;
      }
      variant.framework_sections = sections;
    }
    out.push(variant);
  }
  return out;
}

export const adsCreativeGenTool: Tool = {
  name: "ads_creative_gen",
  deferred: true,
  riskTier: "low",
  triggerPhrases: [
    "genera anuncios",
    "generate ad copy",
    "creatividades",
    "ad variants",
    "ad creative",
  ],
  definition: {
    type: "function",
    function: {
      name: "ads_creative_gen",
      description: `Generate N ad creative variants (headline + body + CTA) for a brand, using a chosen copywriting framework (AIDA / PAS / BAB / FAB / 4P / Star-Story-Solution). Optional brief_id (from ads_brand_dna) loads brand voice + lexicon so copy sounds on-brand.

USE WHEN:
- User asks "genera anuncios para X", "give me 5 ad variants", "write Meta creative"
- Brainstorming copy rotation for an active campaign
- After ads_brand_dna ran and the operator is ready to produce copy

DO NOT USE WHEN:
- User wants the brief itself (use ads_brand_dna first)
- User wants to audit existing performance (use ads_audit)
- User wants image generation (use gemini_image / hf_generate)

FRAMEWORKS:
- AIDA — Attention / Interest / Desire / Action (cold funnel)
- PAS — Problem / Agitate / Solution (pain-aware audiences)
- BAB — Before / After / Bridge (transformation products)
- FAB — Feature / Advantage / Benefit (B2B / SaaS technical)
- 4P — Picture / Promise / Prove / Push (high-ticket with proof)
- Star-Story-Solution — narrative arc (video, brand-building)`,
      parameters: {
        type: "object",
        properties: {
          brief_id: {
            type: "number",
            description:
              "Optional. ID of a stored brand profile from ads_brand_dna. If present, the brand's voice + lexicon is applied automatically.",
          },
          brand: {
            type: "string",
            description: "Brand name. Required if brief_id is not provided.",
          },
          audience: {
            type: "string",
            description:
              "Target audience (e.g. 'SaaS founders, 25-45, US/EU'). Required if brief_id is not provided.",
          },
          offer: {
            type: "string",
            description:
              "Concrete offer to advertise (product + key benefit + price point if relevant). Always required.",
          },
          objective: {
            type: "string",
            enum: VALID_OBJECTIVES,
            description: "Campaign objective (conversions, leads, etc.).",
          },
          platform: {
            type: "string",
            enum: VALID_PLATFORMS,
            description:
              "Target ad placement. Shapes format: search is headline-heavy; meta/tiktok favor body; youtube/video favors narrative.",
          },
          framework: {
            type: "string",
            enum: ALL_FRAMEWORK_IDS,
            description:
              "Which copywriting framework to apply. See tool description for when to use which.",
          },
          n_variants: {
            type: "number",
            description:
              "How many distinct variants to produce (1-5). Default 3.",
          },
        },
        required: ["offer", "objective", "platform", "framework"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const briefId =
      typeof args.brief_id === "number"
        ? args.brief_id
        : typeof args.brief_id === "string"
          ? Number(args.brief_id)
          : null;
    const brandArg = typeof args.brand === "string" ? args.brand : "";
    const audienceArg = typeof args.audience === "string" ? args.audience : "";
    const offer = typeof args.offer === "string" ? args.offer.trim() : "";
    const objective = args.objective as AdObjective | undefined;
    const platform = args.platform as CreativePlatform | undefined;
    const framework = args.framework as FrameworkId | undefined;
    const nVariantsRaw =
      typeof args.n_variants === "number" ? args.n_variants : 3;
    const nVariants = Math.max(1, Math.min(5, Math.round(nVariantsRaw)));

    if (!offer) {
      return JSON.stringify({ error: "offer is required" });
    }
    if (!objective || !VALID_OBJECTIVES.includes(objective)) {
      return JSON.stringify({
        error: `objective must be one of: ${VALID_OBJECTIVES.join(", ")}`,
      });
    }
    if (!platform || !VALID_PLATFORMS.includes(platform)) {
      return JSON.stringify({
        error: `platform must be one of: ${VALID_PLATFORMS.join(", ")}`,
      });
    }
    if (!framework || !ALL_FRAMEWORK_IDS.includes(framework)) {
      return JSON.stringify({
        error: `framework must be one of: ${ALL_FRAMEWORK_IDS.join(", ")}`,
      });
    }

    let brief: LoadedBrief | null = null;
    let briefIdResolved: number | null = null;
    if (briefId !== null && Number.isFinite(briefId)) {
      brief = loadBriefFromDb(briefId);
      if (brief) briefIdResolved = briefId;
    }

    const brand = brief?.brand ?? brandArg;
    const audience = brief?.audience || audienceArg;
    if (!brand) {
      return JSON.stringify({
        error: "brand is required (or pass a valid brief_id)",
      });
    }
    if (!audience) {
      return JSON.stringify({
        error: "audience is required (or pass a valid brief_id)",
      });
    }

    const baseTemplate = renderFrameworkPrompt(framework, {
      brand,
      audience,
      objective,
      platform,
      offer,
    });
    const voiceNote = brief?.voice_descriptor
      ? `\nVOICE DESCRIPTOR: ${brief.voice_descriptor}`
      : "";
    const lexicon = brief
      ? `\nUSE these words where natural: ${brief.keywords_lexicon.join(", ") || "(none specified)"}\nAVOID these words: ${brief.avoid_lexicon.join(", ") || "(none specified)"}`
      : "";

    const prompt = `${baseTemplate}${voiceNote}${lexicon}

Produce ${nVariants} distinct variants. Return ONLY valid JSON, no prose, no markdown fence:
{"variants":[{"headline":"","body":"","cta":"","framework_sections":{${CREATIVE_FRAMEWORKS[
      framework
    ].sections
      .map((s) => `"${s}":""`)
      .join(",")}}}]}`;

    let variants: Variant[];
    try {
      const response = await infer({
        messages: [
          {
            role: "system",
            content:
              "You are a senior direct-response copywriter. You write concise, specific ad copy that sounds like a human, not a feature list. Always return valid JSON matching the schema.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.8,
        max_tokens: 1800,
      });
      const text = (response.content ?? "").trim();
      const jsonText =
        text.match(/```json\s*([\s\S]*?)\s*```/)?.[1] ??
        text.match(/\{[\s\S]*\}/)?.[0] ??
        text;
      const parsed = JSON.parse(jsonText) as { variants?: unknown };
      variants = coerceVariants(parsed.variants);
      if (variants.length === 0) {
        return JSON.stringify({
          error: "LLM returned no usable variants",
          raw: text.slice(0, 500),
        });
      }
    } catch (err) {
      return JSON.stringify({
        error: `LLM inference failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    const creativeSetId = persistCreatives(
      brand,
      framework,
      platform,
      objective,
      variants,
      briefIdResolved,
    );

    return JSON.stringify({
      brand,
      framework,
      platform,
      objective,
      brief_id: briefIdResolved,
      n_variants: variants.length,
      creative_set_id: creativeSetId,
      variants,
    });
  },
};
