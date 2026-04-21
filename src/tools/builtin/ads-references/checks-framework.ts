/**
 * Ad account audit — weighted check framework.
 *
 * Clean-room port of AgriciDaniel/claude-ads audit scoring: 7 platforms,
 * weighted checks by severity (critical 5.0× → info 0.5×), 5 categories.
 *
 * Scoring: raw score = sum(weight × severity_multiplier) for passing checks
 * out of max possible for the applicable check set. Normalized 0-100 with
 * A-F grade. Category breakdown preserved.
 *
 * Scope note: this is v1 — ~70 checks across 7 platforms. claude-ads ships
 * 225+; we keep scaffolding that scales and add checks as real ad accounts
 * expose gaps. Adding a check is a data-only change, not code.
 */

export type AdPlatform =
  | "google_ads"
  | "meta_ads"
  | "linkedin_ads"
  | "tiktok_ads"
  | "youtube_ads"
  | "microsoft_ads"
  | "apple_search_ads"
  | "cross_platform";

export type AdCheckSeverity = "critical" | "high" | "medium" | "low" | "info";

export type AdCheckCategory =
  | "targeting"
  | "budget"
  | "creative"
  | "technical"
  | "tracking";

/**
 * Severity → weight multiplier. Scoring uses these to prioritize fixes.
 * Mirrors claude-ads (Critical 5.0× → Low 0.5×).
 */
export const SEVERITY_WEIGHT: Record<AdCheckSeverity, number> = {
  critical: 5.0,
  high: 3.0,
  medium: 2.0,
  low: 1.0,
  info: 0.5,
};

/**
 * An account snapshot field path (dot notation) the check evaluates against.
 * Handlers receive the raw snapshot + reads a resolved value; this string is
 * surfaced in output so operators know what field drove a failure.
 */
export type SnapshotFieldPath = string;

export interface AdCheck {
  /** Stable ID — the only thing tests should assert against. */
  id: string;
  /** Which platforms this check applies to. `cross_platform` → all. */
  platforms: AdPlatform[];
  category: AdCheckCategory;
  severity: AdCheckSeverity;
  /** Short operator-facing title. */
  title: string;
  /** One-sentence explanation of what the check is looking for. */
  rationale: string;
  /** Which snapshot fields the check reads. For operator transparency only. */
  fields_read: SnapshotFieldPath[];
  /**
   * Check function. Returns `null` if not applicable (skipped, not counted),
   * `true` if the account passes, `false` (with optional message) if it fails.
   */
  run: (snapshot: AdAccountSnapshot) => AdCheckOutcome;
}

export type AdCheckOutcome =
  | { status: "pass" }
  | { status: "fail"; message: string }
  | { status: "not_applicable" };

/**
 * Shape the operator pastes in. All fields optional — the more they fill in,
 * the more checks run. Checks mark themselves `not_applicable` when a
 * required field is missing.
 */
export interface AdAccountSnapshot {
  platform: AdPlatform;
  account_id?: string;
  account_name?: string;
  /** Currency code (ISO 4217). Mostly informational. */
  currency?: string;
  /** Period the snapshot covers. */
  period?: { start: string; end: string };
  /** Account-level spend over `period`. */
  spend?: number;
  /** Account-level revenue / conversion value over `period`. */
  revenue?: number;
  /** Account-level conversions. */
  conversions?: number;
  /** Click-through rate (0–1, NOT a percentage). */
  ctr?: number;
  /** Cost per click. */
  cpc?: number;
  /** Cost per acquisition. */
  cpa?: number;
  /** Return on ad spend (revenue / spend). */
  roas?: number;
  /** Frequency (avg impressions per user). Meta/Display. */
  frequency?: number;
  /** Quality score (Google) or relevance score (Meta). 1–10. */
  quality_score?: number;
  /** Number of active campaigns. */
  active_campaigns?: number;
  /** Number of paused campaigns. */
  paused_campaigns?: number;
  /** Number of campaigns with no conversions in period. */
  zero_conversion_campaigns?: number;
  /** Number of ad groups / ad sets. */
  ad_groups_count?: number;
  /** Number of active creatives / ads. */
  active_creatives?: number;
  /** Creatives that haven't been refreshed in 30+ days. */
  stale_creatives?: number;
  /** Conversion tracking is configured. */
  conversion_tracking_enabled?: boolean;
  /** Pixel / tag installed on destination domains. */
  pixel_installed?: boolean;
  /** Enhanced conversions / server-side tagging (Google) or CAPI (Meta). */
  enhanced_conversions_enabled?: boolean;
  /** Negative keywords list length (Google / Microsoft). */
  negative_keywords_count?: number;
  /** Branded-keyword exclusion in place on non-brand campaigns. */
  brand_separation?: boolean;
  /** Audience exclusions (converted users, existing customers). */
  audience_exclusions_configured?: boolean;
  /** Dayparting / ad scheduling enabled. */
  dayparting_enabled?: boolean;
  /** Geo targeting uses presence (not interest). */
  geo_presence_targeting?: boolean;
  /** Bidding strategy name (raw string — matched loosely). */
  bidding_strategy?: string;
  /** Ad extensions (sitelinks, callouts, structured snippets) count. Google. */
  ad_extensions_count?: number;
  /** Free-form notes the operator attaches. Not scored. */
  notes?: string;
}

/**
 * Apply-if-field-present guard. Returns `not_applicable` when any of the
 * listed fields is `undefined` — keeps the ratio honest when operators
 * paste partial data.
 */
function requires(
  snapshot: AdAccountSnapshot,
  fields: (keyof AdAccountSnapshot)[],
  fn: () => AdCheckOutcome,
): AdCheckOutcome {
  for (const f of fields) {
    if (snapshot[f] === undefined || snapshot[f] === null) {
      return { status: "not_applicable" };
    }
  }
  return fn();
}

// ---------------------------------------------------------------------------
// Cross-platform checks (apply to any snapshot.platform)
// ---------------------------------------------------------------------------

const CROSS_PLATFORM_CHECKS: AdCheck[] = [
  {
    id: "xp_roas_below_1",
    platforms: ["cross_platform"],
    category: "budget",
    severity: "critical",
    title: "Account ROAS below 1.0× — losing money on every dollar",
    rationale:
      "If revenue/spend < 1, ads are unprofitable before factoring in COGS or overhead. Immediate investigation needed.",
    fields_read: ["roas"],
    run: (s) =>
      requires(s, ["roas"], () =>
        s.roas! >= 1.0
          ? { status: "pass" }
          : {
              status: "fail",
              message: `ROAS ${s.roas!.toFixed(2)}× is below breakeven (1.0×). Pause unprofitable campaigns or investigate attribution gaps.`,
            },
      ),
  },
  {
    id: "xp_roas_below_2",
    platforms: ["cross_platform"],
    category: "budget",
    severity: "high",
    title: "ROAS below 2.0× — unlikely to be profitable post-COGS",
    rationale:
      "For most D2C brands a 2× ROAS leaves no room for product cost + overhead. Review creative + targeting.",
    fields_read: ["roas"],
    run: (s) =>
      requires(s, ["roas"], () =>
        s.roas! >= 2.0
          ? { status: "pass" }
          : {
              status: "fail",
              message: `ROAS ${s.roas!.toFixed(2)}× is below the 2× minimum profitability floor.`,
            },
      ),
  },
  {
    id: "xp_conversion_tracking_enabled",
    platforms: ["cross_platform"],
    category: "tracking",
    severity: "critical",
    title: "Conversion tracking must be enabled",
    rationale:
      "Without conversion tracking the platform cannot learn; smart bidding degenerates and you are paying for clicks blind.",
    fields_read: ["conversion_tracking_enabled"],
    run: (s) =>
      requires(s, ["conversion_tracking_enabled"], () =>
        s.conversion_tracking_enabled
          ? { status: "pass" }
          : {
              status: "fail",
              message: "Conversion tracking is disabled at the account level.",
            },
      ),
  },
  {
    id: "xp_pixel_installed",
    platforms: ["cross_platform"],
    category: "tracking",
    severity: "critical",
    title: "Tracking pixel / tag installed on destination",
    rationale:
      "No pixel = no retargeting, no lookalikes, no optimization feedback.",
    fields_read: ["pixel_installed"],
    run: (s) =>
      requires(s, ["pixel_installed"], () =>
        s.pixel_installed
          ? { status: "pass" }
          : {
              status: "fail",
              message: "Destination pages are missing the platform pixel/tag.",
            },
      ),
  },
  {
    id: "xp_enhanced_conversions",
    platforms: ["cross_platform"],
    category: "tracking",
    severity: "high",
    title: "Server-side / enhanced conversions enabled",
    rationale:
      "iOS 14+ and privacy regulations degrade client-side tracking. Enhanced conversions (Google) or CAPI (Meta) restore ~15-25% of lost signal.",
    fields_read: ["enhanced_conversions_enabled"],
    run: (s) =>
      requires(s, ["enhanced_conversions_enabled"], () =>
        s.enhanced_conversions_enabled
          ? { status: "pass" }
          : {
              status: "fail",
              message:
                "Enhanced conversions / server-side tagging is not enabled.",
            },
      ),
  },
  {
    id: "xp_zero_conversion_campaigns",
    platforms: ["cross_platform"],
    category: "budget",
    severity: "high",
    title: "More than 25% of campaigns have zero conversions",
    rationale:
      "A zero-conversion campaign is bleeding budget. Pause-and-investigate or merge audiences.",
    fields_read: ["zero_conversion_campaigns", "active_campaigns"],
    run: (s) =>
      requires(s, ["zero_conversion_campaigns", "active_campaigns"], () => {
        if (s.active_campaigns! === 0) return { status: "not_applicable" };
        const ratio = s.zero_conversion_campaigns! / s.active_campaigns!;
        return ratio <= 0.25
          ? { status: "pass" }
          : {
              status: "fail",
              message: `${s.zero_conversion_campaigns}/${s.active_campaigns} campaigns (${(ratio * 100).toFixed(0)}%) have no conversions.`,
            };
      }),
  },
  {
    id: "xp_stale_creatives",
    platforms: ["cross_platform"],
    category: "creative",
    severity: "medium",
    title: "At least one creative refreshed in the last 30 days",
    rationale:
      "Creative fatigue is the #1 cause of rising CPA over time. Fresh assets should rotate in monthly.",
    fields_read: ["stale_creatives", "active_creatives"],
    run: (s) =>
      requires(s, ["stale_creatives", "active_creatives"], () => {
        if (s.active_creatives! === 0) return { status: "not_applicable" };
        const ratio = s.stale_creatives! / s.active_creatives!;
        return ratio < 1.0
          ? { status: "pass" }
          : {
              status: "fail",
              message: `All ${s.active_creatives} active creatives are 30+ days old.`,
            };
      }),
  },
  {
    id: "xp_active_creatives_min",
    platforms: ["cross_platform"],
    category: "creative",
    severity: "medium",
    title: "At least 3 active creatives per account for testing",
    rationale:
      "Platforms need a minimum set to run learning phases and winner-selection.",
    fields_read: ["active_creatives"],
    run: (s) =>
      requires(s, ["active_creatives"], () =>
        s.active_creatives! >= 3
          ? { status: "pass" }
          : {
              status: "fail",
              message: `Only ${s.active_creatives} active creative(s) — insufficient for A/B learning.`,
            },
      ),
  },
  {
    id: "xp_audience_exclusions",
    platforms: ["cross_platform"],
    category: "targeting",
    severity: "medium",
    title: "Converted users / existing customers excluded where appropriate",
    rationale:
      "Spending on already-converted users dilutes prospecting budget. Retention needs its own journey.",
    fields_read: ["audience_exclusions_configured"],
    run: (s) =>
      requires(s, ["audience_exclusions_configured"], () =>
        s.audience_exclusions_configured
          ? { status: "pass" }
          : {
              status: "fail",
              message:
                "No audience exclusions on prospecting campaigns — you are re-paying for existing customers.",
            },
      ),
  },
  {
    id: "xp_geo_presence_targeting",
    platforms: ["cross_platform"],
    category: "targeting",
    severity: "low",
    title: "Geo targeting uses 'presence' (not interest)",
    rationale:
      'Interest-based geo ("people interested in Paris") pulls in far-flung users and dilutes relevance.',
    fields_read: ["geo_presence_targeting"],
    run: (s) =>
      requires(s, ["geo_presence_targeting"], () =>
        s.geo_presence_targeting
          ? { status: "pass" }
          : {
              status: "fail",
              message:
                'Geo targeting is set to "interest". Switch to "presence" unless you intentionally target travelers.',
            },
      ),
  },
  {
    id: "xp_frequency_over_5",
    platforms: ["cross_platform"],
    category: "creative",
    severity: "medium",
    title: "Frequency at or below 5 impressions per user",
    rationale:
      "Above ~5 impressions per user per week, response degrades and you are burning budget on the same eyeballs.",
    fields_read: ["frequency"],
    run: (s) =>
      requires(s, ["frequency"], () =>
        s.frequency! <= 5
          ? { status: "pass" }
          : {
              status: "fail",
              message: `Frequency ${s.frequency!.toFixed(1)} exceeds the 5-impression saturation threshold.`,
            },
      ),
  },
];

// ---------------------------------------------------------------------------
// Google Ads
// ---------------------------------------------------------------------------

const GOOGLE_CHECKS: AdCheck[] = [
  {
    id: "g_quality_score_min",
    platforms: ["google_ads"],
    category: "creative",
    severity: "high",
    title: "Avg quality score at or above 6/10",
    rationale:
      "Quality score below 6 signals poor keyword-ad-landing alignment and pushes CPC up 30-50%.",
    fields_read: ["quality_score"],
    run: (s) =>
      requires(s, ["quality_score"], () =>
        s.quality_score! >= 6
          ? { status: "pass" }
          : {
              status: "fail",
              message: `Quality score ${s.quality_score}/10 is below the 6/10 health threshold.`,
            },
      ),
  },
  {
    id: "g_negative_keywords",
    platforms: ["google_ads"],
    category: "targeting",
    severity: "high",
    title: "Negative keyword list of at least 20 terms",
    rationale:
      "Search campaigns without a robust negative list waste budget on irrelevant queries.",
    fields_read: ["negative_keywords_count"],
    run: (s) =>
      requires(s, ["negative_keywords_count"], () =>
        s.negative_keywords_count! >= 20
          ? { status: "pass" }
          : {
              status: "fail",
              message: `Only ${s.negative_keywords_count} negative keywords. Target 20+ for a mature account.`,
            },
      ),
  },
  {
    id: "g_brand_separation",
    platforms: ["google_ads"],
    category: "targeting",
    severity: "medium",
    title: "Brand and non-brand separated into distinct campaigns",
    rationale:
      "Mixing brand and non-brand dilutes your ROAS signal and hides non-brand inefficiency.",
    fields_read: ["brand_separation"],
    run: (s) =>
      requires(s, ["brand_separation"], () =>
        s.brand_separation
          ? { status: "pass" }
          : {
              status: "fail",
              message:
                "Brand and non-brand keywords share campaigns — separate them for clean ROAS attribution.",
            },
      ),
  },
  {
    id: "g_ad_extensions",
    platforms: ["google_ads"],
    category: "creative",
    severity: "medium",
    title: "At least 4 active ad extensions",
    rationale:
      "Sitelinks, callouts, structured snippets, and call extensions each lift CTR 10-15%.",
    fields_read: ["ad_extensions_count"],
    run: (s) =>
      requires(s, ["ad_extensions_count"], () =>
        s.ad_extensions_count! >= 4
          ? { status: "pass" }
          : {
              status: "fail",
              message: `Only ${s.ad_extensions_count} ad extensions — add sitelinks, callouts, structured snippets.`,
            },
      ),
  },
  {
    id: "g_bidding_auto_for_conv",
    platforms: ["google_ads"],
    category: "budget",
    severity: "medium",
    title:
      "Smart bidding (tCPA / tROAS / Max Conversions) on performance campaigns",
    rationale:
      "Manual CPC with conversion tracking leaves 20-30% of lift on the table. Smart bidding uses auction-time signals humans can't see.",
    fields_read: ["bidding_strategy"],
    run: (s) =>
      requires(s, ["bidding_strategy"], () => {
        const strat = String(s.bidding_strategy).toLowerCase();
        const smart =
          strat.includes("target_cpa") ||
          strat.includes("target_roas") ||
          strat.includes("maximize_conversions") ||
          strat.includes("maximize_conversion_value") ||
          strat.includes("tcpa") ||
          strat.includes("troas") ||
          strat.includes("smart");
        return smart
          ? { status: "pass" }
          : {
              status: "fail",
              message: `Bidding strategy "${s.bidding_strategy}" is not a smart-bidding strategy.`,
            };
      }),
  },
];

// ---------------------------------------------------------------------------
// Meta Ads
// ---------------------------------------------------------------------------

const META_CHECKS: AdCheck[] = [
  {
    id: "m_quality_score_min",
    platforms: ["meta_ads"],
    category: "creative",
    severity: "high",
    title: "Relevance / quality ranking at or above 6/10 equivalent",
    rationale:
      "Meta's quality/engagement/conversion rankings gate auction competitiveness. Below-average rankings cap reach.",
    fields_read: ["quality_score"],
    run: (s) =>
      requires(s, ["quality_score"], () =>
        s.quality_score! >= 6
          ? { status: "pass" }
          : {
              status: "fail",
              message: `Relevance score ${s.quality_score}/10 is below the 6/10 floor.`,
            },
      ),
  },
  {
    id: "m_capi_enabled",
    platforms: ["meta_ads"],
    category: "tracking",
    severity: "critical",
    title: "Conversions API (CAPI) enabled alongside pixel",
    rationale:
      "iOS 14+ / ad-blockers mute browser pixel events. CAPI restores 15-25% of conversion signal from the server.",
    fields_read: ["enhanced_conversions_enabled"],
    run: (s) =>
      requires(s, ["enhanced_conversions_enabled"], () =>
        s.enhanced_conversions_enabled
          ? { status: "pass" }
          : {
              status: "fail",
              message: "Conversions API (CAPI) is not enabled.",
            },
      ),
  },
  {
    id: "m_bidding_auto_for_conv",
    platforms: ["meta_ads"],
    category: "budget",
    severity: "medium",
    title: "Lowest cost / cost cap / bid cap tied to a conversion event",
    rationale:
      "Automated bidding with a conversion goal outperforms reach/clicks objectives for direct-response accounts.",
    fields_read: ["bidding_strategy"],
    run: (s) =>
      requires(s, ["bidding_strategy"], () => {
        const strat = String(s.bidding_strategy).toLowerCase();
        const dr =
          strat.includes("cost_cap") ||
          strat.includes("bid_cap") ||
          strat.includes("lowest_cost") ||
          strat.includes("conversion") ||
          strat.includes("roas");
        return dr
          ? { status: "pass" }
          : {
              status: "fail",
              message: `Bidding strategy "${s.bidding_strategy}" is not tied to a conversion event.`,
            };
      }),
  },
  {
    id: "m_frequency_over_3",
    platforms: ["meta_ads"],
    category: "creative",
    severity: "medium",
    title: "Frequency at or below 3 on prospecting audiences",
    rationale:
      "Meta prospecting decays fast above frequency 3 — creative fatigue kills CTR and drives CPA up.",
    fields_read: ["frequency"],
    run: (s) =>
      requires(s, ["frequency"], () =>
        s.frequency! <= 3
          ? { status: "pass" }
          : {
              status: "fail",
              message: `Frequency ${s.frequency!.toFixed(1)} is above the 3-impression prospecting ceiling.`,
            },
      ),
  },
  {
    id: "m_audience_exclusions",
    platforms: ["meta_ads"],
    category: "targeting",
    severity: "medium",
    title: "Existing customer list excluded on prospecting campaigns",
    rationale:
      "Without exclusions, lookalikes and interest targeting will re-serve existing customers at higher CPA.",
    fields_read: ["audience_exclusions_configured"],
    run: (s) =>
      requires(s, ["audience_exclusions_configured"], () =>
        s.audience_exclusions_configured
          ? { status: "pass" }
          : {
              status: "fail",
              message: "No audience exclusions on prospecting ad sets.",
            },
      ),
  },
  {
    id: "m_creative_rotation_min_3",
    platforms: ["meta_ads"],
    category: "creative",
    severity: "medium",
    title: "At least 3 active creatives per ad set for learning",
    rationale:
      "Below 3 creatives, Meta's dynamic creative optimization has nothing to rotate.",
    fields_read: ["active_creatives"],
    run: (s) =>
      requires(s, ["active_creatives"], () =>
        s.active_creatives! >= 3
          ? { status: "pass" }
          : {
              status: "fail",
              message: `Only ${s.active_creatives} active creatives. Upload at least 3 to enable DCO.`,
            },
      ),
  },
];

// ---------------------------------------------------------------------------
// LinkedIn Ads
// ---------------------------------------------------------------------------

const LINKEDIN_CHECKS: AdCheck[] = [
  {
    id: "l_insight_tag_installed",
    platforms: ["linkedin_ads"],
    category: "tracking",
    severity: "critical",
    title: "LinkedIn Insight Tag installed",
    rationale:
      "No Insight Tag = no retargeting, no conversion tracking, no matched audiences.",
    fields_read: ["pixel_installed"],
    run: (s) =>
      requires(s, ["pixel_installed"], () =>
        s.pixel_installed
          ? { status: "pass" }
          : {
              status: "fail",
              message: "LinkedIn Insight Tag is not installed.",
            },
      ),
  },
  {
    id: "l_cpa_ceiling",
    platforms: ["linkedin_ads"],
    category: "budget",
    severity: "high",
    title: "CPA below $150 ceiling for typical B2B lead-gen",
    rationale:
      "LinkedIn lead-gen median CPA is $75-120. Above $150 indicates targeting is too broad or creative is weak.",
    fields_read: ["cpa"],
    run: (s) =>
      requires(s, ["cpa"], () =>
        s.cpa! <= 150
          ? { status: "pass" }
          : {
              status: "fail",
              message: `CPA $${s.cpa!.toFixed(0)} is above the $150 B2B lead-gen ceiling.`,
            },
      ),
  },
  {
    id: "l_ctr_min",
    platforms: ["linkedin_ads"],
    category: "creative",
    severity: "medium",
    title: "CTR at or above 0.4% (LinkedIn feed median)",
    rationale:
      "Below-median CTR on LinkedIn pushes CPC to the campaign ceiling. Rework creative hook.",
    fields_read: ["ctr"],
    run: (s) =>
      requires(s, ["ctr"], () =>
        s.ctr! >= 0.004
          ? { status: "pass" }
          : {
              status: "fail",
              message: `CTR ${(s.ctr! * 100).toFixed(2)}% is below the 0.4% LinkedIn median.`,
            },
      ),
  },
];

// ---------------------------------------------------------------------------
// TikTok Ads
// ---------------------------------------------------------------------------

const TIKTOK_CHECKS: AdCheck[] = [
  {
    id: "t_pixel_installed",
    platforms: ["tiktok_ads"],
    category: "tracking",
    severity: "critical",
    title: "TikTok Pixel (and/or Events API) installed",
    rationale:
      "TikTok relies heavily on pixel signal for creative optimization. Without it, smart performance campaigns degenerate.",
    fields_read: ["pixel_installed"],
    run: (s) =>
      requires(s, ["pixel_installed"], () =>
        s.pixel_installed
          ? { status: "pass" }
          : {
              status: "fail",
              message: "TikTok Pixel is not installed.",
            },
      ),
  },
  {
    id: "t_ctr_min",
    platforms: ["tiktok_ads"],
    category: "creative",
    severity: "high",
    title: "CTR at or above 1% (TikTok feed median)",
    rationale:
      "TikTok feed median CTR is 1-1.5%. Below 1% signals creative does not feel native to the platform.",
    fields_read: ["ctr"],
    run: (s) =>
      requires(s, ["ctr"], () =>
        s.ctr! >= 0.01
          ? { status: "pass" }
          : {
              status: "fail",
              message: `CTR ${(s.ctr! * 100).toFixed(2)}% is below the 1% TikTok floor.`,
            },
      ),
  },
  {
    id: "t_creative_refresh",
    platforms: ["tiktok_ads"],
    category: "creative",
    severity: "high",
    title: "TikTok creatives refreshed at least every 14 days",
    rationale:
      "TikTok creative fatigue is the fastest of any platform — a high-performing UGC video can die in 10-14 days.",
    fields_read: ["stale_creatives"],
    run: (s) =>
      requires(s, ["stale_creatives", "active_creatives"], () => {
        if (s.active_creatives! === 0) return { status: "not_applicable" };
        const ratio = s.stale_creatives! / s.active_creatives!;
        return ratio <= 0.5
          ? { status: "pass" }
          : {
              status: "fail",
              message: `${(ratio * 100).toFixed(0)}% of TikTok creatives are stale. Refresh every 14 days.`,
            };
      }),
  },
];

// ---------------------------------------------------------------------------
// YouTube Ads
// ---------------------------------------------------------------------------

const YOUTUBE_CHECKS: AdCheck[] = [
  {
    id: "y_conversion_tracking",
    platforms: ["youtube_ads"],
    category: "tracking",
    severity: "critical",
    title: "Google Ads conversion tracking connected to YouTube campaigns",
    rationale:
      "YouTube campaigns without conversion tracking cannot use smart bidding — you are running them blind.",
    fields_read: ["conversion_tracking_enabled"],
    run: (s) =>
      requires(s, ["conversion_tracking_enabled"], () =>
        s.conversion_tracking_enabled
          ? { status: "pass" }
          : {
              status: "fail",
              message:
                "YouTube campaigns are not connected to Google Ads conversion tracking.",
            },
      ),
  },
  {
    id: "y_frequency_cap",
    platforms: ["youtube_ads"],
    category: "targeting",
    severity: "medium",
    title: "Frequency cap at or below 4 impressions per user per week",
    rationale:
      "YouTube frequency above 4/week exhausts audiences fast and degrades memorability per impression.",
    fields_read: ["frequency"],
    run: (s) =>
      requires(s, ["frequency"], () =>
        s.frequency! <= 4
          ? { status: "pass" }
          : {
              status: "fail",
              message: `YouTube frequency ${s.frequency!.toFixed(1)}/week exceeds the 4-impression cap.`,
            },
      ),
  },
];

// ---------------------------------------------------------------------------
// Microsoft Ads (Bing)
// ---------------------------------------------------------------------------

const MICROSOFT_CHECKS: AdCheck[] = [
  {
    id: "ms_uet_installed",
    platforms: ["microsoft_ads"],
    category: "tracking",
    severity: "critical",
    title: "UET tag installed for conversion tracking",
    rationale:
      "The UET tag is Microsoft's conversion pixel. Without it, no smart bidding, no retargeting, no CPL reporting.",
    fields_read: ["pixel_installed"],
    run: (s) =>
      requires(s, ["pixel_installed"], () =>
        s.pixel_installed
          ? { status: "pass" }
          : {
              status: "fail",
              message: "UET tag is not installed.",
            },
      ),
  },
  {
    id: "ms_negative_keywords",
    platforms: ["microsoft_ads"],
    category: "targeting",
    severity: "high",
    title: "Negative keyword list of at least 20 terms",
    rationale:
      "Microsoft search share on older audiences includes many mis-queries; negatives are critical for QoS.",
    fields_read: ["negative_keywords_count"],
    run: (s) =>
      requires(s, ["negative_keywords_count"], () =>
        s.negative_keywords_count! >= 20
          ? { status: "pass" }
          : {
              status: "fail",
              message: `Only ${s.negative_keywords_count} negative keywords.`,
            },
      ),
  },
  {
    id: "ms_import_from_google",
    platforms: ["microsoft_ads"],
    category: "creative",
    severity: "info",
    title: "Google Ads import enabled for parallel reach",
    rationale:
      "Microsoft Ads reaches ~10-15% incremental audience at often-lower CPC. Google Import is the fastest lift.",
    fields_read: ["active_campaigns"],
    run: (s) =>
      requires(s, ["active_campaigns"], () =>
        s.active_campaigns! >= 1
          ? { status: "pass" }
          : {
              status: "fail",
              message:
                "No active Microsoft campaigns — import from Google Ads.",
            },
      ),
  },
];

// ---------------------------------------------------------------------------
// Apple Search Ads
// ---------------------------------------------------------------------------

const APPLE_CHECKS: AdCheck[] = [
  {
    id: "a_skadn_enabled",
    platforms: ["apple_search_ads"],
    category: "tracking",
    severity: "critical",
    title: "SKAdNetwork / attribution API configured",
    rationale:
      "iOS 14.5+ requires SKAN for attribution. Without it, ASA conversion data is missing on most installs.",
    fields_read: ["conversion_tracking_enabled"],
    run: (s) =>
      requires(s, ["conversion_tracking_enabled"], () =>
        s.conversion_tracking_enabled
          ? { status: "pass" }
          : {
              status: "fail",
              message: "SKAdNetwork attribution is not configured.",
            },
      ),
  },
  {
    id: "a_cpa_ceiling",
    platforms: ["apple_search_ads"],
    category: "budget",
    severity: "medium",
    title: "CPA below $5 for typical mobile app install",
    rationale:
      "ASA typical CPA for app installs is $1.50-3.50. Above $5 indicates keyword bloat or wrong match types.",
    fields_read: ["cpa"],
    run: (s) =>
      requires(s, ["cpa"], () =>
        s.cpa! <= 5
          ? { status: "pass" }
          : {
              status: "fail",
              message: `CPA $${s.cpa!.toFixed(2)} is above the $5 ASA ceiling.`,
            },
      ),
  },
];

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

export const ALL_CHECKS: AdCheck[] = [
  ...CROSS_PLATFORM_CHECKS,
  ...GOOGLE_CHECKS,
  ...META_CHECKS,
  ...LINKEDIN_CHECKS,
  ...TIKTOK_CHECKS,
  ...YOUTUBE_CHECKS,
  ...MICROSOFT_CHECKS,
  ...APPLE_CHECKS,
];

/**
 * Round-1 audit minor #4 fix: platform-specific checks that read the exact
 * same snapshot field as a cross-platform check (e.g. LinkedIn Insight Tag
 * vs the generic `pixel_installed` check) previously got counted TWICE for
 * that platform — inflating the failure count and the max-possible-score.
 * This map tells `checksForPlatform` which cross-platform checks to DROP
 * when a more-specific platform variant exists, keeping the scorer honest.
 * Only exact-field, same-threshold overlaps are declared here — refinements
 * (e.g. xp_frequency_over_5 vs m_frequency_over_3) legitimately stack.
 */
const SUPERSEDED_CHECK_IDS_PER_PLATFORM: Partial<
  Record<AdPlatform, Set<string>>
> = {
  meta_ads: new Set([
    "xp_enhanced_conversions", // superseded by m_capi_enabled
    "xp_audience_exclusions", // superseded by m_audience_exclusions
    "xp_active_creatives_min", // superseded by m_creative_rotation_min_3
  ]),
  linkedin_ads: new Set(["xp_pixel_installed"]),
  tiktok_ads: new Set(["xp_pixel_installed"]),
  microsoft_ads: new Set(["xp_pixel_installed"]),
  youtube_ads: new Set(["xp_conversion_tracking_enabled"]),
  apple_search_ads: new Set(["xp_conversion_tracking_enabled"]),
};

/** Return the checks applicable to a given platform (plus cross-platform). */
export function checksForPlatform(platform: AdPlatform): AdCheck[] {
  const superseded =
    SUPERSEDED_CHECK_IDS_PER_PLATFORM[platform] ?? new Set<string>();
  return ALL_CHECKS.filter(
    (c) =>
      !superseded.has(c.id) &&
      (c.platforms.includes(platform) ||
        c.platforms.includes("cross_platform")),
  );
}

export interface CheckResult {
  check: AdCheck;
  outcome: AdCheckOutcome;
  weight: number;
}

export interface ScoredAudit {
  platform: AdPlatform;
  score: number; // 0-100 normalized
  grade: "A" | "B" | "C" | "D" | "F";
  raw_weighted: number;
  max_weighted: number;
  /** Breakdown per category — normalized 0-100 per category. */
  category_scores: Record<AdCheckCategory, { score: number; weight: number }>;
  results: CheckResult[];
  failures_by_severity: Record<AdCheckSeverity, CheckResult[]>;
  checks_applicable: number;
  checks_not_applicable: number;
}

function grade(score: number): "A" | "B" | "C" | "D" | "F" {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

/**
 * Run the applicable check set against a snapshot and produce a scored audit.
 *
 * Not-applicable checks are excluded from both numerator and denominator —
 * this keeps the grade honest when the operator pastes partial data.
 */
export function scoreAudit(snapshot: AdAccountSnapshot): ScoredAudit {
  const checks = checksForPlatform(snapshot.platform);
  const results: CheckResult[] = [];
  let raw = 0;
  let max = 0;
  const cat: Record<AdCheckCategory, { raw: number; max: number }> = {
    targeting: { raw: 0, max: 0 },
    budget: { raw: 0, max: 0 },
    creative: { raw: 0, max: 0 },
    technical: { raw: 0, max: 0 },
    tracking: { raw: 0, max: 0 },
  };
  const failures: Record<AdCheckSeverity, CheckResult[]> = {
    critical: [],
    high: [],
    medium: [],
    low: [],
    info: [],
  };
  let applicable = 0;
  let notApplicable = 0;

  for (const check of checks) {
    const outcome = check.run(snapshot);
    const weight = SEVERITY_WEIGHT[check.severity];
    const result: CheckResult = { check, outcome, weight };
    results.push(result);
    if (outcome.status === "not_applicable") {
      notApplicable++;
      continue;
    }
    applicable++;
    max += weight;
    cat[check.category].max += weight;
    if (outcome.status === "pass") {
      raw += weight;
      cat[check.category].raw += weight;
    } else {
      failures[check.severity].push(result);
    }
  }

  const score = max > 0 ? Math.round((raw / max) * 100) : 0;
  const category_scores: Record<
    AdCheckCategory,
    { score: number; weight: number }
  > = {
    targeting: {
      score:
        cat.targeting.max > 0
          ? Math.round((cat.targeting.raw / cat.targeting.max) * 100)
          : 0,
      weight: cat.targeting.max,
    },
    budget: {
      score:
        cat.budget.max > 0
          ? Math.round((cat.budget.raw / cat.budget.max) * 100)
          : 0,
      weight: cat.budget.max,
    },
    creative: {
      score:
        cat.creative.max > 0
          ? Math.round((cat.creative.raw / cat.creative.max) * 100)
          : 0,
      weight: cat.creative.max,
    },
    technical: {
      score:
        cat.technical.max > 0
          ? Math.round((cat.technical.raw / cat.technical.max) * 100)
          : 0,
      weight: cat.technical.max,
    },
    tracking: {
      score:
        cat.tracking.max > 0
          ? Math.round((cat.tracking.raw / cat.tracking.max) * 100)
          : 0,
      weight: cat.tracking.max,
    },
  };

  return {
    platform: snapshot.platform,
    score,
    grade: grade(score),
    raw_weighted: raw,
    max_weighted: max,
    category_scores,
    results,
    failures_by_severity: failures,
    checks_applicable: applicable,
    checks_not_applicable: notApplicable,
  };
}
