/**
 * seo_llms_txt_generate — build an /llms.txt AI-readable site summary.
 *
 * Fetches the site's sitemap (via robots.txt Sitemap: directive, falling back
 * to /sitemap.xml and /sitemap_index.xml), extracts all <loc> entries, clusters
 * by first path segment, and emits markdown per the emerging llmstxt.org spec.
 *
 * Output shape (per https://llmstxt.org):
 *   # {Site Name}
 *
 *   > {site tagline / meta description}
 *
 *   ## {Cluster Name e.g. Blog}
 *
 *   - [Page Title](URL): optional short description
 *
 * Part of v7.3 Phase 5 — GEO Depth.
 */

import type { Tool } from "../types.js";
import { validateOutboundUrl } from "../../lib/url-safety.js";

const MAX_URLS_PER_CLUSTER = 50;
const MAX_CLUSTERS = 20;
const FETCH_TIMEOUT_MS = 15_000;

export interface LlmsTxtResult {
  origin: string;
  sitemap_url?: string;
  url_count: number;
  cluster_count: number;
  markdown: string;
  suggested_filename: string;
  warnings: string[];
}

async function fetchText(url: string): Promise<string | null> {
  // validateOutboundUrl returns a string error or null — do NOT try/catch.
  // Also protects the recursive sitemap-discovery path: an attacker-controlled
  // robots.txt Sitemap: directive pointing at http://localhost/ must be blocked.
  if (validateOutboundUrl(url)) return null;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "follow",
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** Extract Sitemap: directives from a robots.txt body. */
function sitemapsFromRobots(body: string): string[] {
  const out: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = line.match(/^sitemap:\s*(\S+)/i);
    if (m) out.push(m[1]);
  }
  return out;
}

/** Parse a sitemap XML body. Returns URLs + nested sitemap URLs. */
function parseSitemap(body: string): {
  urls: string[];
  nestedSitemaps: string[];
} {
  const urls: string[] = [];
  const nested: string[] = [];
  // <sitemap><loc>...</loc></sitemap> — sitemap index
  const indexRe = /<sitemap>[\s\S]*?<loc>([^<]+)<\/loc>[\s\S]*?<\/sitemap>/gi;
  // <url><loc>...</loc></url> — regular sitemap
  const urlRe = /<url>[\s\S]*?<loc>([^<]+)<\/loc>[\s\S]*?<\/url>/gi;
  let m: RegExpExecArray | null;
  while ((m = indexRe.exec(body)) !== null) {
    nested.push(m[1].trim());
  }
  while ((m = urlRe.exec(body)) !== null) {
    urls.push(m[1].trim());
  }
  return { urls, nestedSitemaps: nested };
}

async function discoverUrls(
  origin: string,
  result: LlmsTxtResult,
): Promise<string[]> {
  // Step 1: robots.txt Sitemap:
  const robotsBody = await fetchText(`${origin}/robots.txt`);
  const candidates: string[] = [];
  if (robotsBody) {
    for (const s of sitemapsFromRobots(robotsBody)) candidates.push(s);
  }
  // Step 2: common fallbacks
  candidates.push(`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`);

  const seen = new Set<string>();
  const urls: string[] = [];
  const queue = [...candidates];
  let primarySitemap: string | undefined;

  while (queue.length > 0 && urls.length < 5000) {
    const sm = queue.shift()!;
    if (seen.has(sm)) continue;
    seen.add(sm);
    const body = await fetchText(sm);
    if (!body) continue;
    if (!primarySitemap) primarySitemap = sm;
    const parsed = parseSitemap(body);
    // Cap inside the push so a single 50k-url sitemap can't blow past 5k total.
    const remaining = 5000 - urls.length;
    if (remaining > 0) urls.push(...parsed.urls.slice(0, remaining));
    for (const ns of parsed.nestedSitemaps) {
      if (!seen.has(ns)) queue.push(ns);
    }
  }
  result.sitemap_url = primarySitemap;
  if (!primarySitemap) {
    result.warnings.push(
      "No sitemap found via robots.txt or common paths (/sitemap.xml, /sitemap_index.xml).",
    );
  }
  return urls;
}

/** Cluster URLs by first meaningful path segment. */
function clusterByPath(urls: string[], origin: string): Map<string, string[]> {
  const clusters = new Map<string, string[]>();
  for (const u of urls) {
    try {
      const parsed = new URL(u);
      if (parsed.origin !== origin) continue;
      const segs = parsed.pathname.split("/").filter(Boolean);
      const key = segs.length === 0 ? "Home" : segs[0];
      const list = clusters.get(key) ?? [];
      list.push(u);
      clusters.set(key, list);
    } catch {
      // skip malformed URL
    }
  }
  return clusters;
}

/** Try to derive a human title from a URL's slug. */
function deriveTitle(url: string): string {
  try {
    const parsed = new URL(url);
    const segs = parsed.pathname.split("/").filter(Boolean);
    const last = segs[segs.length - 1] ?? parsed.hostname;
    return last
      .replace(/\.html?$/, "")
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  } catch {
    return url;
  }
}

/** Fetch homepage, extract <title> + meta description for the site summary. */
async function fetchSiteMeta(
  origin: string,
): Promise<{ title?: string; summary?: string }> {
  const body = await fetchText(origin);
  if (!body) return {};
  const titleMatch = body.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
  const descMatch = body.match(
    /<meta\s+(?:[^>]*\s)?name=["']description["']\s+(?:[^>]*\s)?content=["']([^"']{1,400})["']/i,
  );
  return {
    title: titleMatch?.[1].trim(),
    summary: descMatch?.[1].trim(),
  };
}

function titleCase(s: string): string {
  return s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function buildMarkdown(
  origin: string,
  meta: { title?: string; summary?: string },
  clusters: Map<string, string[]>,
): string {
  const hostname = new URL(origin).hostname;
  const siteTitle = meta.title ?? hostname;
  const lines: string[] = [`# ${siteTitle}`];
  if (meta.summary) {
    lines.push("", `> ${meta.summary}`);
  } else {
    lines.push("", `> Site map for ${hostname}, generated for LLM discovery.`);
  }

  // Sort clusters: Home first, then alphabetically, capped at MAX_CLUSTERS.
  const entries = Array.from(clusters.entries()).sort((a, b) => {
    if (a[0] === "Home") return -1;
    if (b[0] === "Home") return 1;
    return a[0].localeCompare(b[0]);
  });
  const capped = entries.slice(0, MAX_CLUSTERS);

  for (const [key, urls] of capped) {
    lines.push("", `## ${titleCase(key)}`, "");
    const items = urls.slice(0, MAX_URLS_PER_CLUSTER);
    for (const u of items) {
      lines.push(`- [${deriveTitle(u)}](${u})`);
    }
    if (urls.length > items.length) {
      lines.push(`- _(+${urls.length - items.length} more)_`);
    }
  }
  if (entries.length > capped.length) {
    lines.push(
      "",
      `_(+${entries.length - capped.length} more clusters omitted)_`,
    );
  }
  return lines.join("\n");
}

export const seoLlmsTxtGenerateTool: Tool = {
  name: "seo_llms_txt_generate",
  deferred: true,
  riskTier: "low",
  definition: {
    type: "function",
    function: {
      name: "seo_llms_txt_generate",
      description: `Generate an /llms.txt file for a site (LLM-readable site summary per https://llmstxt.org).

USE WHEN: user says "generate llms.txt", "llms.txt for my site", "AI-readable site summary", "opt-in LLM discovery".

WHAT IT DOES: fetches the site's sitemap (via robots.txt Sitemap: directive + common fallbacks), clusters URLs by path, emits markdown with site heading + blockquote summary + H2 sections + bulleted links.

OUTPUT: JSON with {markdown, suggested_filename, url_count, cluster_count, sitemap_url, warnings}. The user should save the markdown to their site's root as /llms.txt.

NOT FOR: writing arbitrary markdown (use file_write), SEO audits (use seo_page_audit), or crawler policy (use seo_robots_audit).`,
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Any URL on the site (origin is derived).",
          },
        },
        required: ["url"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const rawUrl = String(args.url ?? "").trim();
    if (!rawUrl) {
      return JSON.stringify({ error: "url parameter is required" });
    }
    let origin: string;
    try {
      origin = new URL(rawUrl).origin;
    } catch {
      return JSON.stringify({ error: `Invalid URL: ${rawUrl}` });
    }

    const result: LlmsTxtResult = {
      origin,
      url_count: 0,
      cluster_count: 0,
      markdown: "",
      suggested_filename: "llms.txt",
      warnings: [],
    };

    const urls = await discoverUrls(origin, result);
    result.url_count = urls.length;
    if (urls.length === 0) {
      result.markdown = `# ${new URL(origin).hostname}\n\n> No sitemap discovered; please provide a sitemap URL or create /sitemap.xml first.\n`;
      return JSON.stringify(result);
    }
    const meta = await fetchSiteMeta(origin);
    const clusters = clusterByPath(urls, origin);
    result.cluster_count = clusters.size;
    result.markdown = buildMarkdown(origin, meta, clusters);
    return JSON.stringify(result);
  },
};

export const _testonly = {
  parseSitemap,
  sitemapsFromRobots,
  clusterByPath,
  deriveTitle,
  buildMarkdown,
};
