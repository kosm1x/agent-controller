/**
 * seo_robots_audit — AI-bot coverage report for a site's robots.txt.
 *
 * Fetches {origin}/robots.txt, parses per RFC 9309, cross-references against
 * the AI_BOTS catalog, and emits:
 *   - bots explicitly Allowed
 *   - bots explicitly Disallowed (at least one prefix blocked)
 *   - bots not mentioned (default-allowed)
 *   - warnings for contradictions (e.g. GPTBot blocked but Google-Extended open)
 *
 * Part of v7.3 Phase 5 — GEO Depth.
 */

import type { Tool } from "../types.js";
import { AI_BOTS, type AIBot } from "./ai-bots.js";
import { validateOutboundUrl } from "../../lib/url-safety.js";

interface RobotsGroup {
  userAgents: string[]; // possibly multiple "User-agent:" lines before directives
  allow: string[];
  disallow: string[];
}

interface BotCoverage {
  name: string;
  user_agent: string;
  operator: string;
  purpose: AIBot["purpose"];
  state: "allowed" | "disallowed" | "unmentioned";
  matched_group?: string; // which User-agent line matched ("*" if wildcard-covered)
  blocked_paths?: string[]; // when disallowed: sample of Disallow prefixes
}

export interface RobotsAuditResult {
  origin: string;
  fetched: boolean;
  fetch_error?: string;
  total_bots_checked: number;
  allowed: BotCoverage[];
  disallowed: BotCoverage[];
  unmentioned: BotCoverage[];
  warnings: string[];
  raw_length?: number;
}

function parseRobotsTxt(body: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastDirectiveWasUserAgent = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) {
      lastDirectiveWasUserAgent = false;
      continue;
    }
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const directive = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (directive === "user-agent") {
      if (!current || !lastDirectiveWasUserAgent) {
        current = { userAgents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.userAgents.push(value);
      lastDirectiveWasUserAgent = true;
    } else if (directive === "allow" || directive === "disallow") {
      if (!current) {
        // Directive before any User-agent — treat as orphan, skip.
        continue;
      }
      if (value === "") {
        // Empty Disallow/Allow has spec-defined semantics but we skip for now.
        continue;
      }
      (directive === "allow" ? current.allow : current.disallow).push(value);
      lastDirectiveWasUserAgent = false;
    } else {
      lastDirectiveWasUserAgent = false;
    }
  }
  return groups;
}

/**
 * Return the effective directives for a given user-agent token.
 * Matches per RFC 9309: longest specific-name match wins; "*" is default.
 */
function effectiveDirectives(
  botUa: string,
  groups: RobotsGroup[],
): { allow: string[]; disallow: string[]; matchedName?: string } {
  const needle = botUa.toLowerCase();
  let specific: RobotsGroup | undefined;
  let wildcard: RobotsGroup | undefined;
  for (const g of groups) {
    for (const ua of g.userAgents) {
      const uaLc = ua.toLowerCase();
      if (uaLc === "*") wildcard = g;
      // Exact-match per RFC 9309 — prefix matching caused false positives
      // (e.g. `User-agent: C` matching ClaudeBot, cohere-ai, CCBot simultaneously).
      else if (uaLc === needle) {
        specific = g;
      }
    }
  }
  const chosen = specific ?? wildcard;
  if (!chosen) return { allow: [], disallow: [] };
  const matchedName = specific ? botUa : wildcard ? "*" : undefined;
  return { allow: chosen.allow, disallow: chosen.disallow, matchedName };
}

function classifyBot(bot: AIBot, groups: RobotsGroup[]): BotCoverage {
  const { allow, disallow, matchedName } = effectiveDirectives(
    bot.user_agent,
    groups,
  );
  const base = {
    name: bot.name,
    user_agent: bot.user_agent,
    operator: bot.operator,
    purpose: bot.purpose,
  } as const;
  if (!matchedName) {
    return { ...base, state: "unmentioned" };
  }
  // Blocks root → fully disallowed. Otherwise partially disallowed = still count as disallowed.
  const blocksRoot = disallow.includes("/");
  if (blocksRoot || disallow.length > allow.length) {
    return {
      ...base,
      state: "disallowed",
      matched_group: matchedName,
      blocked_paths: disallow.slice(0, 5),
    };
  }
  return { ...base, state: "allowed", matched_group: matchedName };
}

function computeWarnings(coverage: BotCoverage[]): string[] {
  const warnings: string[] = [];
  const byName = new Map(coverage.map((c) => [c.name, c]));

  // Contradiction: GPTBot (training) blocked but Google-Extended (training) open.
  const gpt = byName.get("GPTBot");
  const googleExt = byName.get("Google-Extended");
  if (
    gpt?.state === "disallowed" &&
    googleExt &&
    googleExt.state !== "disallowed"
  ) {
    warnings.push(
      "GPTBot is blocked but Google-Extended is not — inconsistent training-crawler policy.",
    );
  }

  // Citation crawlers blocked while training crawlers open — probably unintended
  // (citation-blocking hurts attribution without stopping model training).
  const trainingBlocked = coverage.filter(
    (c) => c.purpose === "training" && c.state === "disallowed",
  ).length;
  const citationBlocked = coverage.filter(
    (c) => c.purpose === "citation" && c.state === "disallowed",
  ).length;
  if (citationBlocked >= 2 && trainingBlocked === 0) {
    warnings.push(
      `${citationBlocked} citation crawlers are blocked but ALL training crawlers are allowed — probably backwards (blocking citations loses visibility without stopping training ingest).`,
    );
  }

  // ClaudeBot unmentioned is common; flag as advisory.
  if (byName.get("ClaudeBot")?.state === "unmentioned") {
    warnings.push(
      "ClaudeBot is not mentioned in robots.txt (default-allowed). If you want to opt out of Anthropic training, add an explicit Disallow.",
    );
  }
  return warnings;
}

export const seoRobotsAuditTool: Tool = {
  name: "seo_robots_audit",
  deferred: true,
  riskTier: "low",
  definition: {
    type: "function",
    function: {
      name: "seo_robots_audit",
      description: `Audit a site's /robots.txt for AI-bot coverage (training + citation crawlers).

USE WHEN: user asks "which AI bots can crawl my site?", "is GPTBot blocked?", "AI-bot robots.txt audit", "are we blocking ChatGPT/Claude/Perplexity?"

OUTPUT: JSON with allowed/disallowed/unmentioned bots (28-bot catalog), plus warnings for contradictory policies (e.g. GPTBot blocked but Google-Extended open).

NOT FOR: general robots.txt validation, sitemap extraction, page crawling. Use seo_page_audit for on-page SEO, seo_llms_txt_generate for AI-discoverable site summaries.`,
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description:
              "Any URL on the site (origin is derived). https://example.com or https://example.com/blog both work.",
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

    const robotsUrl = `${origin}/robots.txt`;
    const urlError = validateOutboundUrl(robotsUrl);
    if (urlError) {
      return JSON.stringify({ error: `URL rejected: ${urlError}` });
    }

    const result: RobotsAuditResult = {
      origin,
      fetched: false,
      total_bots_checked: AI_BOTS.length,
      allowed: [],
      disallowed: [],
      unmentioned: [],
      warnings: [],
    };

    try {
      const res = await fetch(robotsUrl, {
        signal: AbortSignal.timeout(10_000),
        redirect: "follow",
      });
      if (!res.ok) {
        result.fetch_error = `HTTP ${res.status}`;
        // 404 is a legitimate state: "no robots.txt → everything allowed".
        if (res.status === 404) {
          result.fetched = true;
          for (const bot of AI_BOTS) {
            result.allowed.push({
              name: bot.name,
              user_agent: bot.user_agent,
              operator: bot.operator,
              purpose: bot.purpose,
              state: "allowed",
              matched_group: "(no robots.txt — default allow)",
            });
          }
          result.warnings.push(
            "No robots.txt found (HTTP 404) — every bot is default-allowed. Consider adding an explicit policy.",
          );
          return JSON.stringify(result);
        }
        return JSON.stringify(result);
      }
      const body = await res.text();
      result.fetched = true;
      result.raw_length = body.length;
      const groups = parseRobotsTxt(body);

      for (const bot of AI_BOTS) {
        const cov = classifyBot(bot, groups);
        if (cov.state === "allowed") result.allowed.push(cov);
        else if (cov.state === "disallowed") result.disallowed.push(cov);
        else result.unmentioned.push(cov);
      }
      result.warnings = computeWarnings([
        ...result.allowed,
        ...result.disallowed,
        ...result.unmentioned,
      ]);
    } catch (err) {
      result.fetch_error = err instanceof Error ? err.message : String(err);
    }

    return JSON.stringify(result);
  },
};

// Exported for tests
export const _testonly = { parseRobotsTxt, effectiveDirectives, classifyBot };
