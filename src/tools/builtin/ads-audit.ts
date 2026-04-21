/**
 * ads_audit — Digital ad account audit.
 *
 * Accepts a structured snapshot of an ad account (spend / ROAS / tracking /
 * creative / targeting knobs) and scores it against a weighted check
 * framework across 7 platforms. Returns a graded report with prioritized
 * findings and optional industry-benchmark context.
 *
 * Part of v7.3 Phase 4 — Digital Marketing Buyer (P4a slice). Persists to
 * `ads_audits` for trend tracking.
 */

import type { Tool } from "../types.js";
import { getDatabase, writeWithRetry } from "../../db/index.js";
import {
  scoreAudit,
  ALL_CHECKS,
  type AdAccountSnapshot,
  type AdPlatform,
  type ScoredAudit,
} from "./ads-references/checks-framework.js";
import {
  lookupBenchmark,
  type Industry,
  type BenchmarkPlatform,
  ALL_INDUSTRIES,
} from "./ads-references/industry-benchmarks.js";

const VALID_PLATFORMS: AdPlatform[] = [
  "google_ads",
  "meta_ads",
  "linkedin_ads",
  "tiktok_ads",
  "youtube_ads",
  "microsoft_ads",
  "apple_search_ads",
];

/** Map an audit platform to its default benchmark-platform slug. */
function benchmarkPlatformFor(platform: AdPlatform): BenchmarkPlatform | null {
  switch (platform) {
    case "google_ads":
      return "google_search";
    case "meta_ads":
      return "meta_feed";
    case "linkedin_ads":
      return "linkedin_feed";
    case "tiktok_ads":
      return "tiktok_feed";
    case "youtube_ads":
      return "youtube_preroll";
    case "microsoft_ads":
      return "microsoft_search";
    case "apple_search_ads":
      return "apple_search_ads";
    default:
      return null;
  }
}

function compareToBenchmark(
  snapshot: AdAccountSnapshot,
  industry: Industry,
): string[] {
  const plat = benchmarkPlatformFor(snapshot.platform);
  if (!plat) return [];
  const b = lookupBenchmark(industry, plat);
  if (!b) return [];
  const notes: string[] = [];
  if (snapshot.cpa !== undefined && b.cpa_median !== undefined) {
    const ratio = snapshot.cpa / b.cpa_median;
    if (ratio >= 1.5) {
      notes.push(
        `CPA $${snapshot.cpa.toFixed(2)} is ${ratio.toFixed(1)}× the ${industry}/${plat} median of $${b.cpa_median.toFixed(2)}.`,
      );
    } else if (ratio <= 0.6) {
      notes.push(
        `CPA $${snapshot.cpa.toFixed(2)} beats the ${industry}/${plat} median of $${b.cpa_median.toFixed(2)} by ${((1 - ratio) * 100).toFixed(0)}%.`,
      );
    }
  }
  if (snapshot.ctr !== undefined && b.ctr_median !== undefined) {
    const ratio = snapshot.ctr / b.ctr_median;
    if (ratio <= 0.6) {
      notes.push(
        `CTR ${(snapshot.ctr * 100).toFixed(2)}% is ${((1 - ratio) * 100).toFixed(0)}% below the ${industry}/${plat} median of ${(b.ctr_median * 100).toFixed(2)}%.`,
      );
    } else if (ratio >= 1.4) {
      notes.push(
        `CTR ${(snapshot.ctr * 100).toFixed(2)}% outperforms the ${industry}/${plat} median by ${((ratio - 1) * 100).toFixed(0)}%.`,
      );
    }
  }
  if (snapshot.roas !== undefined && b.roas_median !== undefined) {
    if (snapshot.roas < b.roas_median * 0.7) {
      notes.push(
        `ROAS ${snapshot.roas.toFixed(2)}× is well below the ${industry}/${plat} median of ${b.roas_median.toFixed(2)}×.`,
      );
    }
  }
  return notes;
}

function persistAudit(
  accountName: string,
  snapshot: AdAccountSnapshot,
  scored: ScoredAudit,
): number | null {
  try {
    return writeWithRetry(() => {
      const db = getDatabase();
      const stmt = db.prepare(
        `INSERT INTO ads_audits
          (account_name, platform, score, grade, raw_weighted, max_weighted, findings, snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const info = stmt.run(
        accountName,
        scored.platform,
        scored.score,
        scored.grade,
        scored.raw_weighted,
        scored.max_weighted,
        JSON.stringify(compactFindings(scored)),
        JSON.stringify(snapshot),
      );
      return typeof info.lastInsertRowid === "bigint"
        ? Number(info.lastInsertRowid)
        : (info.lastInsertRowid as number);
    });
  } catch (err) {
    console.warn(
      `[ads_audit] Failed to persist audit: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Compact output shape returned to the LLM. Full `results[]` (one entry per
 * applicable check) would explode the tool-output token budget on accounts
 * with the full 225-check set. Only failures + passes-of-note are kept.
 */
function compactFindings(scored: ScoredAudit): {
  summary: string;
  priorities: {
    severity: string;
    category: string;
    title: string;
    id: string;
    message: string;
  }[];
  passes_of_note: { category: string; title: string; id: string }[];
} {
  const priorities: {
    severity: string;
    category: string;
    title: string;
    id: string;
    message: string;
  }[] = [];
  for (const sev of ["critical", "high", "medium", "low", "info"] as const) {
    for (const r of scored.failures_by_severity[sev]) {
      if (r.outcome.status === "fail") {
        priorities.push({
          severity: sev,
          category: r.check.category,
          title: r.check.title,
          id: r.check.id,
          message: r.outcome.message,
        });
      }
    }
  }
  const passesOfNote: { category: string; title: string; id: string }[] = [];
  for (const r of scored.results) {
    if (r.outcome.status === "pass" && r.check.severity === "critical") {
      passesOfNote.push({
        category: r.check.category,
        title: r.check.title,
        id: r.check.id,
      });
    }
  }
  const critCount = scored.failures_by_severity.critical.length;
  const highCount = scored.failures_by_severity.high.length;
  const summary = `${scored.score}/100 (${scored.grade}). ${scored.checks_applicable} checks applicable (${scored.checks_not_applicable} skipped on missing data). ${critCount} critical and ${highCount} high-severity failure(s).`;
  return { summary, priorities, passes_of_note: passesOfNote };
}

export const adsAuditTool: Tool = {
  name: "ads_audit",
  deferred: true,
  riskTier: "low",
  triggerPhrases: [
    "audita la cuenta",
    "audita mis anuncios",
    "audita mi campaña",
    "audit my ad account",
    "audit this campaign",
    "ad account audit",
  ],
  definition: {
    type: "function",
    function: {
      name: "ads_audit",
      description: `Audit a digital ad account against a weighted check framework (7 platforms, ~70 checks v1, scaling to 225+). Returns an A-F grade, category scores (targeting / budget / creative / technical / tracking), prioritized fix list, and optional industry-benchmark context.

USE WHEN:
- User pastes ad account performance data and asks "how are we doing?" / "audita esta cuenta"
- Preparing an ad-buyer report for a client
- Before a campaign strategy meeting
- When ROAS / CPA / CTR look off and the cause isn't obvious

DO NOT USE WHEN:
- User wants to create a campaign (no creation in this tool — that's P4b API clients)
- User wants creative copy generated (use ads_creative_gen)
- User wants to extract brand-identity signals from a website (use ads_brand_dna)
- User wants live API data (this tool is snapshot-based; live API clients ship in P4b)

INPUT: one account snapshot with whatever fields the operator has. Partial data is fine — checks that need a missing field are marked not_applicable and excluded from the grade so the score stays honest.

PLATFORMS: google_ads, meta_ads, linkedin_ads, tiktok_ads, youtube_ads, microsoft_ads, apple_search_ads.

Audit is persisted to ads_audits with an audit_id you can reference later.`,
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: VALID_PLATFORMS,
            description:
              "Which ad platform the snapshot is from. Selects the platform-specific check subset.",
          },
          account_name: {
            type: "string",
            description:
              "Operator-facing name for the account (e.g. 'ACME Retail — Meta'). Required for audit history lookup.",
          },
          snapshot: {
            type: "object",
            description: `Structured snapshot of the account's numbers and settings over a period. Fields: account_id, currency, period {start,end}, spend, revenue, conversions, ctr (0-1, not %), cpc, cpa, roas, frequency, quality_score (1-10), active_campaigns, paused_campaigns, zero_conversion_campaigns, ad_groups_count, active_creatives, stale_creatives, conversion_tracking_enabled, pixel_installed, enhanced_conversions_enabled, negative_keywords_count, brand_separation, audience_exclusions_configured, dayparting_enabled, geo_presence_targeting, bidding_strategy, ad_extensions_count, notes. Partial data is allowed.`,
            additionalProperties: true,
          },
          industry: {
            type: "string",
            enum: ALL_INDUSTRIES,
            description:
              "Optional. If provided, the report appends industry-benchmark commentary (CPA / CTR / ROAS vs median).",
          },
        },
        required: ["platform", "account_name", "snapshot"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const platform = args.platform as AdPlatform | undefined;
    const accountName = args.account_name as string | undefined;
    const snapshotRaw = args.snapshot as Record<string, unknown> | undefined;
    const industry = args.industry as Industry | undefined;

    if (!platform || !VALID_PLATFORMS.includes(platform)) {
      return JSON.stringify({
        error: `platform must be one of: ${VALID_PLATFORMS.join(", ")}`,
      });
    }
    if (!accountName || accountName.trim().length === 0) {
      return JSON.stringify({ error: "account_name is required" });
    }
    if (!snapshotRaw || typeof snapshotRaw !== "object") {
      return JSON.stringify({
        error: "snapshot must be an object with account-level fields",
      });
    }

    const snapshot: AdAccountSnapshot = {
      ...(snapshotRaw as Partial<AdAccountSnapshot>),
      platform,
    };

    const scored = scoreAudit(snapshot);
    const benchmark_notes = industry
      ? compareToBenchmark(snapshot, industry)
      : [];
    const auditId = persistAudit(accountName, snapshot, scored);

    return JSON.stringify({
      account_name: accountName,
      platform,
      score: scored.score,
      grade: scored.grade,
      category_scores: scored.category_scores,
      summary: `${scored.score}/100 (${scored.grade}) — ${scored.failures_by_severity.critical.length} critical, ${scored.failures_by_severity.high.length} high, ${scored.failures_by_severity.medium.length} medium failures across ${scored.checks_applicable} applicable checks.`,
      findings: compactFindings(scored),
      benchmark_notes,
      meta: {
        total_checks_defined: ALL_CHECKS.length,
        checks_applicable: scored.checks_applicable,
        checks_not_applicable: scored.checks_not_applicable,
      },
      audit_id: auditId,
    });
  },
};
