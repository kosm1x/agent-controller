/**
 * Ad copy frameworks — 6 classic direct-response templates.
 *
 * These are pedagogical prompt templates, not prescriptive outputs. The
 * `ads_creative_gen` tool passes the selected framework's template + the
 * brand brief + objective to the LLM, which fills in the blanks with
 * brand-voice-aware copy.
 *
 * Adopted from public direct-response literature (Eugene Schwartz,
 * Claude Hopkins, David Ogilvy, Drayton Bird). Frameworks themselves are
 * public domain; only the prompt templates are original.
 */

export type FrameworkId =
  | "AIDA"
  | "PAS"
  | "BAB"
  | "FAB"
  | "4P"
  | "Star-Story-Solution";

export interface CreativeFramework {
  id: FrameworkId;
  name: string;
  /** One-line description for tool output + operator documentation. */
  tagline: string;
  /** Canonical sections the framework produces. Used to structure LLM output. */
  sections: string[];
  /** When this framework is the right choice. */
  best_for: string[];
  /**
   * LLM-facing prompt template. `{{BRAND}}`, `{{OBJECTIVE}}`, `{{PLATFORM}}`,
   * `{{OFFER}}`, `{{AUDIENCE}}` placeholders are substituted at call time.
   * Kept as plain text — the tool concatenates it into the system prompt.
   */
  prompt_template: string;
}

export const CREATIVE_FRAMEWORKS: Record<FrameworkId, CreativeFramework> = {
  AIDA: {
    id: "AIDA",
    name: "AIDA — Attention / Interest / Desire / Action",
    tagline:
      "Classic 4-step funnel: hook attention, build interest, deepen desire, drive action.",
    sections: ["attention", "interest", "desire", "action"],
    best_for: [
      "Cold audiences seeing the brand for the first time",
      "Search ads where the query is the attention trigger",
      "Long-form landing page heroes",
    ],
    prompt_template: `Write ad copy using AIDA (Attention / Interest / Desire / Action).
Brand: {{BRAND}}
Audience: {{AUDIENCE}}
Objective: {{OBJECTIVE}}
Platform: {{PLATFORM}}
Offer: {{OFFER}}

Produce 4 distinct sections — one sentence each, in the brand's voice:
1. ATTENTION: a hook that stops the scroll. Use specificity, a number, or a contrarian claim.
2. INTEREST: one benefit that speaks to this audience's stated problem.
3. DESIRE: social proof or a vivid outcome picture (not a feature list).
4. ACTION: a direct CTA — verb + object + urgency.

Also produce one assembled 30-word ad body combining all four, plus a 6-word headline and a 3-word CTA button.`,
  },
  PAS: {
    id: "PAS",
    name: "PAS — Problem / Agitate / Solution",
    tagline: "Surface the pain, sharpen it, then relieve it with the product.",
    sections: ["problem", "agitate", "solution"],
    best_for: [
      "Pain-aware audiences that already know they have the problem",
      "Retargeting campaigns that can skip awareness-building",
      "Direct-response posts (Meta feed, LinkedIn sponsored)",
    ],
    prompt_template: `Write ad copy using PAS (Problem / Agitate / Solution).
Brand: {{BRAND}}
Audience: {{AUDIENCE}}
Objective: {{OBJECTIVE}}
Platform: {{PLATFORM}}
Offer: {{OFFER}}

Produce 3 sections in the brand's voice — do NOT caricature the pain; make it feel true:
1. PROBLEM: a one-sentence description of the concrete pain the audience feels.
2. AGITATE: why it gets worse if unsolved — one specific consequence, no hyperbole.
3. SOLUTION: how the offer removes it. Lead with mechanism, not feature list.

Assembled ad body (25-35 words) + headline (5-7 words) + CTA (2-3 words).`,
  },
  BAB: {
    id: "BAB",
    name: "BAB — Before / After / Bridge",
    tagline:
      "Paint life before the product, life after, and the product as the bridge.",
    sections: ["before", "after", "bridge"],
    best_for: [
      "Transformation-based products (fitness, SaaS, education)",
      "Audiences that need to see a tangible 'after'",
      "Video ads with a clear first/second-act structure",
    ],
    prompt_template: `Write ad copy using BAB (Before / After / Bridge).
Brand: {{BRAND}}
Audience: {{AUDIENCE}}
Objective: {{OBJECTIVE}}
Platform: {{PLATFORM}}
Offer: {{OFFER}}

Produce 3 vivid sections in the brand's voice — concrete details beat abstraction:
1. BEFORE: one sentence, present tense, describing the audience's current state.
2. AFTER: one sentence, future tense, showing the outcome they would have with the product.
3. BRIDGE: one sentence naming the product and the mechanism that gets them from BEFORE to AFTER.

Assembled body (25-35 words) + headline (5-7 words) + CTA.`,
  },
  FAB: {
    id: "FAB",
    name: "FAB — Feature / Advantage / Benefit",
    tagline:
      "Translate a product feature into a customer benefit with the intermediate advantage.",
    sections: ["feature", "advantage", "benefit"],
    best_for: [
      "B2B / SaaS with differentiated feature sets",
      "Technical audiences who need the mechanism before the benefit",
      "Product comparison ads",
    ],
    prompt_template: `Write ad copy using FAB (Feature / Advantage / Benefit).
Brand: {{BRAND}}
Audience: {{AUDIENCE}}
Objective: {{OBJECTIVE}}
Platform: {{PLATFORM}}
Offer: {{OFFER}}

Pick ONE standout feature of the offer and produce:
1. FEATURE: literal product capability, stated neutrally.
2. ADVANTAGE: why this feature is better than the alternative — concrete comparison.
3. BENEFIT: what the customer gets in their own life because of the advantage.

Assembled body (25-35 words) + headline (5-7 words) + CTA.`,
  },
  "4P": {
    id: "4P",
    name: "4P — Picture / Promise / Prove / Push",
    tagline: "Paint a picture, make a promise, prove it, push for action.",
    sections: ["picture", "promise", "prove", "push"],
    best_for: [
      "High-ticket offers needing proof",
      "Storytelling-friendly platforms (Meta, YouTube pre-roll)",
      "Retargeting with social proof",
    ],
    prompt_template: `Write ad copy using 4P (Picture / Promise / Prove / Push).
Brand: {{BRAND}}
Audience: {{AUDIENCE}}
Objective: {{OBJECTIVE}}
Platform: {{PLATFORM}}
Offer: {{OFFER}}

Produce 4 short sections in the brand's voice:
1. PICTURE: vivid scene-setter (1 sentence) describing the desired outcome.
2. PROMISE: the offer's explicit promise (1 sentence).
3. PROVE: one piece of social proof — testimonial, number, or credential.
4. PUSH: a direct CTA with urgency.

Assembled body (25-35 words) + headline (5-7 words) + CTA.`,
  },
  "Star-Story-Solution": {
    id: "Star-Story-Solution",
    name: "Star-Story-Solution — Ben Hart's emotional narrative structure",
    tagline:
      "Introduce a protagonist, tell their story, arrive at the product as the solution.",
    sections: ["star", "story", "solution"],
    best_for: [
      "Video ads (15-60s)",
      "Storytelling campaigns on Meta / TikTok",
      "Brand-building where direct selling would feel pushy",
    ],
    prompt_template: `Write ad copy using Star-Story-Solution (narrative arc).
Brand: {{BRAND}}
Audience: {{AUDIENCE}}
Objective: {{OBJECTIVE}}
Platform: {{PLATFORM}}
Offer: {{OFFER}}

Produce 3 narrative beats in the brand's voice:
1. STAR: introduce the protagonist — a named or archetypal customer in 1 sentence.
2. STORY: 2 sentences of what they faced before finding the offer. Stakes, not lecture.
3. SOLUTION: 1 sentence on how the offer resolved it — specific result.

Assembled body (35-50 words) + headline (5-7 words) + CTA.`,
  },
};

export const ALL_FRAMEWORK_IDS: FrameworkId[] = Object.keys(
  CREATIVE_FRAMEWORKS,
) as FrameworkId[];

/**
 * Render a framework's LLM prompt with brief values substituted.
 *
 * Round-1 audit M3: `replace(regex, string)` / `replaceAll(string, string)`
 * both interpret `$&`, `` $` ``, `$'`, `$1..$9`. A function-replacer is
 * the only form safe for substrings containing `$` (prices: "$49/mo").
 *
 * Round-2 audit C1: chained `.replaceAll` calls were also vulnerable to
 * placeholder-laundering — hostile page gets LLM to emit
 * `brand: "Acme_{{AUDIENCE}}"` and the SECOND replaceAll rewrites that
 * substitution verbatim. SINGLE-PASS substitution with one regex pass
 * closes this: each `{{KEY}}` is replaced exactly once and the replaced
 * content is never re-scanned.
 */
export function renderFrameworkPrompt(
  id: FrameworkId,
  brief: {
    brand: string;
    audience: string;
    objective: string;
    platform: string;
    offer: string;
  },
): string {
  const fw = CREATIVE_FRAMEWORKS[id];
  if (!fw) throw new Error(`Unknown framework: ${id}`);
  const lookup: Record<string, string> = {
    BRAND: brief.brand,
    AUDIENCE: brief.audience,
    OBJECTIVE: brief.objective,
    PLATFORM: brief.platform,
    OFFER: brief.offer,
  };
  return fw.prompt_template.replace(
    /\{\{(BRAND|AUDIENCE|OBJECTIVE|PLATFORM|OFFER)\}\}/g,
    (_match, key: string) => lookup[key] ?? "",
  );
}
