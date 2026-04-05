/**
 * Web search tool — Brave Search API integration.
 *
 * Gives the agent access to the internet for real-time information.
 * Returns structured search results (title, URL, description) that the
 * LLM can use to answer any question requiring current information.
 */

import type { Tool } from "../types.js";

const BRAVE_API_URL = "https://api.search.brave.com/res/v1/web/search";
const TIMEOUT_MS = 10_000;
const MAX_RESULTS = 5;

export const webSearchTool: Tool = {
  name: "web_search",
  definition: {
    type: "function",
    function: {
      name: "web_search",
      description: `Search the internet for real-time information using Brave Search.

USE WHEN:
- The user asks about current events, news, prices, weather, or anything time-sensitive
- You need factual information you're not confident about (dates, statistics, people, companies)
- The user asks you to research a topic, find resources, compare options, or look something up
- You need to verify a claim or find the latest version of something
- The user asks "busca", "investiga", "qué es", "cuándo", "dónde", or any knowledge question
- ANY question where your training data might be outdated or insufficient

DO NOT USE WHEN:
- The answer is about the user's own goals/tasks data (use jarvis_file_read on NorthStar/ instead)
- The user is giving you a command to manage tasks/goals (use jarvis_file_read/jarvis_file_write)
- You already have the information from conversation memory or mental models

ALWAYS prefer searching over guessing. If you're unsure, search.

AFTER SEARCHING: Cite specific sources (title + URL) when reporting findings. Never present search results as your own knowledge.`,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Search query in natural language. Be specific. Use English for broader results or Spanish for Mexico-specific results.",
          },
          count: {
            type: "number",
            description: `Number of results to return (1-10, default: ${MAX_RESULTS})`,
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

    const apiKey = process.env.BRAVE_SEARCH_API_KEY;
    if (!apiKey) {
      return JSON.stringify({
        error: "BRAVE_SEARCH_API_KEY not configured",
      });
    }

    const count = Math.min(
      Math.max((args.count as number) ?? MAX_RESULTS, 1),
      10,
    );
    const url = `${BRAVE_API_URL}?q=${encodeURIComponent(query)}&count=${count}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": apiKey,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return JSON.stringify({
          error: `Brave Search API error: ${response.status} ${text}`,
        });
      }

      const data = (await response.json()) as BraveSearchResponse;

      // Extract web results
      const results = (data.web?.results ?? []).slice(0, count).map((r) => ({
        title: r.title,
        url: r.url,
        description: r.description,
      }));

      // Extract featured snippet if available
      const snippet = data.web?.results?.find((r) => r.extra_snippets?.length)
        ?.extra_snippets?.[0];

      // Extract knowledge graph if available
      const knowledge = data.knowledge_graph
        ? {
            title: data.knowledge_graph.title,
            description: data.knowledge_graph.description,
          }
        : null;

      return JSON.stringify({
        query,
        results,
        total: results.length,
        ...(snippet ? { featured_snippet: snippet } : {}),
        ...(knowledge ? { knowledge_graph: knowledge } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: `Search failed: ${message}` });
    } finally {
      clearTimeout(timeout);
    }
  },
};

// Brave Search API response types (minimal, what we need)
interface BraveSearchResponse {
  web?: {
    results?: Array<{
      title: string;
      url: string;
      description: string;
      extra_snippets?: string[];
    }>;
  };
  knowledge_graph?: {
    title: string;
    description: string;
  };
}
