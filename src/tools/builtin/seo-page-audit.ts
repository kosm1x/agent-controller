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
  plain_text?: string;
}

interface Finding {
  severity: "critical" | "warning" | "info";
  message: string;
  points_lost: number;
}

/**
 * Content-quality signals from the Princeton KDD 2024 paper "GEO: Generative
 * Engine Optimization" (https://arxiv.org/abs/2409.09978). Scored independently
 * from the structural rubric so existing consumers of `score` are unaffected.
 */
interface ContentQuality {
  /** Signals per 1000 words. Cite/stat density, plus presence flags + scalar scores. */
  cite_density_per_1k: number;
  stat_density_per_1k: number;
  quote_count: number;
  quote_presence: boolean;
  /**
   * Flesch-Kincaid grade level. Calibrated for English; Spanish/other
   * non-English text will be skewed by the anglo syllable heuristic. Treat
   * the grade as a relative signal across pages in the same language, not
   * an absolute metric.
   */
  readability_grade: number;
  keyword_stuffing_ratio: number; // highest single-noun repetition / total words
  keyword_stuffing_term?: string;
  /** Impact-weighted 0-100 score. Rewards cite/stat/quote density + readability. */
  score: number;
  notes: string[];
}

interface AuditResult {
  score: number;
  findings: {
    priorities: string[];
    issues: Finding[];
    good: string[];
  };
  parsed: ParsedPage;
  content_quality?: ContentQuality;
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
    m[1].trim(),
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
    plain_text: plainText,
  };
}

// -- Content-quality (Princeton KDD 2024 GEO signals) ----------------------

/** Rough syllable count per word — enough for Flesch-Kincaid. */
function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-záéíóúñü]/g, "");
  if (w.length === 0) return 0;
  if (w.length <= 3) return 1;
  const trimmed = w.replace(/(es|ed|e)$/, "").replace(/^y/, "");
  const groups = trimmed.match(/[aeiouyáéíóúü]+/g);
  return Math.max(1, groups?.length ?? 1);
}

/** Flesch-Kincaid Grade Level from plain text. */
function fleschKincaidGrade(text: string): number {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  const sentences = Math.max(1, text.split(/[.!?]+\s/).filter(Boolean).length);
  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  const wordsPerSentence = words.length / sentences;
  const syllablesPerWord = syllables / words.length;
  const grade = 0.39 * wordsPerSentence + 11.8 * syllablesPerWord - 15.59;
  return Math.max(0, Math.round(grade * 10) / 10);
}

/** Stopwords excluded from keyword-stuffing analysis. EN + ES union. */
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "have",
  "has",
  "are",
  "was",
  "were",
  "you",
  "your",
  "yours",
  "will",
  "would",
  "could",
  "should",
  "their",
  "they",
  "them",
  "our",
  "ours",
  "about",
  "into",
  "what",
  "when",
  "where",
  "which",
  "while",
  "been",
  "being",
  "than",
  "also",
  "some",
  "such",
  "more",
  "most",
  "very",
  "just",
  "there",
  "here",
  "el",
  "la",
  "los",
  "las",
  "un",
  "una",
  "unos",
  "unas",
  "que",
  "por",
  "con",
  "para",
  "pero",
  "como",
  "este",
  "esta",
  "estos",
  "estas",
  "esa",
  "ese",
  "esos",
  "esas",
  "del",
  "de",
  "lo",
  "al",
  "su",
  "sus",
  "se",
  "le",
  "les",
  "nos",
  "mi",
  "tu",
  "es",
  "son",
  "era",
  "eran",
  "sin",
  "sobre",
  "entre",
  "hasta",
  "desde",
  "muy",
  "mas",
  "más",
  "menos",
  "qué",
  "cuál",
]);

function keywordStuffing(text: string): {
  ratio: number;
  term?: string;
} {
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
  if (tokens.length < 50) return { ratio: 0 };
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  let topTerm = "";
  let topCount = 0;
  for (const [t, c] of counts) {
    if (c > topCount) {
      topCount = c;
      topTerm = t;
    }
  }
  return { ratio: topCount / tokens.length, term: topTerm };
}

function computeContentQuality(parsed: ParsedPage): ContentQuality {
  const text = parsed.plain_text ?? "";
  const notes: string[] = [];
  // Short-circuit on thin content — emitting "low citation density (0/1k words)"
  // on a 20-word page is noise, not signal.
  if (!text || parsed.word_count < 50) {
    return {
      cite_density_per_1k: 0,
      stat_density_per_1k: 0,
      quote_count: 0,
      quote_presence: false,
      readability_grade: 0,
      keyword_stuffing_ratio: 0,
      score: 0,
      notes: ["Content too short for quality analysis (<50 words)"],
    };
  }
  const words = Math.max(1, parsed.word_count);
  const per1k = (n: number) => Math.round((n / words) * 10000) / 10;

  // Citations: [1]-style brackets OR (Author, Year) OR inline-URL pattern.
  const bracketCites = text.match(/\[\d{1,3}\]/g)?.length ?? 0;
  const authorYearCites =
    text.match(
      /\([A-Z][a-z]+(?:\s(?:et al\.?|&|and)\s[A-Z][a-z]+)?,\s*\d{4}\)/g,
    )?.length ?? 0;
  const hyperlinks = text.match(/\bhttps?:\/\/\S+/g)?.length ?? 0;
  const cites = bracketCites + authorYearCites + hyperlinks;

  // Statistics: numbers with % / percent / × / x / std units.
  const stats =
    text.match(/\b\d+(?:\.\d+)?\s*(?:%|percent|×|x\b|USD|EUR|GBP)/gi)?.length ??
    0;

  // Quotes: ASCII double, curly double (U+201C/U+201D), OR >blockquote lines.
  const straightQuotes = text.match(/"[^"]{5,}"/g)?.length ?? 0;
  const curlyQuotes = text.match(/[“][^“”]{5,}[”]/g)?.length ?? 0;
  const blockQuotes = text.match(/(?:^|\n)>\s+/g)?.length ?? 0;
  const quoteCount = straightQuotes + curlyQuotes + blockQuotes;

  const grade = fleschKincaidGrade(text);
  const stuffing = keywordStuffing(text);

  // Impact-weighted score. Cite-density and stat-density are the highest-lift
  // Princeton signals (+30-115% and +40% citation-likelihood respectively).
  let score = 100;
  const citeDensity = per1k(cites);
  const statDensity = per1k(stats);
  if (citeDensity < 2) {
    score -= 15;
    notes.push(
      `Low citation density (${citeDensity}/1k words) — Princeton finds citations lift AI-overview inclusion 30-115%`,
    );
  } else {
    notes.push(`Citation density: ${citeDensity}/1k words`);
  }
  if (statDensity < 1) {
    score -= 15;
    notes.push(
      `Low statistic density (${statDensity}/1k words) — hard numbers lift citation likelihood ~40%`,
    );
  } else {
    notes.push(`Statistic density: ${statDensity}/1k words`);
  }
  if (quoteCount === 0) {
    score -= 10;
    notes.push(
      "No quotes detected — Princeton finds quote presence lifts inclusion 30-40%",
    );
  } else {
    notes.push(`Quote presence: ${quoteCount} quotes`);
  }
  if (grade > 16) {
    score -= 15;
    notes.push(
      `Readability grade ${grade} is very high — AI overviews favor grade 10-14 content`,
    );
  } else if (grade < 8) {
    score -= 5;
    notes.push(
      `Readability grade ${grade} — may be too basic for authority signals`,
    );
  } else {
    notes.push(`Readability grade ${grade} (AI-overview-friendly)`);
  }
  if (stuffing.ratio > 0.03) {
    score -= 15;
    notes.push(
      `Possible keyword stuffing — "${stuffing.term}" appears ${(stuffing.ratio * 100).toFixed(1)}% of tokens`,
    );
  }

  return {
    cite_density_per_1k: citeDensity,
    stat_density_per_1k: statDensity,
    quote_count: quoteCount,
    quote_presence: quoteCount > 0,
    readability_grade: grade,
    keyword_stuffing_ratio: Math.round(stuffing.ratio * 10000) / 10000,
    keyword_stuffing_term: stuffing.term,
    score: Math.max(0, score),
    notes,
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
    content_quality: computeContentQuality(parsed),
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
      content_quality: result.content_quality,
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
