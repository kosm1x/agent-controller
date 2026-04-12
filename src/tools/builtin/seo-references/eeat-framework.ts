/**
 * E-E-A-T framework — Google's content quality rubric adapted for content briefs.
 *
 * Experience: first-hand / direct experience with the topic
 * Expertise: formal knowledge, credentials
 * Authoritativeness: recognized authority in the field
 * Trustworthiness: accurate, transparent, safe
 *
 * Adapted from nowork-studio/toprank content-writing.md + content-quality-framework.md (MIT).
 */

export interface EeatSignal {
  category:
    | "experience"
    | "expertise"
    | "authoritativeness"
    | "trustworthiness";
  signal: string;
  /** When to include this signal. */
  use_when: string;
}

/** Signals to include in content, by category. */
export const EEAT_SIGNALS: EeatSignal[] = [
  // Experience
  {
    category: "experience",
    signal: "First-person narrative of using the product/service",
    use_when: "Reviews, case studies, tutorials",
  },
  {
    category: "experience",
    signal: "Original photos or screenshots (not stock imagery)",
    use_when: "Any content where authenticity matters",
  },
  {
    category: "experience",
    signal: "Specific details: dates, numbers, real outcomes",
    use_when: "Case studies, results pages, testimonials",
  },
  {
    category: "experience",
    signal: "'Here's what happened when I...' framing",
    use_when: "Personal experience-driven content",
  },

  // Expertise
  {
    category: "expertise",
    signal: "Author bio with credentials and relevant background",
    use_when: "All published content (YMYL topics especially)",
  },
  {
    category: "expertise",
    signal: "Technical depth appropriate to audience (jargon used correctly)",
    use_when: "Expert-level content, B2B",
  },
  {
    category: "expertise",
    signal: "References to primary research or original data",
    use_when: "Analytical pieces, industry reports",
  },

  // Authoritativeness
  {
    category: "authoritativeness",
    signal:
      "Links to authoritative external sources (.gov, .edu, peer-reviewed)",
    use_when: "Informational and research content",
  },
  {
    category: "authoritativeness",
    signal: "Cited by or linked from reputable domains",
    use_when: "Long-term content strategy",
  },
  {
    category: "authoritativeness",
    signal: "Author is quoted/referenced elsewhere in the industry",
    use_when: "Thought leadership",
  },

  // Trustworthiness
  {
    category: "trustworthiness",
    signal: "Publication date and last-updated date visible",
    use_when: "All time-sensitive content",
  },
  {
    category: "trustworthiness",
    signal: "Transparent about affiliate links / sponsored content",
    use_when: "Commerce and review content",
  },
  {
    category: "trustworthiness",
    signal: "Contact info and company details easily accessible",
    use_when: "Any page on a commercial site",
  },
  {
    category: "trustworthiness",
    signal: "HTTPS, no intrusive ads, no deceptive popups",
    use_when: "Technical baseline",
  },
  {
    category: "trustworthiness",
    signal: "Factual accuracy — numbers and claims sourced",
    use_when: "YMYL topics (health, finance, legal)",
  },
];

/** Target word counts by intent and content type. */
export const WORD_COUNT_TARGETS = {
  informational: {
    short: [400, 800],
    medium: [800, 1500],
    long: [1500, 3000],
    pillar: [3000, 6000],
  },
  commercial: {
    short: [600, 1000],
    medium: [1000, 2000],
    long: [2000, 4000],
  },
  transactional: {
    short: [200, 500],
    medium: [500, 1000],
  },
  navigational: {
    short: [150, 400],
  },
} as const;

/** Content format templates — outline scaffolds by content type. */
export const CONTENT_OUTLINES = {
  how_to: [
    "Intro: what the reader will accomplish + time estimate",
    "Prerequisites: what they need before starting",
    "Steps 1-N: numbered, each with a clear outcome",
    "Troubleshooting: common mistakes and fixes",
    "Next steps: related content",
    "FAQ (GEO-friendly)",
  ],
  comparison: [
    "Intro: why this comparison matters",
    "At-a-glance table (GEO-friendly)",
    "Option A: pros, cons, best for",
    "Option B: pros, cons, best for",
    "Head-to-head on key dimensions",
    "Verdict: which to pick by use case",
    "FAQ",
  ],
  review: [
    "Intro: who this is for + verdict in one line",
    "What it is / key features",
    "Hands-on experience (E-E-A-T experience signal)",
    "Pros / Cons",
    "Pricing and value",
    "Alternatives",
    "Final verdict + rating",
  ],
  pillar: [
    "Intro: scope of the topic",
    "Core concept explained (definitional — GEO)",
    "Subsection 1: major pillar",
    "Subsection 2: major pillar",
    "Subsection 3: major pillar",
    "Examples / case studies",
    "Common questions (FAQ — GEO)",
    "Related reading (internal links)",
  ],
  landing: [
    "Headline: clear value proposition",
    "Subheadline: elaboration + audience",
    "Social proof (logos, numbers)",
    "Key benefits (3-5 bullets)",
    "How it works",
    "Feature detail",
    "CTA",
  ],
} as const;

/**
 * Suggest E-E-A-T signals appropriate for a content type + intent.
 * Used by seo_content_brief to produce contextual recommendations.
 */
export function suggestEeatSignals(
  contentType: string,
  intent: string,
): EeatSignal[] {
  // Default: trustworthiness baseline for every piece
  const required: EeatSignal[] = EEAT_SIGNALS.filter(
    (s) =>
      s.category === "trustworthiness" &&
      (s.signal.includes("Publication date") || s.signal.includes("HTTPS")),
  );

  // Content-type-specific additions
  if (["review", "case_study", "how_to", "tutorial"].includes(contentType)) {
    required.push(...EEAT_SIGNALS.filter((s) => s.category === "experience"));
  }
  if (["pillar", "research", "analysis", "how_to"].includes(contentType)) {
    required.push(...EEAT_SIGNALS.filter((s) => s.category === "expertise"));
  }
  if (intent === "informational" || contentType === "pillar") {
    required.push(
      ...EEAT_SIGNALS.filter((s) => s.category === "authoritativeness"),
    );
  }

  // Dedupe
  const seen = new Set<string>();
  return required.filter((s) => {
    if (seen.has(s.signal)) return false;
    seen.add(s.signal);
    return true;
  });
}
