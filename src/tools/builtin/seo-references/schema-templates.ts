/**
 * JSON-LD schema markup templates — covers the 6 most common schema.org types
 * for SEO/GEO use cases.
 *
 * Adapted from nowork-studio/toprank schema-templates.md (MIT) and
 * pinned to Google's Rich Results examples.
 *
 * Output shape: { json_ld: string (serialized), validation: { valid, warnings } }
 */

export type SchemaType =
  | "Article"
  | "FAQPage"
  | "HowTo"
  | "Product"
  | "LocalBusiness"
  | "BreadcrumbList";

interface SchemaTemplateSpec {
  /** Required fields the caller MUST provide. */
  required: string[];
  /** Optional fields that enrich the output. */
  optional: string[];
  /** Returns the JSON-LD object given input data. */
  build: (data: Record<string, unknown>) => Record<string, unknown>;
}

export const SCHEMA_TEMPLATES: Record<SchemaType, SchemaTemplateSpec> = {
  Article: {
    required: ["headline", "author", "datePublished"],
    optional: ["image", "dateModified", "publisher", "description", "keywords"],
    build: (data) => {
      const obj: Record<string, unknown> = {
        "@context": "https://schema.org",
        "@type": "Article",
        headline: data.headline,
        author:
          typeof data.author === "string"
            ? { "@type": "Person", name: data.author }
            : data.author,
        datePublished: data.datePublished,
      };
      if (data.dateModified) obj.dateModified = data.dateModified;
      if (data.image) obj.image = data.image;
      if (data.description) obj.description = data.description;
      if (data.keywords) obj.keywords = data.keywords;
      if (data.publisher) {
        obj.publisher =
          typeof data.publisher === "string"
            ? { "@type": "Organization", name: data.publisher }
            : data.publisher;
      }
      return obj;
    },
  },

  FAQPage: {
    required: ["questions"],
    optional: [],
    build: (data) => {
      const questions = Array.isArray(data.questions) ? data.questions : [];
      return {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: questions.map((q: unknown) => {
          const entry = q as { question: string; answer: string };
          return {
            "@type": "Question",
            name: entry.question,
            acceptedAnswer: {
              "@type": "Answer",
              text: entry.answer,
            },
          };
        }),
      };
    },
  },

  HowTo: {
    required: ["name", "steps"],
    optional: [
      "description",
      "totalTime",
      "estimatedCost",
      "supply",
      "tool",
      "image",
    ],
    build: (data) => {
      const obj: Record<string, unknown> = {
        "@context": "https://schema.org",
        "@type": "HowTo",
        name: data.name,
        step: (Array.isArray(data.steps) ? data.steps : []).map(
          (step: unknown, idx: number) => {
            if (typeof step === "string") {
              return {
                "@type": "HowToStep",
                position: idx + 1,
                text: step,
              };
            }
            const s = step as { name?: string; text: string; image?: string };
            return {
              "@type": "HowToStep",
              position: idx + 1,
              name: s.name ?? `Step ${idx + 1}`,
              text: s.text,
              ...(s.image ? { image: s.image } : {}),
            };
          },
        ),
      };
      if (data.description) obj.description = data.description;
      if (data.totalTime) obj.totalTime = data.totalTime;
      if (data.estimatedCost) obj.estimatedCost = data.estimatedCost;
      if (data.supply) obj.supply = data.supply;
      if (data.tool) obj.tool = data.tool;
      if (data.image) obj.image = data.image;
      return obj;
    },
  },

  Product: {
    required: ["name", "description"],
    optional: ["image", "brand", "sku", "offers", "aggregateRating", "review"],
    build: (data) => {
      const obj: Record<string, unknown> = {
        "@context": "https://schema.org",
        "@type": "Product",
        name: data.name,
        description: data.description,
      };
      if (data.image) obj.image = data.image;
      if (data.sku) obj.sku = data.sku;
      if (data.brand) {
        obj.brand =
          typeof data.brand === "string"
            ? { "@type": "Brand", name: data.brand }
            : data.brand;
      }
      if (data.offers) {
        const offers = data.offers as {
          price?: number;
          priceCurrency?: string;
          availability?: string;
          url?: string;
        };
        obj.offers = {
          "@type": "Offer",
          price: offers.price,
          priceCurrency: offers.priceCurrency ?? "USD",
          availability: offers.availability ?? "https://schema.org/InStock",
          ...(offers.url ? { url: offers.url } : {}),
        };
      }
      if (data.aggregateRating) {
        const rating = data.aggregateRating as {
          ratingValue: number;
          reviewCount: number;
        };
        obj.aggregateRating = {
          "@type": "AggregateRating",
          ratingValue: rating.ratingValue,
          reviewCount: rating.reviewCount,
        };
      }
      return obj;
    },
  },

  LocalBusiness: {
    required: ["name", "address"],
    optional: [
      "telephone",
      "openingHours",
      "priceRange",
      "image",
      "url",
      "geo",
    ],
    build: (data) => {
      const obj: Record<string, unknown> = {
        "@context": "https://schema.org",
        "@type": "LocalBusiness",
        name: data.name,
      };
      // Address can be string or structured
      if (typeof data.address === "string") {
        obj.address = data.address;
      } else {
        const addr = data.address as {
          streetAddress?: string;
          addressLocality?: string;
          addressRegion?: string;
          postalCode?: string;
          addressCountry?: string;
        };
        obj.address = {
          "@type": "PostalAddress",
          ...addr,
        };
      }
      if (data.telephone) obj.telephone = data.telephone;
      if (data.openingHours) obj.openingHours = data.openingHours;
      if (data.priceRange) obj.priceRange = data.priceRange;
      if (data.image) obj.image = data.image;
      if (data.url) obj.url = data.url;
      if (data.geo) {
        const geo = data.geo as { latitude: number; longitude: number };
        obj.geo = {
          "@type": "GeoCoordinates",
          latitude: geo.latitude,
          longitude: geo.longitude,
        };
      }
      return obj;
    },
  },

  BreadcrumbList: {
    required: ["items"],
    optional: [],
    build: (data) => {
      const items = Array.isArray(data.items) ? data.items : [];
      return {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: items.map((item: unknown, idx: number) => {
          const entry = item as { name: string; url: string };
          return {
            "@type": "ListItem",
            position: idx + 1,
            name: entry.name,
            item: entry.url,
          };
        }),
      };
    },
  },
};

/** Validate required fields are present. Returns warning list. */
export function validateSchemaInput(
  schemaType: SchemaType,
  data: Record<string, unknown>,
): string[] {
  const warnings: string[] = [];
  const spec = SCHEMA_TEMPLATES[schemaType];
  if (!spec) {
    warnings.push(`Unknown schema type: ${schemaType}`);
    return warnings;
  }
  for (const field of spec.required) {
    const value = data[field];
    if (value === undefined || value === null) {
      warnings.push(`Missing required field: ${field}`);
      continue;
    }
    if (typeof value === "string" && value.trim() === "") {
      warnings.push(`Required field is empty: ${field}`);
    }
    if (Array.isArray(value) && value.length === 0) {
      warnings.push(`Required field array is empty: ${field}`);
    }
  }
  return warnings;
}

/** Build + serialize JSON-LD for a schema type. */
export function buildSchemaMarkup(
  schemaType: SchemaType,
  data: Record<string, unknown>,
): { json_ld: string; validation: { valid: boolean; warnings: string[] } } {
  const warnings = validateSchemaInput(schemaType, data);
  const spec = SCHEMA_TEMPLATES[schemaType];
  if (!spec) {
    return {
      json_ld: "",
      validation: { valid: false, warnings },
    };
  }
  const obj = spec.build(data);
  return {
    json_ld: JSON.stringify(obj, null, 2),
    validation: { valid: warnings.length === 0, warnings },
  };
}
