/**
 * Tests for seo_schema_generate — pure template-based JSON-LD generator.
 */

import { describe, it, expect } from "vitest";
import { seoSchemaGenerateTool } from "./seo-schema-generate.js";

async function exec(args: Record<string, unknown>) {
  const result = await seoSchemaGenerateTool.execute(args);
  return JSON.parse(result);
}

describe("seo_schema_generate", () => {
  it("generates valid Article schema with required fields", async () => {
    const result = await exec({
      schema_type: "Article",
      data: {
        headline: "Test Article Title",
        author: "Jane Doe",
        datePublished: "2026-04-12",
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.schema_type).toBe("Article");
    expect(result.validation.valid).toBe(true);
    const jsonLd = JSON.parse(result.json_ld);
    expect(jsonLd["@type"]).toBe("Article");
    expect(jsonLd.headline).toBe("Test Article Title");
    expect(jsonLd.author.name).toBe("Jane Doe");
  });

  it("generates FAQPage schema with Q&A entries", async () => {
    const result = await exec({
      schema_type: "FAQPage",
      data: {
        questions: [
          { question: "What is SEO?", answer: "Search engine optimization." },
          {
            question: "What is GEO?",
            answer: "Generative engine optimization.",
          },
        ],
      },
    });
    expect(result.validation.valid).toBe(true);
    const jsonLd = JSON.parse(result.json_ld);
    expect(jsonLd["@type"]).toBe("FAQPage");
    expect(jsonLd.mainEntity).toHaveLength(2);
    expect(jsonLd.mainEntity[0].acceptedAnswer.text).toBe(
      "Search engine optimization.",
    );
  });

  it("generates HowTo schema with numbered steps", async () => {
    const result = await exec({
      schema_type: "HowTo",
      data: {
        name: "How to boil water",
        steps: ["Fill pot", "Turn on stove", "Wait"],
      },
    });
    expect(result.validation.valid).toBe(true);
    const jsonLd = JSON.parse(result.json_ld);
    expect(jsonLd["@type"]).toBe("HowTo");
    expect(jsonLd.step).toHaveLength(3);
    expect(jsonLd.step[0].position).toBe(1);
    expect(jsonLd.step[0].text).toBe("Fill pot");
  });

  it("generates Product schema with offers and rating", async () => {
    const result = await exec({
      schema_type: "Product",
      data: {
        name: "Test Widget",
        description: "A great widget for testing",
        brand: "Acme",
        offers: {
          price: 19.99,
          priceCurrency: "USD",
        },
        aggregateRating: { ratingValue: 4.5, reviewCount: 100 },
      },
    });
    expect(result.validation.valid).toBe(true);
    const jsonLd = JSON.parse(result.json_ld);
    expect(jsonLd["@type"]).toBe("Product");
    expect(jsonLd.offers.price).toBe(19.99);
    expect(jsonLd.aggregateRating.ratingValue).toBe(4.5);
  });

  it("generates LocalBusiness schema with structured address", async () => {
    const result = await exec({
      schema_type: "LocalBusiness",
      data: {
        name: "Test Cafe",
        address: {
          streetAddress: "123 Main St",
          addressLocality: "Mexico City",
          addressRegion: "CDMX",
          postalCode: "01000",
          addressCountry: "MX",
        },
        telephone: "+52-555-1234",
      },
    });
    expect(result.validation.valid).toBe(true);
    const jsonLd = JSON.parse(result.json_ld);
    expect(jsonLd["@type"]).toBe("LocalBusiness");
    expect(jsonLd.address["@type"]).toBe("PostalAddress");
    expect(jsonLd.telephone).toBe("+52-555-1234");
  });

  it("generates BreadcrumbList schema with positioned items", async () => {
    const result = await exec({
      schema_type: "BreadcrumbList",
      data: {
        items: [
          { name: "Home", url: "https://example.com/" },
          { name: "Blog", url: "https://example.com/blog/" },
          { name: "Article", url: "https://example.com/blog/article/" },
        ],
      },
    });
    expect(result.validation.valid).toBe(true);
    const jsonLd = JSON.parse(result.json_ld);
    expect(jsonLd.itemListElement).toHaveLength(3);
    expect(jsonLd.itemListElement[0].position).toBe(1);
    expect(jsonLd.itemListElement[2].name).toBe("Article");
  });

  it("returns validation warnings for missing required fields", async () => {
    const result = await exec({
      schema_type: "Article",
      data: { headline: "Missing author" }, // missing author + datePublished
    });
    expect(result.validation.valid).toBe(false);
    expect(result.validation.warnings.length).toBeGreaterThan(0);
    expect(
      result.validation.warnings.some((w: string) => w.includes("author")),
    ).toBe(true);
  });

  it("errors on invalid schema_type", async () => {
    const result = await exec({
      schema_type: "InvalidType",
      data: { foo: "bar" },
    });
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/Invalid schema_type/);
  });
});
