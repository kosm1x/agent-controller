/**
 * Exa Search tool — semantic search API for research-grade results.
 *
 * Complements web_search (Brave) with neural/keyword hybrid search
 * that understands content relevance beyond simple keyword matching.
 * Particularly strong for company research, academic sources, and
 * finding high-quality content on specific topics.
 */

import type { Tool } from "../types.js";

const EXA_API_URL = "https://api.exa.ai/search";
const TIMEOUT_MS = 15_000;
const MAX_RESULTS = 10;

export const exaSearchTool: Tool = {
  name: "exa_search",
  definition: {
    type: "function",
    function: {
      name: "exa_search",
      description: `Semantic web search using Exa — finds content by meaning, not just keywords.

USE WHEN:
- Researching companies, products, or organizations (returns structured company data)
- Looking for in-depth articles, reports, or analysis on a topic
- The query requires understanding intent, not just keyword matching
- You need high-quality sources (academic, industry reports, authoritative blogs)
- Prospecting: finding companies in a specific vertical or with specific characteristics
- Signal intelligence: scanning for trends, emerging topics, or market shifts

DO NOT USE WHEN:
- Quick factual lookups (use web_search instead — faster, broader)
- Current events or breaking news (use web_search — fresher index)
- Looking for a specific known URL or page (use web_read)
- The user's own data (use commit__ or user_fact tools)

CATEGORIES (use to narrow results):
- "company" — company websites and profiles
- "research paper" — academic and research publications
- "tweet" — Twitter/X posts
- "github" — GitHub repositories
- "linkedin" — LinkedIn profiles and posts
- "news" — news articles
- "pdf" — PDF documents
- "personal site" — personal websites and blogs
Leave empty for general semantic search across all categories.`,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Search query — can be a natural language description of what you're looking for. Be specific about the topic and what kind of content you want.",
          },
          category: {
            type: "string",
            enum: [
              "company",
              "research paper",
              "tweet",
              "github",
              "linkedin",
              "news",
              "pdf",
              "personal site",
            ],
            description:
              "Narrow results to a specific content category. Omit for general search.",
          },
          num_results: {
            type: "number",
            description: `Number of results (1-${MAX_RESULTS}, default: 5)`,
          },
          include_text: {
            type: "boolean",
            description:
              "Include page text content in results (default: false). Set true when you need to read the actual content, not just titles/URLs.",
          },
          start_published_date: {
            type: "string",
            description:
              "Filter: only results published after this date (ISO format, e.g. 2025-01-01). Useful for finding recent content.",
          },
        },
        required: ["query"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const query = args.query as string;
    if (!query) {
      return JSON.stringify({ error: "query is required" });
    }

    const apiKey = process.env.EXA_API_KEY;
    if (!apiKey) {
      return JSON.stringify({
        error: "EXA_API_KEY not configured. Get one at https://exa.ai",
      });
    }

    const numResults = Math.min(
      Math.max((args.num_results as number) ?? 5, 1),
      MAX_RESULTS,
    );

    const body: Record<string, unknown> = {
      query,
      num_results: numResults,
      use_autoprompt: true,
    };

    if (args.category) {
      body.category = args.category;
    }
    if (args.start_published_date) {
      body.start_published_date = args.start_published_date;
    }
    if (args.include_text) {
      body.contents = { text: { max_characters: 3000 } };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(EXA_API_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return JSON.stringify({
          error: `Exa API error: ${response.status} ${text.slice(0, 300)}`,
        });
      }

      const data = (await response.json()) as ExaSearchResponse;

      const results = (data.results ?? []).map((r) => ({
        title: r.title,
        url: r.url,
        published_date: r.published_date ?? null,
        author: r.author ?? null,
        score: r.score != null ? Math.round(r.score * 100) / 100 : null,
        ...(r.text ? { text: r.text } : {}),
      }));

      return JSON.stringify({
        query,
        category: args.category ?? "all",
        results,
        total: results.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: `Exa search failed: ${message}` });
    } finally {
      clearTimeout(timeout);
    }
  },
};

// Exa API response types (minimal)
interface ExaSearchResponse {
  results?: Array<{
    title: string;
    url: string;
    published_date?: string;
    author?: string;
    score?: number;
    text?: string;
  }>;
}
