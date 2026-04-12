/**
 * seo_meta_generate — Generate title/meta/OG/Twitter tags from content + target keyword.
 *
 * Template-guided LLM generation with strict character limit validation.
 * Returns 3 variants for user selection.
 *
 * Part of v7.3 Phase 1 SEO/GEO tool suite.
 */

import type { Tool } from "../types.js";
import { infer } from "../../inference/adapter.js";
import { webReadTool } from "./web-read.js";
import {
  CHAR_LIMITS,
  type ContentType,
  getFormula,
  validateMeta,
} from "./seo-references/meta-formulas.js";

const MAX_CONTENT_FOR_PROMPT = 3000;

interface MetaVariant {
  title: string;
  description: string;
  og_title: string;
  og_description: string;
  twitter_card: {
    card: "summary_large_image";
    title: string;
    description: string;
  };
  warnings: string[];
}

export const seoMetaGenerateTool: Tool = {
  name: "seo_meta_generate",
  deferred: true,
  riskTier: "low",
  triggerPhrases: [
    "genera meta tags",
    "optimiza el title",
    "meta description",
    "open graph",
    "og tags",
    "twitter card",
    "seo meta",
  ],
  definition: {
    type: "function",
    function: {
      name: "seo_meta_generate",
      description: `Generate SEO meta tags (title, meta description, Open Graph, Twitter card) for a page. Returns 3 variants under character limits with validation warnings.

USE WHEN:
- User wants to optimize an existing page's title/description for search
- Writing metadata for a new blog post, product, or landing page
- Need Open Graph + Twitter card tags for social sharing
- Comparing multiple metadata options (returns 3 variants)

DO NOT USE WHEN:
- Need structured data / JSON-LD (use seo_schema_generate instead)
- Writing the actual page content (use seo_content_brief instead)
- Auditing existing tags (use seo_page_audit instead)

CHARACTER LIMITS (enforced):
- title: 30-60 chars (Google SERP safe zone)
- meta description: 120-155 chars
- OG title: 30-60, OG description: 120-200
- Twitter title: 30-70, description: 120-200

CONTENT TYPES: article, product, category, landing, homepage, how_to, comparison, review, local_business

Returns JSON with 3 variants and each variant's validation warnings.`,
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description:
              "Either a URL to fetch and analyze, or raw page content/description. If URL, the tool fetches it via Jina Reader.",
          },
          target_keyword: {
            type: "string",
            description:
              "Primary SEO keyword to optimize for. Should appear in title and ideally near the start.",
          },
          content_type: {
            type: "string",
            enum: [
              "article",
              "product",
              "category",
              "landing",
              "homepage",
              "how_to",
              "comparison",
              "review",
              "local_business",
            ],
            description:
              "Page type — picks the template formula. Default: article.",
          },
          brand_voice: {
            type: "string",
            description:
              "Optional style guidance (e.g., 'professional', 'casual/friendly', 'technical/expert'). Injected into the prompt.",
          },
          brand_name: {
            type: "string",
            description:
              "Brand name to append to titles where appropriate (e.g., 'My Brand').",
          },
        },
        required: ["content", "target_keyword"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const content = args.content as string | undefined;
    const targetKeyword = args.target_keyword as string | undefined;

    if (!content) {
      return JSON.stringify({ error: "content is required" });
    }
    if (!targetKeyword) {
      return JSON.stringify({ error: "target_keyword is required" });
    }

    const contentType =
      (args.content_type as ContentType | undefined) ?? "article";
    const brandVoice = (args.brand_voice as string | undefined) ?? "";
    const brandName = (args.brand_name as string | undefined) ?? "";

    // If content looks like a URL, fetch it
    let pageContent = content;
    let sourceUrl: string | undefined;
    if (/^https?:\/\//i.test(content.trim())) {
      sourceUrl = content.trim();
      try {
        const fetchResult = await webReadTool.execute({ url: sourceUrl });
        const parsed = JSON.parse(fetchResult) as {
          content?: string;
          error?: string;
        };
        if (parsed.error) {
          return JSON.stringify({
            error: `Failed to fetch URL for meta generation: ${parsed.error}`,
            url: sourceUrl,
          });
        }
        pageContent = (parsed.content ?? "").slice(0, MAX_CONTENT_FOR_PROMPT);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return JSON.stringify({
          error: `Failed to fetch URL: ${message}`,
          url: sourceUrl,
        });
      }
    } else {
      pageContent = pageContent.slice(0, MAX_CONTENT_FOR_PROMPT);
    }

    const formula = getFormula(contentType);

    const prompt = [
      `You are an SEO meta tag generator. Produce exactly 3 distinct variants for the page described below.`,
      ``,
      `TARGET KEYWORD: ${targetKeyword}`,
      `CONTENT TYPE: ${contentType}`,
      brandName ? `BRAND: ${brandName}` : "",
      brandVoice ? `VOICE: ${brandVoice}` : "",
      ``,
      `PAGE CONTENT:`,
      pageContent,
      ``,
      `TITLE FORMULAS (pick or adapt):`,
      ...formula.titles.map((t) => `- ${t}`),
      ``,
      `DESCRIPTION FORMULAS:`,
      ...formula.descriptions.map((d) => `- ${d}`),
      ``,
      `CHARACTER LIMITS (strict):`,
      `- title: ${CHAR_LIMITS.title.min}-${CHAR_LIMITS.title.max} chars`,
      `- description: ${CHAR_LIMITS.description.min}-${CHAR_LIMITS.description.max} chars`,
      `- og_title: ${CHAR_LIMITS.og_title.min}-${CHAR_LIMITS.og_title.max}`,
      `- og_description: ${CHAR_LIMITS.og_description.min}-${CHAR_LIMITS.og_description.max}`,
      `- twitter_title: ${CHAR_LIMITS.twitter_title.min}-${CHAR_LIMITS.twitter_title.max}`,
      `- twitter_description: ${CHAR_LIMITS.twitter_description.min}-${CHAR_LIMITS.twitter_description.max}`,
      ``,
      `Include the target keyword in the title (near the start if possible). Keep each variant distinct in angle or benefit.`,
      ``,
      `Return ONLY valid JSON with this shape (no prose, no markdown code fence):`,
      `{"variants":[{"title":"...","description":"...","og_title":"...","og_description":"...","twitter_title":"...","twitter_description":"..."},{...},{...}]}`,
    ]
      .filter(Boolean)
      .join("\n");

    try {
      const response = await infer({
        messages: [
          {
            role: "system",
            content:
              "You are a precise SEO meta tag generator. Always return valid JSON matching the requested schema. Count characters carefully.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.7,
        max_tokens: 1500,
      });

      const text = (response.content ?? "").trim();
      const jsonMatch =
        text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*\}/);
      const rawJson = jsonMatch
        ? Array.isArray(jsonMatch)
          ? (jsonMatch[1] ?? jsonMatch[0])
          : jsonMatch
        : text;

      let parsed: { variants?: unknown };
      try {
        parsed = JSON.parse(typeof rawJson === "string" ? rawJson : text);
      } catch {
        return JSON.stringify({
          error: "LLM returned non-JSON response",
          raw: text.slice(0, 500),
        });
      }

      const rawVariants = Array.isArray(parsed.variants) ? parsed.variants : [];
      const variants: MetaVariant[] = rawVariants.slice(0, 3).map((v) => {
        const raw = v as {
          title?: string;
          description?: string;
          og_title?: string;
          og_description?: string;
          twitter_title?: string;
          twitter_description?: string;
        };
        const title = (raw.title ?? "").trim();
        const description = (raw.description ?? "").trim();
        const ogTitle = (raw.og_title ?? title).trim();
        const ogDescription = (raw.og_description ?? description).trim();
        const twTitle = (raw.twitter_title ?? ogTitle).trim();
        const twDescription = (raw.twitter_description ?? ogDescription).trim();

        const warnings = validateMeta({
          title,
          description,
          og_title: ogTitle,
          og_description: ogDescription,
          twitter_title: twTitle,
          twitter_description: twDescription,
        });

        return {
          title,
          description,
          og_title: ogTitle,
          og_description: ogDescription,
          twitter_card: {
            card: "summary_large_image",
            title: twTitle,
            description: twDescription,
          },
          warnings,
        };
      });

      if (variants.length === 0) {
        return JSON.stringify({
          error: "LLM returned no usable variants",
          raw: text.slice(0, 500),
        });
      }

      // Best variant = fewest warnings + title contains keyword
      const keywordLower = targetKeyword.toLowerCase();
      let bestIdx = 0;
      let bestScore = -Infinity;
      variants.forEach((v, idx) => {
        const titleHasKeyword = v.title.toLowerCase().includes(keywordLower)
          ? 1
          : 0;
        const score = titleHasKeyword * 10 - v.warnings.length;
        if (score > bestScore) {
          bestScore = score;
          bestIdx = idx;
        }
      });

      return JSON.stringify({
        target_keyword: targetKeyword,
        content_type: contentType,
        ...(sourceUrl ? { source_url: sourceUrl } : {}),
        variants,
        best_variant_idx: bestIdx,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: `Meta generation failed: ${message}` });
    }
  },
};
