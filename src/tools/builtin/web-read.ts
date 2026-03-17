/**
 * Web read tool — fetches any URL and returns clean Markdown via Jina Reader.
 *
 * Prepends r.jina.ai/ to the target URL, which renders JavaScript,
 * strips navigation/ads, and returns LLM-friendly Markdown content.
 * No API key required for 20 RPM, or set JINA_API_KEY for 500 RPM.
 */

import type { Tool } from "../types.js";

const JINA_PREFIX = "https://r.jina.ai/";
const TIMEOUT_MS = 15_000;
const MAX_CONTENT = 30_000; // chars

export const webReadTool: Tool = {
  name: "web_read",
  definition: {
    type: "function",
    function: {
      name: "web_read",
      description: `Read a web page and return its content as clean Markdown.

USE WHEN:
- The user shares a URL and asks you to read, summarize, or analyze it
- You need to read a GitHub repo README, documentation page, article, or blog post
- You found a URL via web_search and need to read the full content
- The user says "lee esto", "resume esta página", "qué dice este link"

DO NOT USE WHEN:
- You just need search results (use web_search instead)
- The URL requires authentication (login-protected pages won't work)
- You need to read the user's own Google Docs (use gdocs_read instead)

Returns clean Markdown with headings, code blocks, and links preserved.
Works with: GitHub repos, news articles, documentation, blogs, PDFs.`,
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description:
              "The full URL to read (e.g., 'https://github.com/user/repo')",
          },
        },
        required: ["url"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const url = args.url as string;
    if (!url) {
      return JSON.stringify({ error: "url is required" });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const headers: Record<string, string> = {
        Accept: "text/markdown",
      };

      // Use API key for higher rate limits if available
      const apiKey = process.env.JINA_API_KEY;
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }

      const response = await fetch(`${JINA_PREFIX}${url}`, {
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        return JSON.stringify({
          error: `Failed to read URL: ${response.status} ${response.statusText}`,
          url,
        });
      }

      const content = await response.text();

      const trimmed =
        content.length > MAX_CONTENT
          ? content.slice(0, MAX_CONTENT) +
            `\n\n... (truncated, ${content.length} total chars)`
          : content;

      return JSON.stringify({
        url,
        content: trimmed,
        chars: content.length,
        truncated: content.length > MAX_CONTENT,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: `Web read failed: ${message}`, url });
    } finally {
      clearTimeout(timeout);
    }
  },
};
