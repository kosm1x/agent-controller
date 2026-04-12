/**
 * Meta tag formulas — title / meta description / OG / Twitter card templates
 * by content type, with CTR-optimization patterns.
 *
 * Adapted from nowork-studio/toprank meta-tag-formulas.md (MIT).
 *
 * Character limits (Google SERP):
 * - Title: 50-60 chars (truncates at ~580px desktop, varies mobile)
 * - Meta description: 120-155 chars (desktop); 120 for mobile safety
 * - OG title: 60 chars recommended
 * - OG description: 155-200 chars
 * - Twitter card title: 70 chars; description: 200 chars
 */

export const CHAR_LIMITS = {
  title: { min: 30, max: 60 },
  description: { min: 120, max: 155 },
  og_title: { min: 30, max: 60 },
  og_description: { min: 120, max: 200 },
  twitter_title: { min: 30, max: 70 },
  twitter_description: { min: 120, max: 200 },
} as const;

export type ContentType =
  | "article"
  | "product"
  | "category"
  | "landing"
  | "homepage"
  | "how_to"
  | "comparison"
  | "review"
  | "local_business";

interface MetaFormula {
  /** Title templates (placeholders: {keyword}, {brand}, {benefit}, {year}, {number}). */
  titles: string[];
  /** Meta description templates. */
  descriptions: string[];
  /** When this content type is appropriate. */
  use_when: string;
}

/** Formulas by content type. Templates use {placeholder} syntax. */
export const META_FORMULAS: Record<ContentType, MetaFormula> = {
  article: {
    titles: [
      "{keyword}: {benefit} ({year}) | {brand}",
      "{keyword} — Complete Guide | {brand}",
      "{number} {keyword} Tips That Actually Work",
      "The Ultimate Guide to {keyword}",
    ],
    descriptions: [
      "Learn {keyword} with our step-by-step guide. Includes {specific_detail}, real examples, and actionable tips. Updated for {year}.",
      "Everything you need to know about {keyword}: {benefit_1}, {benefit_2}, and {benefit_3}. Written by {author_or_brand}.",
      "Discover how {keyword} works and how to apply it. {number} proven strategies from {brand} experts.",
    ],
    use_when: "Blog posts, educational content, evergreen guides",
  },
  product: {
    titles: [
      "{product_name} — {key_feature} | {brand}",
      "{product_name} | {benefit} — Shop Now",
      "Buy {product_name}: {differentiator} | {brand}",
    ],
    descriptions: [
      "{product_name}: {top_feature}, {benefit}. Free shipping on orders over $X. Shop {brand}'s {category} collection.",
      "Get {product_name} — {key_differentiator}. {social_proof}. Free returns, 30-day guarantee.",
    ],
    use_when: "E-commerce product pages, SaaS pricing pages",
  },
  category: {
    titles: [
      "{category_name} — {count}+ Products | {brand}",
      "Shop {category_name}: {price_range} | {brand}",
      "{category_name} for {audience} | {brand}",
    ],
    descriptions: [
      "Browse our collection of {count}+ {category_name}. {filter_highlight}. Free shipping, 30-day returns.",
      "Find the best {category_name} for {use_case}. Filtered by {filter_dimensions}. Prices from $X.",
    ],
    use_when: "E-commerce category/collection pages",
  },
  landing: {
    titles: [
      "{value_proposition} | {brand}",
      "{brand} — {one_liner_benefit}",
      "{action_verb} {object}: {differentiator} | {brand}",
    ],
    descriptions: [
      "{brand} helps {audience} {primary_benefit}. {social_proof_or_stat}. Start free / Get a demo / Learn more.",
      "{value_proposition}. Trusted by {customer_count}+ {customer_type}. {cta}.",
    ],
    use_when: "Homepage alternatives, paid traffic landing pages",
  },
  homepage: {
    titles: [
      "{brand} — {one_line_description}",
      "{brand}: {primary_value_prop}",
    ],
    descriptions: [
      "{brand} is {what_we_do} for {audience}. {differentiator}. {cta}.",
    ],
    use_when: "Root domain / homepage only",
  },
  how_to: {
    titles: [
      "How to {action} in {number} Steps ({year})",
      "How to {action}: {qualifier} Guide",
      "{action} Tutorial — {time_estimate} Walkthrough",
    ],
    descriptions: [
      "Step-by-step guide to {action}. Follow our {number}-step tutorial with screenshots and examples. Takes {time_estimate}.",
      "Learn how to {action} in {time_estimate}. No {common_prereq} required. Includes {bonus_content}.",
    ],
    use_when: "Tutorials, procedural content — strong GEO signal",
  },
  comparison: {
    titles: [
      "{option_a} vs {option_b}: Which Is Better in {year}?",
      "{option_a} vs {option_b}: {dimension} Comparison",
      "Best {category}: {option_a} vs {option_b} vs {option_c}",
    ],
    descriptions: [
      "{option_a} vs {option_b}: compare pricing, features, and performance. See which wins for {use_case} in {year}.",
      "Detailed {option_a} vs {option_b} comparison: {dimension_1}, {dimension_2}, {dimension_3}. Pick the right one for you.",
    ],
    use_when: "Versus pages, buying guides — strong GEO signal",
  },
  review: {
    titles: [
      "{product} Review ({year}): {verdict}",
      "Is {product} Worth It? Honest Review | {brand}",
      "{product} Review: {pros_summary}",
    ],
    descriptions: [
      "Honest {product} review: what works, what doesn't, who it's for. Based on {duration} of hands-on use. {star_rating}/5.",
      "After {duration} with {product}, here's my verdict. Pros: {pros}. Cons: {cons}. Worth it? Read more.",
    ],
    use_when: "Product reviews, case studies",
  },
  local_business: {
    titles: [
      "{business_name} — {service} in {city}",
      "{service} in {city} | {business_name}",
      "Best {service} {city} — {business_name}",
    ],
    descriptions: [
      "{business_name} offers {service} in {city}. {hours}, {phone}. {differentiator}. Call or book online.",
      "Looking for {service} in {city}? {business_name} has served {customer_count}+ customers since {year}. {cta}.",
    ],
    use_when: "Local business pages, Google Business Profile landing pages",
  },
} as const;

/**
 * Validate generated title/description against character limits.
 * Returns a list of warnings (empty = all good).
 */
export function validateMeta(meta: {
  title?: string;
  description?: string;
  og_title?: string;
  og_description?: string;
  twitter_title?: string;
  twitter_description?: string;
}): string[] {
  const warnings: string[] = [];
  for (const [field, value] of Object.entries(meta)) {
    if (typeof value !== "string") continue;
    const limits = CHAR_LIMITS[field as keyof typeof CHAR_LIMITS];
    if (!limits) continue;
    if (value.length < limits.min) {
      warnings.push(`${field} is too short (${value.length} < ${limits.min})`);
    }
    if (value.length > limits.max) {
      warnings.push(`${field} exceeds max (${value.length} > ${limits.max})`);
    }
  }
  return warnings;
}

/** Get the formula bundle for a content type (with safe default). */
export function getFormula(contentType: ContentType): MetaFormula {
  return META_FORMULAS[contentType] ?? META_FORMULAS.article;
}
