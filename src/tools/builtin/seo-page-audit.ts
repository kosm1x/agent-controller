/**
 * seo_page_audit — Single-URL technical SEO audit.
 *
 * Fetches the page via Jina Reader (stealth browser fallback for CF),
 * parses markdown output for title/meta/headings/schema/images/content,
 * scores against a rubric, persists to seo_audits table.
 *
 * Part of v7.3 Phase 1 SEO/GEO tool suite.
 */

import type { Tool } from "../types.js";
import { webReadTool } from "./web-read.js";
import { getDatabase, writeWithRetry } from "../../db/index.js";
import { validateOutboundUrl } from "../../lib/url-safety.js";

interface ParsedPage {
  title?: string;
  meta_description?: string;
  h1: string[];
  h2: string[];
  h3: string[];
  json_ld: string[];
  images_with_alt: number;
  images_without_alt: number;
  word_count: number;
  raw_length: number;
}

interface Finding {
  severity: "critical" | "warning" | "info";
  message: string;
  points_lost: number;
}

interface AuditResult {
  score: number;
  findings: {
    priorities: string[];
    issues: Finding[];
    good: string[];
  };
  parsed: ParsedPage;
}

/** Extract a domain from a URL safely. */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Parse a Jina Reader markdown response (which contains a preamble with
 * Title/URL/Markdown Content sections) + lightweight scanning for key fields.
 * Jina's output shape: "Title: X\nURL Source: Y\nMarkdown Content:\n..."
 */
function parseJinaMarkdown(markdown: string): ParsedPage {
  const titleMatch = markdown.match(/^Title:\s*(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : undefined;

  // Description: Jina often emits "Markdown Content:" followed by a meta block
  const descMatch = markdown.match(
    /(?:Description|meta description):\s*(.+?)(?:\n|$)/i,
  );
  const metaDescription = descMatch ? descMatch[1].trim() : undefined;

  // Extract headings from the markdown body
  const body = markdown.split(/Markdown Content:\s*\n/i)[1] ?? markdown;

  const h1 = Array.from(body.matchAll(/^#\s+(.+)$/gm)).map((m) => m[1].trim());
  const h2 = Array.from(body.matchAll(/^##\s+(.+)$/gm)).map((m) => m[1].trim());
  const h3 = Array.from(body.matchAll(/^###\s+(.+)$/gm)).map((m) =>
    m[3] ? m[3].trim() : m[1].trim(),
  );

  // JSON-LD scripts (rare in Jina's markdown output — flag if present)
  const jsonLd = Array.from(
    markdown.matchAll(
      /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi,
    ),
  ).map((m) => m[1]);

  // Images: Jina emits ![alt](url) for images — count alt text coverage
  const imageMatches = Array.from(body.matchAll(/!\[([^\]]*)\]\([^)]+\)/g));
  let withAlt = 0;
  let withoutAlt = 0;
  for (const m of imageMatches) {
    if (m[1] && m[1].trim().length > 0) withAlt++;
    else withoutAlt++;
  }

  // Word count (strip markdown markers)
  const plainText = body
    .replace(/[#*_`>\[\]()!]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const wordCount = plainText.length === 0 ? 0 : plainText.split(" ").length;

  return {
    title,
    meta_description: metaDescription,
    h1,
    h2,
    h3,
    json_ld: jsonLd,
    images_with_alt: withAlt,
    images_without_alt: withoutAlt,
    word_count: wordCount,
    raw_length: markdown.length,
  };
}

/**
 * Score the parsed page against the rubric.
 * Max 100 points distributed across 8 criteria.
 */
function scorePage(parsed: ParsedPage, targetKeyword?: string): AuditResult {
  const issues: Finding[] = [];
  const good: string[] = [];
  let score = 100;

  // Title (10pt): present + 30-60 chars
  if (!parsed.title) {
    issues.push({
      severity: "critical",
      message: "Page has no <title> tag",
      points_lost: 10,
    });
    score -= 10;
  } else if (parsed.title.length < 30 || parsed.title.length > 60) {
    issues.push({
      severity: "warning",
      message: `Title length ${parsed.title.length} is outside 30-60 SERP-safe zone`,
      points_lost: 5,
    });
    score -= 5;
  } else {
    good.push(`Title length optimal (${parsed.title.length} chars)`);
  }

  // Meta description (20pt): present + 120-155 chars
  if (!parsed.meta_description) {
    issues.push({
      severity: "critical",
      message: "Missing meta description",
      points_lost: 20,
    });
    score -= 20;
  } else if (
    parsed.meta_description.length < 120 ||
    parsed.meta_description.length > 155
  ) {
    issues.push({
      severity: "warning",
      message: `Meta description length ${parsed.meta_description.length} is outside 120-155 ideal range`,
      points_lost: 10,
    });
    score -= 10;
  } else {
    good.push(
      `Meta description length optimal (${parsed.meta_description.length} chars)`,
    );
  }

  // H1 (10pt): exactly one
  if (parsed.h1.length === 0) {
    issues.push({
      severity: "critical",
      message: "No H1 heading found",
      points_lost: 10,
    });
    score -= 10;
  } else if (parsed.h1.length > 1) {
    issues.push({
      severity: "warning",
      message: `Multiple H1s found (${parsed.h1.length}) — should be unique`,
      points_lost: 5,
    });
    score -= 5;
  } else {
    good.push("Single H1 present");
  }

  // Schema markup (15pt): any JSON-LD present
  if (parsed.json_ld.length === 0) {
    issues.push({
      severity: "warning",
      message:
        "No JSON-LD structured data found — missing rich results opportunity",
      points_lost: 15,
    });
    score -= 15;
  } else {
    good.push(`${parsed.json_ld.length} JSON-LD blocks present`);
  }

  // Image alt text (15pt): coverage
  const totalImages = parsed.images_with_alt + parsed.images_without_alt;
  if (totalImages > 0) {
    const coverage = parsed.images_with_alt / totalImages;
    if (coverage < 0.5) {
      issues.push({
        severity: "critical",
        message: `Only ${Math.round(coverage * 100)}% of images have alt text`,
        points_lost: 15,
      });
      score -= 15;
    } else if (coverage < 0.9) {
      issues.push({
        severity: "warning",
        message: `${Math.round(coverage * 100)}% alt text coverage — aim for 100%`,
        points_lost: 7,
      });
      score -= 7;
    } else {
      good.push(`${Math.round(coverage * 100)}% alt text coverage`);
    }
  }

  // Content length (10pt): ≥ 300 words for informational pages
  if (parsed.word_count < 300) {
    issues.push({
      severity: "warning",
      message: `Thin content (${parsed.word_count} words) — aim for 300+`,
      points_lost: 10,
    });
    score -= 10;
  } else {
    good.push(`Content length ${parsed.word_count} words`);
  }

  // H2 structure (10pt): at least 2 H2 for content organization
  if (parsed.word_count >= 500 && parsed.h2.length < 2) {
    issues.push({
      severity: "warning",
      message: "Long content lacks H2 structure — add section headings",
      points_lost: 10,
    });
    score -= 10;
  } else if (parsed.h2.length >= 2) {
    good.push(`${parsed.h2.length} H2 section headings`);
  }

  // Keyword density (10pt): only if target_keyword provided
  if (targetKeyword && parsed.word_count > 0) {
    const kwLower = targetKeyword.toLowerCase();
    const plainWords = (parsed.title ?? "")
      .toLowerCase()
      .concat(" ", parsed.meta_description ?? "")
      .concat(" ", parsed.h1.join(" ").toLowerCase())
      .concat(" ", parsed.h2.join(" ").toLowerCase());
    const inTitle = parsed.title?.toLowerCase().includes(kwLower) ?? false;
    const inH1 = parsed.h1.some((h) => h.toLowerCase().includes(kwLower));

    if (!inTitle) {
      issues.push({
        severity: "critical",
        message: `Target keyword "${targetKeyword}" not in title`,
        points_lost: 5,
      });
      score -= 5;
    } else {
      good.push(`Target keyword in title`);
    }
    if (!inH1) {
      issues.push({
        severity: "warning",
        message: `Target keyword "${targetKeyword}" not in H1`,
        points_lost: 5,
      });
      score -= 5;
    }
    // Use plainWords to silence unused warning — reserved for future density calc
    void plainWords;
  }

  score = Math.max(0, Math.min(100, score));

  const priorities = issues
    .filter((i) => i.severity === "critical")
    .map((i) => i.message);

  return {
    score,
    findings: {
      priorities,
      issues,
      good,
    },
    parsed,
  };
}

function persistAudit(
  domain: string,
  url: string,
  result: AuditResult,
): number | null {
  try {
    return writeWithRetry(() => {
      const db = getDatabase();
      const stmt = db.prepare(
        `INSERT INTO seo_audits (domain, url, audit_type, score, findings, metadata)
         VALUES (?, ?, 'page', ?, ?, ?)`,
      );
      const info = stmt.run(
        domain,
        url,
        result.score,
        JSON.stringify(result.findings),
        JSON.stringify(result.parsed),
      );
      return typeof info.lastInsertRowid === "bigint"
        ? Number(info.lastInsertRowid)
        : (info.lastInsertRowid as number);
    });
  } catch (err) {
    console.warn(
      `[seo_page_audit] Failed to persist audit: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

export const seoPageAuditTool: Tool = {
  name: "seo_page_audit",
  deferred: true,
  riskTier: "low",
  triggerPhrases: [
    "audit seo",
    "analiza el seo",
    "analiza seo de",
    "revisa el seo",
    "seo de esta página",
    "technical seo audit",
    "page audit",
  ],
  definition: {
    type: "function",
    function: {
      name: "seo_page_audit",
      description: `Technical SEO audit of a single URL. Fetches the page, parses title/meta/headings/schema/images/content, and scores 0-100 against a rubric with prioritized findings. Persists results to the seo_audits table for trend tracking.

USE WHEN:
- User asks to audit/analyze/review the SEO of a specific URL
- Checking technical SEO health after a content update
- Diagnosing why a page isn't ranking
- Preparing a fix list for on-page optimization

DO NOT USE WHEN:
- User wants a full site crawl (Phase 1 is single-page only)
- Need PageSpeed / Core Web Vitals scores (Phase 2 — not yet available)
- User wants to generate new metadata (use seo_meta_generate)
- User wants schema markup (use seo_schema_generate)

RUBRIC (100 points):
- Title length 30-60 (10pt)
- Meta description 120-155 (20pt)
- H1 present and unique (10pt)
- JSON-LD structured data present (15pt)
- Image alt text coverage (15pt)
- Content length ≥300 words (10pt)
- H2 section structure for long content (10pt)
- Target keyword in title + H1 (10pt — only if target_keyword provided)

Returns score, prioritized issues (critical first), and a list of what's already good. Audit is persisted with an audit_id you can reference later.`,
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Full URL of the page to audit (must be https/http)",
          },
          target_keyword: {
            type: "string",
            description:
              "Optional: primary SEO keyword. If provided, the audit checks for keyword presence in title/H1 and adds keyword-specific findings.",
          },
        },
        required: ["url"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const url = args.url as string | undefined;
    if (!url) {
      return JSON.stringify({ error: "url is required" });
    }

    const urlError = validateOutboundUrl(url);
    if (urlError) {
      return JSON.stringify({ error: urlError, url });
    }

    const targetKeyword = args.target_keyword as string | undefined;

    // Fetch via web_read (Jina + stealth fallback handled inside)
    let fetched: { content?: string; error?: string; url?: string };
    try {
      const raw = await webReadTool.execute({ url });
      fetched = JSON.parse(raw) as typeof fetched;
    } catch (err) {
      return JSON.stringify({
        error: `Failed to fetch page: ${err instanceof Error ? err.message : String(err)}`,
        url,
      });
    }

    if (fetched.error || !fetched.content) {
      return JSON.stringify({
        error: `Could not read page: ${fetched.error ?? "empty content"}`,
        url,
      });
    }

    const parsed = parseJinaMarkdown(fetched.content);
    const result = scorePage(parsed, targetKeyword);
    const domain = extractDomain(url);
    const auditId = persistAudit(domain, url, result);

    return JSON.stringify({
      url,
      domain,
      score: result.score,
      findings: result.findings,
      parsed_summary: {
        title: parsed.title,
        meta_description: parsed.meta_description,
        h1_count: parsed.h1.length,
        h2_count: parsed.h2.length,
        h3_count: parsed.h3.length,
        word_count: parsed.word_count,
        json_ld_count: parsed.json_ld.length,
        images_with_alt: parsed.images_with_alt,
        images_without_alt: parsed.images_without_alt,
      },
      audit_id: auditId,
    });
  },
};
