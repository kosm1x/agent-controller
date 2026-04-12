/**
 * seo_schema_generate — Pure template-based JSON-LD schema markup generator.
 *
 * Zero LLM calls, zero external APIs. Produces valid schema.org JSON-LD
 * for the 6 most common types (Article, FAQPage, HowTo, Product,
 * LocalBusiness, BreadcrumbList) from structured data input.
 *
 * Part of v7.3 Phase 1 SEO/GEO tool suite.
 */

import type { Tool } from "../types.js";
import {
  type SchemaType,
  buildSchemaMarkup,
} from "./seo-references/schema-templates.js";

export const seoSchemaGenerateTool: Tool = {
  name: "seo_schema_generate",
  deferred: true,
  riskTier: "low",
  triggerPhrases: [
    "genera schema markup",
    "json-ld para",
    "structured data",
    "schema.org",
    "rich results",
    "faq schema",
    "howto schema",
  ],
  definition: {
    type: "function",
    function: {
      name: "seo_schema_generate",
      description: `Generate valid JSON-LD structured data (schema.org) for a page. Returns a ready-to-embed <script type="application/ld+json"> object.

USE WHEN:
- User wants to add rich results / schema markup to a page
- Building FAQ sections, how-to guides, product pages, or local business listings
- Need breadcrumb schema for nested navigation
- Preparing content for AI overview visibility (FAQPage and HowTo are strong GEO signals)

DO NOT USE WHEN:
- User wants to audit existing schema on a page (use seo_page_audit)
- User wants to write the content itself (use seo_content_brief)
- Need dynamic data from an API (this is a pure template tool)

SCHEMA TYPES:
- Article — blog posts, news, editorial content
- FAQPage — Q&A sections (strong GEO signal)
- HowTo — step-by-step guides (strong GEO signal)
- Product — e-commerce listings with price, rating, availability
- LocalBusiness — store/service locations with address and hours
- BreadcrumbList — navigation hierarchy for nested pages

Returns JSON with the schema markup string + validation warnings for missing required fields.`,
      parameters: {
        type: "object",
        properties: {
          schema_type: {
            type: "string",
            enum: [
              "Article",
              "FAQPage",
              "HowTo",
              "Product",
              "LocalBusiness",
              "BreadcrumbList",
            ],
            description:
              "Type of schema.org entity to generate. Pick based on the page content — Article for blog posts, FAQPage for Q&A sections, HowTo for tutorials, Product for e-commerce, LocalBusiness for store pages, BreadcrumbList for navigation.",
          },
          data: {
            type: "object",
            description: `Structured data for the schema. Required fields vary by type:
- Article: { headline, author, datePublished, image?, description?, dateModified?, publisher?, keywords? }
- FAQPage: { questions: [{ question, answer }, ...] }
- HowTo: { name, steps: [string | { name?, text, image? }, ...], description?, totalTime?, estimatedCost?, image? }
- Product: { name, description, image?, brand?, sku?, offers?: { price, priceCurrency?, availability?, url? }, aggregateRating?: { ratingValue, reviewCount } }
- LocalBusiness: { name, address: string | { streetAddress, addressLocality, addressRegion, postalCode, addressCountry }, telephone?, openingHours?, priceRange?, geo?: { latitude, longitude }, url?, image? }
- BreadcrumbList: { items: [{ name, url }, ...] }`,
          },
        },
        required: ["schema_type", "data"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const schemaType = args.schema_type as SchemaType | undefined;
    const data = args.data as Record<string, unknown> | undefined;

    if (!schemaType) {
      return JSON.stringify({ error: "schema_type is required" });
    }
    if (!data || typeof data !== "object") {
      return JSON.stringify({
        error: "data is required and must be an object",
      });
    }

    const validSchemaTypes: SchemaType[] = [
      "Article",
      "FAQPage",
      "HowTo",
      "Product",
      "LocalBusiness",
      "BreadcrumbList",
    ];
    if (!validSchemaTypes.includes(schemaType)) {
      return JSON.stringify({
        error: `Invalid schema_type "${schemaType}". Must be one of: ${validSchemaTypes.join(", ")}`,
      });
    }

    try {
      const result = buildSchemaMarkup(schemaType, data);
      return JSON.stringify({
        schema_type: schemaType,
        json_ld: result.json_ld,
        embed_html: `<script type="application/ld+json">\n${result.json_ld}\n</script>`,
        validation: result.validation,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({
        error: `Schema generation failed: ${message}`,
      });
    }
  },
};
