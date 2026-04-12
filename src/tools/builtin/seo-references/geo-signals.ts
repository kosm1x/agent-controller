/**
 * GEO (Generative Engine Optimization) signals — patterns that predict
 * whether a keyword will trigger AI overview / generative answer responses.
 *
 * Adapted from nowork-studio/toprank keyword-research skill (MIT).
 *
 * AI overviews (Google SGE, Bing Chat answers, Perplexity) tend to appear for
 * queries that are:
 * - Question-formatted (what/how/why)
 * - Definitional ("X meaning")
 * - Comparative ("A vs B")
 * - List-style ("best X")
 * - Procedural ("how to X")
 *
 * They rarely appear for navigational or transactional queries.
 */

export interface GeoMatch {
  /** Pattern that fired. */
  pattern: string;
  /** How strong the signal is (1-3). */
  weight: number;
  /** Which GEO pattern family. */
  family: "question" | "definition" | "comparison" | "list" | "howto";
}

interface GeoSignal {
  family: GeoMatch["family"];
  pattern: RegExp;
  weight: number;
}

/** Patterns ordered by strength within each family. */
export const GEO_SIGNALS: GeoSignal[] = [
  // Question format (strong AI overview trigger)
  {
    family: "question",
    pattern: /\b(what is|what are|qu[eé] es|qu[eé] son)\b/i,
    weight: 3,
  },
  {
    family: "question",
    pattern: /\b(how does|how do|c[oó]mo funciona|c[oó]mo funcionan)\b/i,
    weight: 3,
  },
  {
    family: "question",
    pattern: /\b(why is|why are|por qu[eé])\b/i,
    weight: 3,
  },
  {
    family: "question",
    pattern: /\b(when|where|who|cu[aá]ndo|d[oó]nde|qui[eé]n)\b/i,
    weight: 2,
  },

  // Definitional (very strong — AI overviews love definitions)
  {
    family: "definition",
    pattern:
      /\b(meaning|definition|explained|definido|significado|definici[oó]n)\b/i,
    weight: 3,
  },
  {
    family: "definition",
    pattern: /\b(what does .* mean|qu[eé] significa)\b/i,
    weight: 3,
  },

  // Comparison (AI overviews now surface side-by-side tables)
  { family: "comparison", pattern: /\b(vs\.?|versus)\b/i, weight: 3 },
  {
    family: "comparison",
    pattern: /\b(difference between|diferencia entre)\b/i,
    weight: 3,
  },
  {
    family: "comparison",
    pattern: /\b(compared to|comparison|comparaci[oó]n|comparado con)\b/i,
    weight: 2,
  },
  {
    family: "comparison",
    pattern: /\b(alternatives? to|alternativas? a)\b/i,
    weight: 2,
  },

  // List / top-N queries
  {
    family: "list",
    pattern: /\b(best|top\s+\d+|greatest|mejor(?:es)?|top)\b/i,
    weight: 2,
  },
  { family: "list", pattern: /\b(list of|lista de)\b/i, weight: 2 },
  { family: "list", pattern: /\b(examples? of|ejemplos? de)\b/i, weight: 2 },

  // How-to / procedural
  { family: "howto", pattern: /\b(how to|c[oó]mo)\b/i, weight: 3 },
  { family: "howto", pattern: /\b(steps? to|pasos? para)\b/i, weight: 3 },
  {
    family: "howto",
    pattern: /\b(guide to|gu[ií]a (?:de|para))\b/i,
    weight: 2,
  },
  { family: "howto", pattern: /\b(tutorial)\b/i, weight: 2 },
];

/**
 * Score a keyword for GEO (AI overview) potential.
 * Returns a 0-100 score and which signal families matched.
 */
export function scoreGeoPotential(keyword: string): {
  score: number;
  matches: GeoMatch[];
  families: Array<GeoMatch["family"]>;
} {
  const matches: GeoMatch[] = [];
  const familiesSet = new Set<GeoMatch["family"]>();
  let totalWeight = 0;

  for (const signal of GEO_SIGNALS) {
    if (signal.pattern.test(keyword)) {
      matches.push({
        pattern: signal.pattern.source,
        weight: signal.weight,
        family: signal.family,
      });
      familiesSet.add(signal.family);
      totalWeight += signal.weight;
    }
  }

  // Score: base weight + 10-point bonus per additional family (diversity matters)
  const familyBonus = Math.max(0, familiesSet.size - 1) * 10;
  const score = Math.min(totalWeight * 12 + familyBonus, 100);

  return {
    score,
    matches,
    families: Array.from(familiesSet),
  };
}

/**
 * Batch check — returns only keywords with GEO score above threshold.
 */
export function filterGeoCandidates(
  keywords: string[],
  minScore = 30,
): Array<{
  keyword: string;
  score: number;
  families: Array<GeoMatch["family"]>;
}> {
  return keywords
    .map((keyword) => {
      const result = scoreGeoPotential(keyword);
      return {
        keyword,
        score: result.score,
        families: result.families,
      };
    })
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score);
}

/** GEO optimization tactics returned in content briefs. */
export const GEO_TACTICS = [
  "Lead with a 2-3 sentence definition for definitional queries",
  "Use numbered or bulleted lists for procedural and list queries",
  "Structure comparison content with side-by-side tables (HTML <table>)",
  "Include FAQ section with question-formatted headers (H2/H3)",
  "Add FAQPage or HowTo JSON-LD schema markup",
  "Keep key answers concise (40-60 words) and above the fold",
  "Cite primary sources with inline links — AI overviews surface well-cited content",
  "Use semantic HTML (article, section, h1-h3) — helps model extraction",
  "Include statistics and specific numbers where possible",
  "Target one primary question per page — avoid diluted content",
] as const;
