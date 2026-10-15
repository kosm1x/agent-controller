/**
 * Expand read tool — fetches a public URL through Expand's capture API
 * (real browser) and returns clean Markdown. With `query`, Expand ranks the
 * page's passages ("Highlights") and each one carries a citation link into
 * the immutable capture, so a quote can be verified later.
 *
 * Sibling of web_read (Jina), not a replacement. Dormant until
 * EXPAND_API_KEY is set. No retries inside the tool: every call spends
 * Expand credits.
 */

import { defineTool } from "../define-tool.js";
import { errMsg } from "../../lib/err-msg.js";
import { evictToFile } from "../../lib/eviction.js";
import { fetchJson, HttpStatusError } from "../../lib/fetch-json.js";
import { validateOutboundUrl } from "../../lib/url-safety.js";

// The empty `include=` turns State JSON off — Markdown only, smaller payload.
const ENDPOINT = "https://api.expand.ai/v1/fetch/json?include=";
const TIMEOUT_MS = 60_000;
const MAX_CONTENT = 5_000; // chars, no query — same cap as web_read
const MAX_CONTENT_WITH_QUERY = 1_500; // the highlights carry the answer
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 20; // Expand allows 50; keep Jarvis at 20
const MIN_SCORE = 0.6;
const MAX_SNIPPET_CHARS = 1_500;
const MAX_HIGHLIGHTS_CHARS = 6_000; // total budget across all snippets
const FALLBACK_PLAYGROUND_ORIGIN = "https://expand.land";

interface ExpandMeta {
  url?: string;
  finalUrl?: string;
  title?: string;
  capturedAt?: string;
  snapshotId?: string;
  playground?: string;
}

interface ExpandSnippet {
  source?: string;
  text?: string;
  score?: number;
  location?: { evidenceId?: unknown };
}

interface ExpandFetchResult {
  _tag?: string;
  // FetchOriginError fields
  kind?: string;
  retryable?: boolean;
  originStatusCode?: number;
  // FetchObjectModeResult fields
  meta?: ExpandMeta;
  markdown?: string;
  originError?: { originStatusCode?: number };
  data?: { highlights?: { snippets?: ExpandSnippet[] } };
}

/** Citation link into the capture, or null — never an invented id. */
function citeLink(meta: ExpandMeta, evidenceId: unknown): string | null {
  // Evidence ids are positive integers (number or digit string).
  const validId =
    (typeof evidenceId === "number" &&
      Number.isInteger(evidenceId) &&
      evidenceId >= 1) ||
    (typeof evidenceId === "string" && /^[1-9]\d*$/.test(evidenceId));
  if (!validId || !meta.snapshotId) return null;
  let origin = FALLBACK_PLAYGROUND_ORIGIN;
  try {
    if (meta.playground) {
      const parsed = new URL(meta.playground);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        origin = parsed.origin;
      }
    }
  } catch {
    /* unparseable playground URL — keep the fallback origin */
  }
  return `${origin}/s/${encodeURIComponent(meta.snapshotId)}?id=${encodeURIComponent(String(evidenceId))}`;
}

/** Expand's error `message` from a JSON body, else a ≤300-char text excerpt. */
function expandReason(bodyText: string): string {
  let reason = bodyText;
  try {
    const parsed = JSON.parse(bodyText) as { message?: unknown };
    if (typeof parsed?.message === "string") reason = parsed.message;
  } catch {
    /* not JSON — fall through to the excerpt */
  }
  return reason.replace(/\s+/g, " ").trim().slice(0, 300);
}

function httpError(err: HttpStatusError, url: string): string {
  const s = err.status;
  const msg = expandReason(err.bodyText);
  if (s === 401) {
    return JSON.stringify({ error: `Expand API key rejected (401): ${msg}`, url });
  }
  if (s === 403) {
    return JSON.stringify({
      error: `Expand refused the URL or the account has no credits (403): ${msg}`,
      url,
    });
  }
  if (s === 429 || s === 503 || s === 529) {
    return JSON.stringify({
      error: `Expand busy (${s}): ${msg}`,
      url,
      retryable: true,
    });
  }
  if (s === 404 || s === 410) {
    return JSON.stringify({ error: `Origin not found/gone (${s}): ${msg}`, url });
  }
  if (s === 413 || s === 415 || s === 422) {
    return JSON.stringify({
      error: `Unsupported or too large (${s}): ${msg}`,
      url,
    });
  }
  const excerpt = err.bodyText.replace(/\s+/g, " ").trim().slice(0, 300);
  return JSON.stringify({ error: `Expand API error: ${s} ${excerpt}`, url });
}

export const expandReadTool = defineTool({
  name: "expand_read",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
  description: `Read a public web page through Expand (real browser capture) and return clean Markdown. With \`query\`, return only the passages that answer it, each with a citation link to the capture.

USE WHEN:
- You must quote a page and give a link a person can verify (the link points at Expand's capture, which cannot change)
- You have a specific question about a page: pass \`query\` and get only the matching passages (far fewer tokens than the whole page)
- web_read or browser__markdown returned a refusal, a Cloudflare page or empty content and the URL is public (Expand drives a real browser)

DO NOT USE WHEN:
- A plain read of an article, README or docs page is enough (use web_read — free)
- You need search results (use web_search / exa_search)
- You must click, scroll or fill a form (use browser__goto + browser__markdown)
- The page needs a login
- The user's own Google Docs (use gdocs_read)

AFTER READING: When quoting, cite the snippet's \`cite\` link (the capture) rather than the live URL; say when a passage had no citation id. Every call spends Expand credits — one call per page, do not loop.`,
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The full public http(s) URL to read",
      },
      query: {
        type: "string",
        description:
          "Optional question or topic. When set, Expand returns only the passages that answer it, each with a citation link.",
      },
      max_results: {
        type: "integer",
        description: `Max passages to return (1-${MAX_RESULTS}, default ${DEFAULT_MAX_RESULTS}). Only used with query.`,
      },
    },
    required: ["url"],
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const url = args.url;
    if (typeof url !== "string" || !url) {
      return JSON.stringify({ error: "url is required" });
    }

    // SSRF protection — block private IPs, metadata endpoints, non-HTTP schemes
    const urlError = validateOutboundUrl(url);
    if (urlError) {
      return JSON.stringify({ error: urlError, url });
    }

    const apiKey = process.env.EXPAND_API_KEY;
    if (!apiKey) {
      return JSON.stringify({
        error: "EXPAND_API_KEY not configured. Get one at https://expand.ai",
        url,
      });
    }

    const query =
      typeof args.query === "string" && args.query.trim() !== ""
        ? args.query.trim()
        : undefined;
    const requested = Math.trunc(Number(args.max_results));
    const maxResults = Math.min(
      Math.max(Number.isFinite(requested) ? requested : DEFAULT_MAX_RESULTS, 1),
      MAX_RESULTS,
    );

    const body: Record<string, unknown> = { url };
    if (query) {
      body.highlights = { query, maxResults, minScore: MIN_SCORE };
    }

    let data: ExpandFetchResult;
    try {
      data = (await fetchJson(ENDPOINT, {
        method: "POST",
        timeoutMs: TIMEOUT_MS,
        label: "Expand",
        headers: {
          "Content-Type": "application/json",
          "x-expand-api-key": apiKey,
        },
        body: JSON.stringify(body),
      })) as ExpandFetchResult;
    } catch (err) {
      if (err instanceof HttpStatusError) return httpError(err, url);
      const name = (err as { name?: unknown } | null)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        return JSON.stringify({
          error: "Expand fetch timed out after 60s",
          url,
          retryable: true,
        });
      }
      return JSON.stringify({ error: `Expand fetch failed: ${errMsg(err)}`, url });
    }

    // 200 union: the origin could not be reached at all.
    if (data?._tag === "FetchOriginError") {
      return JSON.stringify({
        error: `Origin unreachable: ${data.kind}`,
        kind: data.kind,
        retryable: data.retryable,
        url,
        ...(data.originStatusCode != null && {
          origin_status: data.originStatusCode,
        }),
      });
    }

    const meta: ExpandMeta = data?.meta ?? {};
    const markdown = typeof data?.markdown === "string" ? data.markdown : "";
    const cap = query ? MAX_CONTENT_WITH_QUERY : MAX_CONTENT;

    let content = markdown;
    let evictedFilePath: string | undefined;
    if (markdown.length > cap) {
      const { preview, filePath } = evictToFile(markdown, "expand-read", cap);
      content = preview;
      evictedFilePath = filePath;
    }

    const snippets = data?.data?.highlights?.snippets;
    let highlights:
      | Array<{
          text: unknown;
          score: number | null;
          source: unknown;
          cite: string | null;
        }>
      | undefined;
    let highlightsDropped = 0;
    if (query) {
      highlights = [];
      let budget = 0;
      const valid = (Array.isArray(snippets) ? snippets : []).filter(
        (s): s is ExpandSnippet => !!s && typeof s === "object",
      );
      for (const s of valid) {
        let text: unknown = s.text;
        let used = 0;
        if (typeof s.text === "string") {
          const kept = s.text.slice(0, MAX_SNIPPET_CHARS);
          used = kept.length;
          // A cut passage is marked so a quote from it reads as incomplete.
          text = s.text.length > MAX_SNIPPET_CHARS ? `${kept}…` : kept;
        }
        if (budget + used > MAX_HIGHLIGHTS_CHARS) {
          highlightsDropped = valid.length - highlights.length;
          break;
        }
        budget += used;
        highlights.push({
          text,
          score:
            typeof s.score === "number" ? Math.round(s.score * 100) / 100 : null,
          source: s.source,
          cite: citeLink(meta, s.location?.evidenceId),
        });
      }
    }

    return JSON.stringify({
      url,
      ...(meta.finalUrl && { final_url: meta.finalUrl }),
      ...(meta.title && { title: meta.title }),
      captured_at: meta.capturedAt,
      snapshot_url: meta.playground,
      ...(data?.originError?.originStatusCode != null && {
        origin_status: data.originError.originStatusCode,
      }),
      content,
      chars: markdown.length,
      truncated: markdown.length > cap,
      ...(evictedFilePath && { full_content_path: evictedFilePath }),
      ...(highlights && { highlights }),
      ...(highlightsDropped > 0 && { highlights_dropped: highlightsDropped }),
    });
  },
});
