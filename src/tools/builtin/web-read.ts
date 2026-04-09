/**
 * Web read tool — fetches any URL and returns clean Markdown via Jina Reader.
 *
 * Prepends r.jina.ai/ to the target URL, which renders JavaScript,
 * strips navigation/ads, and returns LLM-friendly Markdown content.
 * No API key required for 20 RPM, or set JINA_API_KEY for 500 RPM.
 */

import type { Tool } from "../types.js";
import { extractPdfFromUrl } from "../../lib/pdf.js";
import { evictToFile } from "../../lib/eviction.js";
import {
  isCloudflareChallenge,
  stealthFetch,
} from "../../lib/stealth-browser.js";

const JINA_PREFIX = "https://r.jina.ai/";
const TIMEOUT_MS = 15_000;
const MAX_CONTENT = 5_000; // chars — halved from 10K to prevent token budget blow-outs when many tools are scoped

async function extractPdfLocally(url: string): Promise<string> {
  try {
    const content = await extractPdfFromUrl(url, {
      maxChars: MAX_CONTENT,
      timeoutMs: TIMEOUT_MS,
    });
    return JSON.stringify({
      url,
      content,
      chars: content.length,
      truncated: false,
      source: "local-pdf",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({
      error: `PDF extraction failed: ${message}`,
      url,
    });
  }
}

/**
 * Stealth browser fallback for Cloudflare-protected pages.
 * Launches headless Chromium with anti-bot patches, solves Turnstile if needed.
 */
async function stealthFallback(url: string): Promise<string> {
  console.log(`[web-read] Cloudflare detected, trying stealth browser: ${url}`);
  try {
    const result = await stealthFetch(url, {
      timeoutMs: 30_000,
      extractMarkdown: true,
    });

    if (!result || !result.content) {
      return JSON.stringify({
        error:
          "Cloudflare-protected page — stealth browser could not extract content",
        url,
      });
    }

    let trimmed = result.content;
    let evictedFilePath: string | undefined;

    if (result.content.length > MAX_CONTENT) {
      const { preview, filePath } = evictToFile(
        result.content,
        "web-read-stealth",
        MAX_CONTENT,
      );
      trimmed = preview;
      evictedFilePath = filePath;
    }

    return JSON.stringify({
      url: result.finalUrl,
      content: trimmed,
      chars: result.content.length,
      truncated: result.content.length > MAX_CONTENT,
      source: "stealth-browser",
      cloudflare_solved: result.solved,
      ...(evictedFilePath && { full_content_path: evictedFilePath }),
    });
  } catch (err) {
    return JSON.stringify({
      error: `Stealth browser fallback failed: ${err instanceof Error ? err.message : String(err)}`,
      url,
    });
  }
}

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
- The page is JS-heavy / a single-page app that needs rendering (use browser__goto + browser__markdown instead)
- You need to interact with the page: click buttons, fill forms, scroll (use browser__* tools)

Returns clean Markdown with headings, code blocks, and links preserved.
Works with: GitHub repos, news articles, documentation, blogs, PDFs.
Cloudflare-protected pages are handled automatically via stealth browser fallback.
For interactive browsing or JS-rendered pages, use the browser__* tools (goto, markdown, click, fill, evaluate, etc.).

AFTER READING: Cite the URL when reporting content. Distinguish between what the page says and your own analysis.`,
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

    // PDF URLs: extract locally via OpenDataLoader (no Jina dependency)
    if (url.toLowerCase().endsWith(".pdf")) {
      return await extractPdfLocally(url);
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

      // If Jina returns a PDF content-type, the URL was a PDF — extract locally
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/pdf")) {
        return await extractPdfLocally(url);
      }

      if (!response.ok) {
        // Cloudflare fallback: if Jina returns 403/503, try stealth browser
        if (response.status === 403 || response.status === 503) {
          const body = await response.text().catch(() => "");
          if (isCloudflareChallenge(body)) {
            return await stealthFallback(url);
          }
        }
        return JSON.stringify({
          error: `Failed to read URL: ${response.status} ${response.statusText}`,
          url,
        });
      }

      const content = await response.text();

      // Jina sometimes returns Cloudflare challenge HTML instead of content
      if (isCloudflareChallenge(content)) {
        return await stealthFallback(url);
      }

      let trimmed = content;
      let evictedFilePath: string | undefined;

      if (content.length > MAX_CONTENT) {
        const { preview, filePath } = evictToFile(
          content,
          "web-read",
          MAX_CONTENT,
        );
        trimmed = preview;
        evictedFilePath = filePath;
      }

      return JSON.stringify({
        url,
        content: trimmed,
        chars: content.length,
        truncated: content.length > MAX_CONTENT,
        ...(evictedFilePath && { full_content_path: evictedFilePath }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: `Web read failed: ${message}`, url });
    } finally {
      clearTimeout(timeout);
    }
  },
};
