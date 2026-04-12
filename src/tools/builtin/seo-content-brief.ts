/**
 * seo_content_brief — E-E-A-T content brief generator.
 *
 * Produces a structured content brief (outline, target word count,
 * E-E-A-T signals, GEO tactics) for a topic, given target keywords
 * and intent. Optionally fetches an existing URL for refresh briefs.
 *
 * Part of v7.3 Phase 1 SEO/GEO tool suite.
 */

import type { Tool } from "../types.js";
import { infer } from "../../inference/adapter.js";
import { webReadTool } from "./web-read.js";
import {
  CONTENT_OUTLINES,
  WORD_COUNT_TARGETS,
  suggestEeatSignals,
} from "./seo-references/eeat-framework.js";
import { GEO_TACTICS } from "./seo-references/geo-signals.js";

type ContentIntent =
  | "informational"
  | "commercial"
  | "transactional"
  | "navigational";
type ContentFormat =
  | "how_to"
  | "comparison"
  | "review"
  | "pillar"
  | "landing"
  | "blog_post";

const MAX_REFRESH_CONTENT = 3000;

export const seoContentBriefTool: Tool = {
  name: "seo_content_brief",
  deferred: true,
  riskTier: "low",
  triggerPhrases: [
    "content brief",
    "brief de contenido",
    "planea el contenido",
    "outline seo",
    "refresca este post",
    "estructura del artículo",
  ],
  definition: {
    type: "function",
    function: {
      name: "seo_content_brief",
      description: `Generate an E-E-A-T compliant content brief: outline, headings, target word count, keywords, and GEO optimization tactics. Optionally fetches an existing URL for a refresh brief.

USE WHEN:
- Planning a new blog post, landing page, or pillar content
- Refreshing existing content that's losing rankings
- Briefing a writer on SEO + GEO requirements
- Deciding content structure before drafting

DO NOT USE WHEN:
- Writing the actual prose (this produces a brief, not finished content)
- Generating meta tags (use seo_meta_generate)
- Generating JSON-LD schema (use seo_schema_generate)
- Researching keywords (use seo_keyword_research)

FORMATS:
- how_to — step-by-step tutorials (strong GEO signal)
- comparison — A vs B style (strong GEO signal)
- review — product/service reviews
- pillar — comprehensive topic hub (long-form)
- landing — conversion-focused page
- blog_post — general informational article

OUTPUT:
- title_options: 3-5 title suggestions
- outline: H2/H3 section structure
- word_count_target: [min, max] appropriate for intent + format
- keywords_to_include: primary + secondary + semantic
- eeat_signals: specific E-E-A-T elements to include
- geo_tactics: AI overview optimization recommendations`,
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description:
              "The topic / subject of the content (e.g., 'choosing an EHR for small clinics').",
          },
          target_keywords: {
            type: "array",
            items: { type: "string" },
            description:
              "Primary + secondary keywords to weave into the content. First item is the primary.",
          },
          intent: {
            type: "string",
            enum: [
              "informational",
              "commercial",
              "transactional",
              "navigational",
            ],
            description:
              "User search intent this content serves. Drives word count + tone.",
          },
          format: {
            type: "string",
            enum: [
              "how_to",
              "comparison",
              "review",
              "pillar",
              "landing",
              "blog_post",
            ],
            description:
              "Content format — picks the outline scaffold. Default: blog_post.",
          },
          audience: {
            type: "string",
            description:
              "Target audience (e.g., 'clinic administrators', 'DIY homeowners').",
          },
          existing_url: {
            type: "string",
            description:
              "Optional: URL of existing content being refreshed. The tool fetches it for context.",
          },
        },
        required: ["topic", "intent"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const topic = args.topic as string | undefined;
    const intent = args.intent as ContentIntent | undefined;

    if (!topic) {
      return JSON.stringify({ error: "topic is required" });
    }
    if (!intent) {
      return JSON.stringify({ error: "intent is required" });
    }

    const targetKeywords = Array.isArray(args.target_keywords)
      ? (args.target_keywords as unknown[]).filter(
          (k): k is string => typeof k === "string" && k.trim().length > 0,
        )
      : [];
    const format = (args.format as ContentFormat | undefined) ?? "blog_post";
    const audience = (args.audience as string | undefined) ?? "";
    const existingUrl = args.existing_url as string | undefined;

    // Optional: fetch existing content for refresh briefs
    let existingContent: string | undefined;
    if (existingUrl) {
      try {
        const raw = await webReadTool.execute({ url: existingUrl });
        const parsed = JSON.parse(raw) as {
          content?: string;
          error?: string;
        };
        if (!parsed.error && parsed.content) {
          existingContent = parsed.content.slice(0, MAX_REFRESH_CONTENT);
        }
      } catch {
        // Non-fatal — continue without refresh context
      }
    }

    // Pick outline scaffold (blog_post falls back to pillar for structure)
    const outlineScaffold =
      CONTENT_OUTLINES[format as keyof typeof CONTENT_OUTLINES] ??
      CONTENT_OUTLINES.pillar;

    // Word count target from rubric
    const intentTargets = WORD_COUNT_TARGETS[
      intent as keyof typeof WORD_COUNT_TARGETS
    ] as Record<string, readonly [number, number]> | undefined;
    let wordCountRange: [number, number] = [800, 1500];
    if (intentTargets) {
      const pick =
        (format === "pillar" && intentTargets.pillar) ||
        intentTargets.long ||
        intentTargets.medium ||
        intentTargets.short;
      if (pick) {
        wordCountRange = [pick[0], pick[1]];
      }
    }

    // E-E-A-T signals for this content type + intent
    const eeatSignals = suggestEeatSignals(format, intent);

    // Pick GEO tactics relevant to the format (how_to, comparison, pillar are strongest)
    const selectedGeoTactics =
      format === "how_to" || format === "comparison" || format === "pillar"
        ? GEO_TACTICS.slice(0, 8)
        : GEO_TACTICS.slice(0, 5);

    // LLM call: produce title options + specific outline + keyword strategy
    const prompt = [
      `You are an SEO + GEO content strategist. Produce a concrete content brief.`,
      ``,
      `TOPIC: ${topic}`,
      `INTENT: ${intent}`,
      `FORMAT: ${format}`,
      targetKeywords.length > 0 ? `PRIMARY KEYWORD: ${targetKeywords[0]}` : "",
      targetKeywords.length > 1
        ? `SECONDARY KEYWORDS: ${targetKeywords.slice(1).join(", ")}`
        : "",
      audience ? `AUDIENCE: ${audience}` : "",
      ``,
      `OUTLINE SCAFFOLD (adapt to topic):`,
      ...outlineScaffold.map((s) => `- ${s}`),
      ``,
      existingContent
        ? `EXISTING CONTENT TO REFRESH (first ${MAX_REFRESH_CONTENT} chars):\n${existingContent}\n`
        : "",
      `Produce a brief with:`,
      `- 5 distinct title_options (each 30-60 chars, include primary keyword)`,
      `- A specific outline: H2 and H3 headings tailored to this topic`,
      `- keywords_to_include: primary + 5-10 semantic keywords`,
      `- 3-5 key questions the content must answer (for FAQ section)`,
      ``,
      `Return ONLY valid JSON matching this shape (no prose, no markdown fence):`,
      `{"title_options": ["...","...","...","...","..."], "outline": [{"heading":"H2: ...","subheadings":["H3: ...","H3: ..."]}], "keywords_to_include": ["..."], "key_questions": ["..."]}`,
    ]
      .filter(Boolean)
      .join("\n");

    try {
      const response = await infer({
        messages: [
          {
            role: "system",
            content:
              "You are a precise SEO content strategist. Always return valid JSON matching the requested schema.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.7,
        max_tokens: 2000,
      });

      const text = (response.content ?? "").trim();
      const jsonMatch =
        text.match(/```json\s*([\s\S]*?)\s*```/)?.[1] ??
        text.match(/\{[\s\S]*\}/)?.[0] ??
        text;

      let llmBrief: {
        title_options?: unknown;
        outline?: unknown;
        keywords_to_include?: unknown;
        key_questions?: unknown;
      };
      try {
        llmBrief = JSON.parse(jsonMatch);
      } catch {
        return JSON.stringify({
          error: "LLM returned non-JSON response",
          raw: text.slice(0, 500),
        });
      }

      return JSON.stringify({
        topic,
        intent,
        format,
        audience: audience || undefined,
        ...(existingUrl ? { refresh_of: existingUrl } : {}),
        brief: {
          title_options: Array.isArray(llmBrief.title_options)
            ? llmBrief.title_options
            : [],
          outline: Array.isArray(llmBrief.outline) ? llmBrief.outline : [],
          word_count_target: {
            min: wordCountRange[0],
            max: wordCountRange[1],
          },
          keywords_to_include: Array.isArray(llmBrief.keywords_to_include)
            ? llmBrief.keywords_to_include
            : targetKeywords,
          key_questions: Array.isArray(llmBrief.key_questions)
            ? llmBrief.key_questions
            : [],
          eeat_signals: eeatSignals.map((s) => ({
            category: s.category,
            signal: s.signal,
          })),
          geo_tactics: selectedGeoTactics,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({
        error: `Content brief generation failed: ${message}`,
      });
    }
  },
};
