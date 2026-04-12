/**
 * seo_keyword_research — Seed → keyword ideas with intent + GEO classification.
 *
 * Flow: for each seed keyword, call web_search to get SERP titles, then
 * ask the LLM to extract related keyword candidates from those titles,
 * then classify each candidate by intent (rules-based), flag GEO-relevant
 * ones (rules-based), and cluster by shared tokens.
 *
 * Zero paid APIs — leverages existing web_search (Brave) + LLM.
 *
 * Part of v7.3 Phase 1 SEO/GEO tool suite.
 */

import type { Tool } from "../types.js";
import { infer } from "../../inference/adapter.js";
import { webSearchTool } from "./web-search.js";
import {
  classifyIntent,
  type SearchIntent,
} from "./seo-references/intent-taxonomy.js";
import { scoreGeoPotential } from "./seo-references/geo-signals.js";

const MAX_SEEDS = 10;
const MAX_KEYWORDS_DEFAULT = 30;
const MAX_KEYWORDS_HARD_CAP = 60;
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "in",
  "on",
  "for",
  "to",
  "and",
  "or",
  "el",
  "la",
  "los",
  "las",
  "de",
  "del",
  "en",
  "para",
  "por",
  "con",
  "y",
  "o",
]);

interface EnrichedKeyword {
  term: string;
  intent: SearchIntent;
  intent_confidence: number;
  geo_score: number;
  geo_families: string[];
  cluster: string;
}

interface Cluster {
  name: string;
  keywords: string[];
}

/** Tokenize a keyword into meaningful lowercase words. */
function tokenize(keyword: string): string[] {
  return keyword
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/** Jaccard similarity between two token sets. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Cluster keywords greedily by shared tokens (simple Jaccard ≥ 0.25).
 * Returns cluster assignments plus a name (most common token).
 */
function clusterKeywords(keywords: string[]): {
  assignments: Map<string, string>;
  clusters: Cluster[];
} {
  const assignments = new Map<string, string>();
  const clusters: Array<{
    name: string;
    tokens: Set<string>;
    keywords: string[];
  }> = [];

  for (const keyword of keywords) {
    const tokens = new Set(tokenize(keyword));
    if (tokens.size === 0) {
      assignments.set(keyword, "misc");
      continue;
    }

    // Find best matching cluster
    let bestIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < clusters.length; i++) {
      const score = jaccard(tokens, clusters[i].tokens);
      if (score > bestScore && score >= 0.25) {
        bestScore = score;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) {
      // New cluster
      const name = Array.from(tokens)[0] ?? "misc";
      clusters.push({ name, tokens: new Set(tokens), keywords: [keyword] });
      assignments.set(keyword, name);
    } else {
      // Merge tokens and add keyword
      const cluster = clusters[bestIdx];
      for (const t of tokens) cluster.tokens.add(t);
      cluster.keywords.push(keyword);
      assignments.set(keyword, cluster.name);
    }
  }

  return {
    assignments,
    clusters: clusters.map((c) => ({ name: c.name, keywords: c.keywords })),
  };
}

/**
 * Extract candidate keywords from a pool of SERP titles via a single LLM call.
 */
async function extractCandidates(
  seeds: string[],
  serpTitles: string[],
  industry: string | undefined,
  audience: string | undefined,
  maxKeywords: number,
): Promise<string[]> {
  if (serpTitles.length === 0) return [];

  const prompt = [
    `You are an SEO keyword extractor.`,
    `Given seed keywords and a pool of SERP titles, produce a deduplicated list`,
    `of ${maxKeywords} related keyword candidates that would be good to target.`,
    ``,
    `SEEDS: ${seeds.join(", ")}`,
    industry ? `INDUSTRY: ${industry}` : "",
    audience ? `TARGET AUDIENCE: ${audience}` : "",
    ``,
    `SERP TITLES:`,
    ...serpTitles.slice(0, 60).map((t, i) => `${i + 1}. ${t}`),
    ``,
    `Rules:`,
    `- Produce 20-${maxKeywords} distinct keyword phrases`,
    `- Mix informational, commercial, and transactional intent`,
    `- Include question-format and "how to" variations (strong for AI overviews)`,
    `- Each keyword should be 2-6 words`,
    `- Return ONLY valid JSON in this shape (no prose): {"keywords": ["...", "..."]}`,
  ]
    .filter(Boolean)
    .join("\n");

  const response = await infer({
    messages: [
      {
        role: "system",
        content:
          "You are a precise SEO keyword extractor. Always return valid JSON matching the requested schema.",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.6,
    max_tokens: 1500,
  });

  const text = (response.content ?? "").trim();
  const jsonMatch =
    text.match(/```json\s*([\s\S]*?)\s*```/)?.[1] ??
    text.match(/\{[\s\S]*\}/)?.[0] ??
    text;

  try {
    const parsed = JSON.parse(jsonMatch) as { keywords?: unknown };
    if (!Array.isArray(parsed.keywords)) return [];
    return parsed.keywords
      .filter((k): k is string => typeof k === "string" && k.trim().length > 0)
      .map((k) => k.trim())
      .slice(0, maxKeywords);
  } catch {
    return [];
  }
}

export const seoKeywordResearchTool: Tool = {
  name: "seo_keyword_research",
  deferred: true,
  riskTier: "low",
  triggerPhrases: [
    "keyword research",
    "investigación de keywords",
    "busca palabras clave",
    "ideas de keywords",
    "keywords para",
    "intent classification",
    "geo keywords",
  ],
  definition: {
    type: "function",
    function: {
      name: "seo_keyword_research",
      description: `Discover SEO keywords from seed terms. Pulls SERP titles via web_search, extracts candidates via LLM, classifies intent, flags GEO (AI overview) potential, and clusters into topics.

USE WHEN:
- User wants keyword ideas from a topic or seed terms
- Building a content strategy for a new niche
- Identifying AI-overview-friendly keywords (GEO candidates)
- Grouping keywords into content clusters

DO NOT USE WHEN:
- User wants search volume/competition metrics (Phase 2 — requires paid API)
- User wants to track rankings (Phase 2 — requires GSC)
- Need to audit a specific URL's keywords (use seo_page_audit)

OUTPUT:
- keywords: list of candidates with intent, GEO score, and cluster assignment
- clusters: topical groupings with member keywords
- geo_candidates: keywords most likely to trigger AI overviews
- intent_breakdown: counts by informational/navigational/commercial/transactional

Intent classification is deterministic (rules-based regex). GEO scoring rewards question formats, definitions, comparisons, lists, and how-to queries. Clustering uses simple Jaccard similarity on tokens.`,
      parameters: {
        type: "object",
        properties: {
          seed_keywords: {
            type: "array",
            items: { type: "string" },
            description: `Seed keywords to expand from (1-${MAX_SEEDS}). Each seed triggers a web_search for SERP titles.`,
          },
          industry: {
            type: "string",
            description:
              "Optional industry context to guide keyword extraction (e.g., 'healthcare SaaS', 'local restaurant').",
          },
          target_audience: {
            type: "string",
            description:
              "Optional audience description (e.g., 'small business owners', 'clinical researchers').",
          },
          max_keywords: {
            type: "number",
            description: `Target number of keywords to return (10-${MAX_KEYWORDS_HARD_CAP}, default ${MAX_KEYWORDS_DEFAULT}).`,
          },
        },
        required: ["seed_keywords"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const rawSeeds = args.seed_keywords;
    if (!Array.isArray(rawSeeds) || rawSeeds.length === 0) {
      return JSON.stringify({
        error: "seed_keywords is required (non-empty array of strings)",
      });
    }
    const seeds = rawSeeds
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .map((s) => s.trim())
      .slice(0, MAX_SEEDS);
    if (seeds.length === 0) {
      return JSON.stringify({
        error: "seed_keywords must contain at least one non-empty string",
      });
    }

    const industry = args.industry as string | undefined;
    const audience = args.target_audience as string | undefined;
    const maxKeywords = Math.min(
      Math.max((args.max_keywords as number) ?? MAX_KEYWORDS_DEFAULT, 10),
      MAX_KEYWORDS_HARD_CAP,
    );

    // 1. Gather SERP titles for each seed
    const serpTitles: string[] = [];
    for (const seed of seeds) {
      try {
        const raw = await webSearchTool.execute({ query: seed, count: 8 });
        const parsed = JSON.parse(raw) as {
          results?: Array<{ title?: string }>;
          error?: string;
        };
        if (parsed.error) continue;
        for (const result of parsed.results ?? []) {
          if (result.title) serpTitles.push(result.title);
        }
      } catch {
        // Skip failed seeds — partial results are still useful
      }
    }

    // 2. Extract candidates via single LLM call
    let candidates: string[] = [];
    try {
      candidates = await extractCandidates(
        seeds,
        serpTitles,
        industry,
        audience,
        maxKeywords,
      );
    } catch (err) {
      return JSON.stringify({
        error: `LLM candidate extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Fallback: if LLM returned nothing, use SERP titles directly
    if (candidates.length === 0 && serpTitles.length > 0) {
      candidates = serpTitles.slice(0, maxKeywords);
    }

    if (candidates.length === 0) {
      return JSON.stringify({
        error: "No keyword candidates generated (SERP empty and LLM failed)",
        seeds,
      });
    }

    // Dedupe (case-insensitive)
    const dedupeSet = new Set<string>();
    const deduped: string[] = [];
    for (const c of candidates) {
      const key = c.toLowerCase();
      if (!dedupeSet.has(key)) {
        dedupeSet.add(key);
        deduped.push(c);
      }
    }

    // 3. Cluster
    const { assignments, clusters } = clusterKeywords(deduped);

    // 4. Classify intent + GEO for each
    const enriched: EnrichedKeyword[] = deduped.map((term) => {
      const intentResult = classifyIntent(term);
      const geoResult = scoreGeoPotential(term);
      return {
        term,
        intent: intentResult.intent,
        intent_confidence: intentResult.confidence,
        geo_score: geoResult.score,
        geo_families: geoResult.families,
        cluster: assignments.get(term) ?? "misc",
      };
    });

    // 5. Intent breakdown
    const intentBreakdown: Record<SearchIntent, number> = {
      informational: 0,
      navigational: 0,
      commercial: 0,
      transactional: 0,
    };
    for (const k of enriched) intentBreakdown[k.intent]++;

    // 6. GEO candidates (score ≥ 30, sorted desc)
    const geoCandidates = enriched
      .filter((k) => k.geo_score >= 30)
      .sort((a, b) => b.geo_score - a.geo_score)
      .map((k) => ({
        term: k.term,
        score: k.geo_score,
        families: k.geo_families,
      }));

    return JSON.stringify({
      seeds,
      total: enriched.length,
      keywords: enriched,
      clusters,
      geo_candidates: geoCandidates,
      intent_breakdown: intentBreakdown,
    });
  },
};
