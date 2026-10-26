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
import { validateOutboundUrl } from "../../lib/url-safety.js";
import { parseTweetId, readTweet } from "./web-read-tweet.js";

const JINA_PREFIX = "https://r.jina.ai/";
const TIMEOUT_MS = 15_000;
const MAX_CONTENT = 5_000; // chars — halved from 10K to prevent token budget blow-outs when many tools are scoped

const ENGINES = ["direct", "browser"];
const FORMATS = ["markdown", "text", "html"];
const WAITS = ["visible-content", "mutation-idle", "network-idle"];
const SELECTOR_MAX = 200;
const SELECTOR_RE = /^[\x20-\x7E]*$/; // printable ASCII: no CR/LF, no bytes a header cannot carry
const LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;
const PROXY_RE = /^(auto|[a-z]{2})$/;

interface ReaderOptions {
  headers: Record<string, string>;
  timeoutMs: number;
  note?: string;
}

function intInRange(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

/**
 * Optional Jina Reader parameters → request headers. Returns an error string
 * for an invalid value. With no options the result is `{}` + the default
 * timeout, so a plain `{ url }` read sends exactly what it always did.
 */
function readerOptions(
  args: Record<string, unknown>,
  hasKey: boolean,
): ReaderOptions | string {
  const headers: Record<string, string> = {};
  let timeoutMs = TIMEOUT_MS;
  let note: string | undefined;

  const selectors: Array<[string, string]> = [
    ["selector", "X-Target-Selector"],
    ["wait_for", "X-Wait-For-Selector"],
    ["remove_selector", "X-Remove-Selector"],
  ];
  for (const [name, header] of selectors) {
    const v = args[name];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") return `${name} must be a string`;
    if (!SELECTOR_RE.test(v))
      return `${name} must be printable ASCII (no line breaks or non-ASCII characters)`;
    const t = v.trim();
    if (t.length > SELECTOR_MAX)
      return `${name} must be at most ${SELECTOR_MAX} characters`;
    if (t) headers[header] = t;
  }

  if (args.engine !== undefined) {
    if (!ENGINES.includes(args.engine as string))
      return `engine must be one of: ${ENGINES.join(", ")}`;
    headers["X-Engine"] = args.engine as string;
  }
  if (args.fresh === true) headers["X-No-Cache"] = "true";

  if (args.format !== undefined) {
    if (!FORMATS.includes(args.format as string))
      return `format must be one of: ${FORMATS.join(", ")}`;
    if (args.format !== "markdown") {
      headers["X-Respond-With"] = args.format as string;
    }
  }

  if (args.links_summary === true) headers["X-With-Links-Summary"] = "true";
  if (args.images_summary === true) headers["X-With-Images-Summary"] = "true";
  if (args.strip_images === true) headers["X-Retain-Images"] = "none";

  if (args.timeout_s !== undefined) {
    if (!intInRange(args.timeout_s, 5, 60))
      return "timeout_s must be an integer from 5 to 60";
    headers["X-Timeout"] = String(args.timeout_s);
    timeoutMs = (args.timeout_s + 5) * 1000;
  }
  if (args.max_tokens !== undefined) {
    if (!intInRange(args.max_tokens, 200, 20_000))
      return "max_tokens must be an integer from 200 to 20000";
    headers["X-Max-Tokens"] = String(args.max_tokens);
  }
  if (args.locale !== undefined) {
    if (typeof args.locale !== "string" || !LOCALE_RE.test(args.locale))
      return "locale must look like 'es' or 'es-MX'";
    headers["X-Locale"] = args.locale;
  }
  if (args.proxy !== undefined) {
    if (typeof args.proxy !== "string" || !PROXY_RE.test(args.proxy))
      return "proxy must be 'auto' or a two-letter lowercase country code";
    // Jina proxies need a key; without one the read goes out unproxied
    if (hasKey) headers["X-Proxy"] = args.proxy;
    else note = "proxy ignored: JINA_API_KEY not set";
  }
  if (args.wait !== undefined) {
    if (!WAITS.includes(args.wait as string))
      return `wait must be one of: ${WAITS.join(", ")}`;
    headers["X-Respond-Timing"] = args.wait as string;
  }

  return { headers, timeoutMs, ...(note && { note }) };
}

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

/** Jina's error reason from a non-ok body (JSON or plain text), ≤300 chars. */
export function jinaReason(body: string): string {
  let reason = "";
  try {
    const parsed = JSON.parse(body) as {
      readableMessage?: unknown;
      message?: unknown;
    };
    const msg = parsed?.readableMessage ?? parsed?.message;
    if (typeof msg === "string") reason = msg;
  } catch {
    if (!body.trimStart().startsWith("<")) reason = body;
  }
  return reason.replace(/\s+/g, " ").trim().slice(0, 300);
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
  readOnlyHint: true,
  destructiveHint: false,
  // Round-2 audit W1 fix (Spine 4): per MCP-spec idempotentHint defines
  // "no additional effect on system state beyond the first" — a pure read
  // tool has no system-state effect at all, so re-issuing the same call
  // is idempotent. External content drift (same URL returning different
  // content over time) does not break this contract.
  idempotentHint: true,
  openWorldHint: true,
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
- You need to interact with the page: click buttons, fill forms, scroll (use browser__* tools)

Returns clean Markdown with headings, code blocks, and links preserved.
Works with: GitHub repos, news articles, documentation, blogs, PDFs.
X/Twitter status links are read directly (text, author, quotes, articles).
Cloudflare-protected pages are handled automatically via stealth browser fallback.
JS-rendered pages are rendered by Jina; use wait_for if the content loads late and selector to keep only the useful part of the page.
For interactive browsing (click, fill, scroll), use the browser__* tools (goto, markdown, click, fill, evaluate, etc.).
OPTIONS: all optional, omit them for a plain read; each parameter says what it does (page part, rendering, freshness, output, region).

AFTER READING: Cite the URL when reporting content. Distinguish between what the page says and your own analysis.`,
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description:
              "The full URL to read (e.g., 'https://github.com/user/repo')",
          },
          selector: {
            type: "string",
            description:
              "Optional CSS selector; return only that part of the page (e.g., 'article', 'main', '#content'). Max 200 chars.",
          },
          wait_for: {
            type: "string",
            description:
              "Optional CSS selector to wait for before extracting (pages that load content late). Max 200 chars.",
          },
          remove_selector: {
            type: "string",
            description:
              "Optional CSS selector to drop before extracting (e.g., 'nav, footer, .ads'). Max 200 chars.",
          },
          engine: {
            type: "string",
            enum: ["direct", "browser"],
            description:
              "Optional: 'browser' renders the page in a real browser (JS-heavy pages); 'direct' is faster for static pages. Omit for Jina's default.",
          },
          fresh: {
            type: "boolean",
            description:
              "Optional: true bypasses Jina's cache (live prices, pages updated minutes ago).",
          },
          format: {
            type: "string",
            enum: ["markdown", "text", "html"],
            description: "Optional output format (default: markdown).",
          },
          links_summary: {
            type: "boolean",
            description:
              "Optional: true appends a list of the links found on the page.",
          },
          images_summary: {
            type: "boolean",
            description:
              "Optional: true appends a list of the images found on the page.",
          },
          strip_images: {
            type: "boolean",
            description: "Optional: true removes images from the output.",
          },
          timeout_s: {
            type: "integer",
            description:
              "Optional: seconds Jina may wait for a slow page, integer 5-60 (default: Jina's own, 15 s local limit).",
          },
          max_tokens: {
            type: "integer",
            description:
              "Optional: server-side cap on the returned tokens, integer 200-20000.",
          },
          locale: {
            type: "string",
            description:
              "Optional browser locale, 'xx' or 'xx-YY' (e.g., 'es', 'es-MX').",
          },
          proxy: {
            type: "string",
            description:
              "Optional: 'auto' or a two-letter lowercase country code (e.g., 'mx', 'us') for geo-dependent pages. Needs JINA_API_KEY; ignored without it.",
          },
          wait: {
            type: "string",
            enum: ["visible-content", "mutation-idle", "network-idle"],
            description:
              "Optional: when the page counts as loaded before extraction (late-loading content).",
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

    // SSRF protection — block private IPs, metadata endpoints, non-HTTP schemes
    const urlError = validateOutboundUrl(url);
    if (urlError) {
      return JSON.stringify({ error: urlError, url });
    }

    // Optional Jina Reader parameters — validated before any fetch
    const apiKey = process.env.JINA_API_KEY;
    const opts = readerOptions(args, Boolean(apiKey));
    if (typeof opts === "string") {
      return JSON.stringify({ error: opts, url });
    }
    const note = opts.note;

    // PDF URLs: extract locally via OpenDataLoader (no Jina dependency)
    if (url.toLowerCase().endsWith(".pdf")) {
      return await extractPdfLocally(url);
    }

    // X/Twitter status links: Jina blocks anonymous x.com reads
    const tweetId = parseTweetId(url);
    if (tweetId) {
      try {
        const tweet = await readTweet(tweetId);
        if (tweet) {
          let trimmed = tweet.content;
          let evictedFilePath: string | undefined;

          if (tweet.content.length > MAX_CONTENT) {
            const { preview, filePath } = evictToFile(
              tweet.content,
              "web-read-tweet",
              MAX_CONTENT,
            );
            trimmed = preview;
            evictedFilePath = filePath;
          }

          return JSON.stringify({
            url,
            content: trimmed,
            chars: tweet.content.length,
            truncated: tweet.content.length > MAX_CONTENT,
            source: tweet.source,
            ...(evictedFilePath && { full_content_path: evictedFilePath }),
          });
        }
      } catch (err) {
        console.log(
          `[web-read] tweet path failed for ${url} (${err instanceof Error ? err.message : String(err)}), falling back to Jina`,
        );
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);

    try {
      const headers: Record<string, string> = {
        Accept: opts.headers["X-Respond-With"] ? "text/plain" : "text/markdown",
      };

      // Use API key for higher rate limits if available
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }
      Object.assign(headers, opts.headers);

      let response = await fetch(`${JINA_PREFIX}${url}`, {
        headers,
        signal: controller.signal,
      });

      // One cheap second try through Jina on 403/503 before giving up:
      // bypass its cache and force the browser engine (+ proxy with a key).
      // Never on 429 (a retry without backoff only burns the quota); a
      // Cloudflare challenge goes to the stealth fallback below instead.
      // Shares the abort window with the first fetch.
      let failBody: string | undefined;
      let retried = false;
      if (
        (response.status === 403 || response.status === 503) &&
        headers["X-Engine"] !== "browser"
      ) {
        failBody = await response.text().catch(() => "");
        if (!isCloudflareChallenge(failBody)) {
          const retryHeaders: Record<string, string> = {
            ...headers,
            "X-No-Cache": "true",
            "X-Engine": "browser",
          };
          if (apiKey && !retryHeaders["X-Proxy"]) {
            retryHeaders["X-Proxy"] = "auto";
          }
          try {
            const retry = await fetch(`${JINA_PREFIX}${url}`, {
              headers: retryHeaders,
              signal: controller.signal,
            });
            if (retry.ok) {
              response = retry;
              retried = true;
            } else {
              // release the connection held by the unread failure body
              await retry.body?.cancel().catch(() => {});
            }
          } catch {
            // keep the original failure
          }
        }
      }

      // If Jina returns a PDF content-type, the URL was a PDF — extract locally
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/pdf")) {
        return await extractPdfLocally(url);
      }

      if (!response.ok) {
        const body =
          failBody ??
          ([403, 429, 451, 503].includes(response.status)
            ? await response.text().catch(() => "")
            : "");
        // Cloudflare fallback: if Jina returns 403/503, try stealth browser
        if (
          (response.status === 403 || response.status === 503) &&
          isCloudflareChallenge(body)
        ) {
          return await stealthFallback(url);
        }
        // Jina refused (blocked domain / rate limit): keep its reason and
        // point the model at the real browser instead of giving up
        if ([403, 429, 451].includes(response.status)) {
          const reason = jinaReason(body);
          return JSON.stringify({
            error: `Failed to read URL: ${response.status} ${response.statusText}${reason ? ` — ${reason}` : ""}`,
            url,
            hint: "Jina Reader refused this URL; the page itself may be fine. Retry with browser__goto on this URL, then browser__markdown, or expand_read if it is available.",
            ...(note && { note }),
          });
        }
        return JSON.stringify({
          error: `Failed to read URL: ${response.status} ${response.statusText}`,
          url,
          ...(note && { note }),
        });
      }

      const content = await response.text();

      // Jina sometimes returns Cloudflare challenge HTML instead of content.
      // Markdown only: an html/text body of a normal page may load
      // challenges.cloudflare.com (Turnstile) and must not be replaced.
      if (!headers["X-Respond-With"] && isCloudflareChallenge(content)) {
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
        ...(retried && { retried: true }),
        ...(note && { note }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: `Web read failed: ${message}`, url });
    } finally {
      clearTimeout(timeout);
    }
  },
};
