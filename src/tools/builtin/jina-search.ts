/**
 * Jina Search tool — s.jina.ai web search that can return the text of the
 * top results in one call.
 *
 * Needs JINA_API_KEY (100 RPM). Each request costs a flat token amount
 * (≥ 10,000 Jina tokens), so the default asks for results WITHOUT page
 * bodies (`X-Respond-With: no-content`, the cheapest form) and the tool is
 * described as the opt-in sibling of web_search.
 */

import { defineTool } from "../define-tool.js";
import { errMsg } from "../../lib/err-msg.js";
import { evictToFile } from "../../lib/eviction.js";
import { jinaReason } from "./web-read.js";

const JINA_SEARCH_URL = "https://s.jina.ai/";
const TIMEOUT_MS = 15_000;
const MAX_NUM = 10;
const MAX_RESULT_CONTENT = 1_500; // chars per result body
const MAX_CONTENT = 5_000; // chars for the whole JSON result, like web_read
const MAX_DESCRIPTION = 300; // chars per result snippet
const MAX_TITLE = 300; // chars per result title
const MAX_URL = 2_000; // chars per result URL
const MIN_BODY = 200; // escaped chars a body keeps before trailing rows are dropped instead
const SITE_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/i;
const LANG_RE = /^[a-z]{2}$/;

interface JinaSearchResult {
  title?: string;
  url?: string;
  description?: string;
  date?: string;
  content?: string;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v ? v : undefined;

/** Length of a string once JSON-escaped, without the quotes. */
const escLen = (s: string): number => JSON.stringify(s).length - 2;

/** Longest prefix of `s` whose JSON-escaped length is at most `max`. */
function fitEscaped(s: string, max: number): string {
  if (escLen(s) <= max) return s;
  let lo = 0;
  let hi = Math.min(s.length, max);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (escLen(s.slice(0, mid)) <= max) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo);
}

export const jinaSearchTool = defineTool({
  name: "jina_search",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
  description: `Web search through Jina (s.jina.ai) that can return the text of the top results in one call.

USE WHEN:
- The user needs what the top sources actually say in one call (research, "qué dicen las fuentes sobre X") — set with_content=true
- The search must be restricted to one site (site="example.com")
- web_search returned nothing useful

DO NOT USE WHEN:
- A plain list of links is enough (use web_search instead — it is cheaper: a Jina search costs at least 10,000 tokens per request)
- You already have the URL (use web_read)
- JINA_API_KEY is not configured (the tool returns an error)

Without with_content you get title, URL, snippet and date per result (cheapest form). With with_content each result carries up to 1,500 chars of page text.

AFTER SEARCHING: Cite the URLs. Distinguish between what the pages claim and your own analysis.`,
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query, 2-400 characters.",
      },
      num: {
        type: "integer",
        description: `Number of results, integer 1-${MAX_NUM} (default: 5).`,
      },
      page: {
        type: "integer",
        description: "Result page, integer >= 1 (default: 1).",
      },
      site: {
        type: "string",
        description:
          "Optional hostname to restrict results to (e.g., 'example.com', 'docs.example.org').",
      },
      country: {
        type: "string",
        description:
          "Optional two-letter lowercase country code for result ranking (e.g., 'mx', 'us').",
      },
      language: {
        type: "string",
        description:
          "Optional two-letter lowercase language code (e.g., 'es', 'en').",
      },
      with_content: {
        type: "boolean",
        description:
          "Include page text per result (default: false). Same price per request; larger output.",
      },
    },
    required: ["query"],
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (query.length < 2 || query.length > 400) {
      return JSON.stringify({ error: "query must be 2-400 characters" });
    }

    const num = args.num ?? 5;
    if (
      typeof num !== "number" ||
      !Number.isInteger(num) ||
      num < 1 ||
      num > MAX_NUM
    ) {
      return JSON.stringify({
        error: `num must be an integer from 1 to ${MAX_NUM}`,
      });
    }
    const page = args.page ?? 1;
    if (typeof page !== "number" || !Number.isInteger(page) || page < 1) {
      return JSON.stringify({ error: "page must be an integer >= 1" });
    }
    const site = args.site;
    if (
      site !== undefined &&
      (typeof site !== "string" || !SITE_RE.test(site))
    ) {
      return JSON.stringify({
        error: "site must be a hostname like 'example.com'",
      });
    }
    for (const name of ["country", "language"]) {
      const v = args[name];
      if (v !== undefined && (typeof v !== "string" || !LANG_RE.test(v))) {
        return JSON.stringify({
          error: `${name} must be a two-letter lowercase code`,
        });
      }
    }
    const withContent = args.with_content === true;

    const apiKey = process.env.JINA_API_KEY;
    if (!apiKey) {
      return JSON.stringify({
        error: "JINA_API_KEY not configured. Get one at https://jina.ai",
      });
    }

    const params = new URLSearchParams({
      q: query,
      num: String(num),
      page: String(page),
    });
    if (site) params.set("site", site as string);
    if (args.country) params.set("gl", args.country as string);
    if (args.language) params.set("hl", args.language as string);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    };
    if (!withContent) headers["X-Respond-With"] = "no-content";

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(`${JINA_SEARCH_URL}?${params}`, {
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        const reason = jinaReason(await response.text().catch(() => ""));
        const hint =
          response.status === 401 || response.status === 402
            ? "key invalid or out of tokens; check the Jina dashboard"
            : response.status === 429
              ? "rate limited; use web_search"
              : undefined;
        return JSON.stringify({
          error: `Jina search failed: ${response.status} ${response.statusText}${reason ? ` — ${reason}` : ""}`,
          ...(hint && { hint }),
        });
      }

      // A 200 that is not a JSON object is a failed search, not "no results"
      let parsed: unknown;
      try {
        parsed = JSON.parse(await response.text());
      } catch {
        parsed = undefined;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return JSON.stringify({
          error: "Jina search returned a non-JSON response",
          hint: "the search did not complete; retry once or use web_search",
        });
      }
      const data = parsed as { data?: unknown; usage?: { tokens?: unknown } };
      const rows = Array.isArray(data.data) ? data.data : [];
      const results: JinaSearchResult[] = rows
        .filter(
          (r): r is Record<string, unknown> => !!r && typeof r === "object",
        )
        .map((r) => {
          const content = withContent ? str(r.content) : undefined;
          const description = str(r.description);
          const title = str(r.title);
          const url = str(r.url);
          return {
            ...(title && { title: title.slice(0, MAX_TITLE) }),
            ...(url && { url: url.slice(0, MAX_URL) }),
            ...(description && {
              description: description.slice(0, MAX_DESCRIPTION),
            }),
            ...(str(r.date) && { date: str(r.date) }),
            ...(content && { content: content.slice(0, MAX_RESULT_CONTENT) }),
          };
        });
      const tokens = data.usage?.tokens;
      const shape = (
        list: JinaSearchResult[],
        extra: Record<string, unknown> = {},
      ): string =>
        JSON.stringify({
          query,
          results: list,
          count: list.length,
          page,
          ...(typeof tokens === "number" && { tokens_used: tokens }),
          ...extra,
        });

      const full = shape(results);
      if (full.length <= MAX_CONTENT) return full;

      // Too big: the full JSON goes to a file. The returned JSON stays
      // parseable and within the cap: page bodies are shortened evenly (sizes
      // measured JSON-escaped); when a body would drop under MIN_BODY, or the
      // rows alone are too big, trailing rows are dropped instead.
      const { filePath } = evictToFile(full, "jina-search", MAX_CONTENT);
      const fit = (list: JinaSearchResult[]): string | null => {
        const extra = {
          truncated: true,
          ...(list.length < results.length && {
            dropped: results.length - list.length,
          }),
          ...(filePath && { full_content_path: filePath }),
        };
        const bodies = list.filter((r) => r.content).map((r) => r.content!);
        let fitted = list;
        if (bodies.length) {
          const bare = list.map((r) => (r.content ? { ...r, content: "" } : r));
          const share = Math.floor(
            (MAX_CONTENT - shape(bare, extra).length) / bodies.length,
          );
          const need = Math.min(MIN_BODY, Math.max(...bodies.map(escLen)));
          if (share < need) return null;
          fitted = list.map((r) =>
            r.content ? { ...r, content: fitEscaped(r.content, share) } : r,
          );
        }
        const json = shape(fitted, extra);
        return json.length <= MAX_CONTENT || list.length === 0 ? json : null;
      };
      for (let n = results.length; n > 0; n--) {
        const json = fit(results.slice(0, n));
        if (json) return json;
      }
      return fit([])!;
    } catch (err) {
      return JSON.stringify({ error: `Jina search failed: ${errMsg(err)}` });
    } finally {
      clearTimeout(timeout);
    }
  },
});
