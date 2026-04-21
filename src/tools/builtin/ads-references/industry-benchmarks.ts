/**
 * Industry × platform benchmarks — median CPC / CTR / CPA / ROAS.
 *
 * Sources (public):
 *  - WordStream Google Ads Benchmarks by Industry, 2024
 *  - LinkedIn B2B Benchmark Report, 2024
 *  - Meta Ads public benchmark aggregates (AdEspresso, Databox)
 *  - Apple Search Ads / SearchAds.com industry reports
 *
 * Numbers are medians — not hard limits. `ads_audit` uses them to contextualize
 * a campaign's numbers ("your CPA is 2× the retail median for Meta"); it does
 * not score against them directly (only the weighted check framework scores).
 */

export type Industry =
  | "ecommerce"
  | "retail"
  | "b2b_saas"
  | "b2b_services"
  | "legal"
  | "healthcare"
  | "finance_insurance"
  | "real_estate"
  | "education"
  | "travel_hospitality"
  | "automotive"
  | "beauty_fitness"
  | "home_services"
  | "nonprofit"
  | "dining_food"
  | "entertainment";

export type BenchmarkPlatform =
  | "google_search"
  | "google_display"
  | "meta_feed"
  | "linkedin_feed"
  | "tiktok_feed"
  | "youtube_preroll"
  | "microsoft_search"
  | "apple_search_ads";

export interface Benchmark {
  industry: Industry;
  platform: BenchmarkPlatform;
  /** Median cost per click, USD. */
  cpc_median?: number;
  /** Median click-through rate (0-1). */
  ctr_median?: number;
  /** Median cost per acquisition, USD. */
  cpa_median?: number;
  /** Median return on ad spend (revenue / spend). */
  roas_median?: number;
  /** Median conversion rate (0-1). */
  cvr_median?: number;
}

/**
 * Not exhaustive — ~70 rows covering the most commonly-asked combos. Gaps
 * (e.g. Apple Search Ads for legal) are normal; the tool returns "no
 * benchmark available" rather than fabricating.
 */
export const BENCHMARKS: Benchmark[] = [
  // Ecommerce / retail
  {
    industry: "ecommerce",
    platform: "google_search",
    cpc_median: 1.16,
    ctr_median: 0.0376,
    cpa_median: 45.27,
    roas_median: 2.9,
    cvr_median: 0.0258,
  },
  {
    industry: "ecommerce",
    platform: "google_display",
    cpc_median: 0.45,
    ctr_median: 0.0051,
    cpa_median: 65.8,
    cvr_median: 0.0069,
  },
  {
    industry: "ecommerce",
    platform: "meta_feed",
    cpc_median: 0.7,
    ctr_median: 0.0117,
    cpa_median: 40.5,
    roas_median: 2.7,
    cvr_median: 0.0192,
  },
  {
    industry: "ecommerce",
    platform: "tiktok_feed",
    cpc_median: 1.0,
    ctr_median: 0.012,
    cpa_median: 38.0,
    roas_median: 2.4,
  },
  {
    industry: "ecommerce",
    platform: "youtube_preroll",
    cpc_median: 0.44,
    ctr_median: 0.0065,
    cpa_median: 58.0,
  },
  {
    industry: "ecommerce",
    platform: "microsoft_search",
    cpc_median: 0.93,
    ctr_median: 0.028,
    cpa_median: 40.5,
    cvr_median: 0.0231,
  },
  {
    industry: "retail",
    platform: "google_search",
    cpc_median: 1.35,
    ctr_median: 0.0447,
    cpa_median: 42.0,
    cvr_median: 0.031,
  },
  {
    industry: "retail",
    platform: "meta_feed",
    cpc_median: 0.63,
    ctr_median: 0.0129,
    cpa_median: 21.5,
    cvr_median: 0.0355,
  },
  // B2B SaaS / services
  {
    industry: "b2b_saas",
    platform: "google_search",
    cpc_median: 3.33,
    ctr_median: 0.0294,
    cpa_median: 125.0,
    cvr_median: 0.0375,
  },
  {
    industry: "b2b_saas",
    platform: "linkedin_feed",
    cpc_median: 5.26,
    ctr_median: 0.0065,
    cpa_median: 104.0,
    cvr_median: 0.065,
  },
  {
    industry: "b2b_saas",
    platform: "meta_feed",
    cpc_median: 2.0,
    ctr_median: 0.009,
    cpa_median: 90.0,
  },
  {
    industry: "b2b_saas",
    platform: "microsoft_search",
    cpc_median: 2.15,
    ctr_median: 0.0263,
    cpa_median: 85.0,
  },
  {
    industry: "b2b_services",
    platform: "google_search",
    cpc_median: 3.33,
    ctr_median: 0.0294,
    cpa_median: 116.13,
    cvr_median: 0.0345,
  },
  {
    industry: "b2b_services",
    platform: "linkedin_feed",
    cpc_median: 6.4,
    ctr_median: 0.0056,
    cpa_median: 139.0,
  },
  // Legal
  {
    industry: "legal",
    platform: "google_search",
    cpc_median: 6.75,
    ctr_median: 0.0369,
    cpa_median: 73.7,
    cvr_median: 0.0703,
  },
  {
    industry: "legal",
    platform: "meta_feed",
    cpc_median: 1.32,
    ctr_median: 0.0145,
    cpa_median: 28.7,
  },
  {
    industry: "legal",
    platform: "microsoft_search",
    cpc_median: 4.37,
    ctr_median: 0.0251,
    cpa_median: 64.0,
  },
  // Healthcare
  {
    industry: "healthcare",
    platform: "google_search",
    cpc_median: 2.62,
    ctr_median: 0.0346,
    cpa_median: 78.09,
    cvr_median: 0.0361,
  },
  {
    industry: "healthcare",
    platform: "meta_feed",
    cpc_median: 1.32,
    ctr_median: 0.0083,
    cpa_median: 12.31,
    cvr_median: 0.11,
  },
  {
    industry: "healthcare",
    platform: "linkedin_feed",
    cpc_median: 5.8,
    ctr_median: 0.0051,
  },
  // Finance / insurance
  {
    industry: "finance_insurance",
    platform: "google_search",
    cpc_median: 3.44,
    ctr_median: 0.0286,
    cpa_median: 81.93,
    cvr_median: 0.053,
  },
  {
    industry: "finance_insurance",
    platform: "meta_feed",
    cpc_median: 3.77,
    ctr_median: 0.0056,
    cpa_median: 61.0,
    cvr_median: 0.0919,
  },
  {
    industry: "finance_insurance",
    platform: "linkedin_feed",
    cpc_median: 6.0,
    ctr_median: 0.006,
    cpa_median: 120.0,
  },
  // Real estate
  {
    industry: "real_estate",
    platform: "google_search",
    cpc_median: 2.37,
    ctr_median: 0.0347,
    cpa_median: 116.61,
    cvr_median: 0.0247,
  },
  {
    industry: "real_estate",
    platform: "meta_feed",
    cpc_median: 1.81,
    ctr_median: 0.0099,
    cpa_median: 16.92,
    cvr_median: 0.1068,
  },
  // Education
  {
    industry: "education",
    platform: "google_search",
    cpc_median: 2.4,
    ctr_median: 0.039,
    cpa_median: 72.7,
    cvr_median: 0.039,
  },
  {
    industry: "education",
    platform: "meta_feed",
    cpc_median: 1.06,
    ctr_median: 0.0073,
    cpa_median: 7.85,
    cvr_median: 0.135,
  },
  {
    industry: "education",
    platform: "linkedin_feed",
    cpc_median: 5.27,
    ctr_median: 0.008,
  },
  // Travel
  {
    industry: "travel_hospitality",
    platform: "google_search",
    cpc_median: 1.53,
    ctr_median: 0.0468,
    cpa_median: 44.73,
    cvr_median: 0.0342,
  },
  {
    industry: "travel_hospitality",
    platform: "meta_feed",
    cpc_median: 0.63,
    ctr_median: 0.009,
    cpa_median: 22.5,
    cvr_median: 0.028,
  },
  {
    industry: "travel_hospitality",
    platform: "tiktok_feed",
    cpc_median: 0.75,
    ctr_median: 0.014,
    cpa_median: 18.5,
  },
  // Automotive
  {
    industry: "automotive",
    platform: "google_search",
    cpc_median: 2.46,
    ctr_median: 0.0419,
    cpa_median: 33.52,
    cvr_median: 0.0674,
  },
  {
    industry: "automotive",
    platform: "meta_feed",
    cpc_median: 2.24,
    ctr_median: 0.008,
    cpa_median: 43.8,
    cvr_median: 0.0511,
  },
  // Beauty / fitness
  {
    industry: "beauty_fitness",
    platform: "google_search",
    cpc_median: 1.55,
    ctr_median: 0.0317,
    cpa_median: 38.5,
    cvr_median: 0.0297,
  },
  {
    industry: "beauty_fitness",
    platform: "meta_feed",
    cpc_median: 1.81,
    ctr_median: 0.0116,
    cpa_median: 38.8,
    cvr_median: 0.0726,
  },
  {
    industry: "beauty_fitness",
    platform: "tiktok_feed",
    cpc_median: 0.89,
    ctr_median: 0.015,
    cpa_median: 25.0,
  },
  // Home services
  {
    industry: "home_services",
    platform: "google_search",
    cpc_median: 6.4,
    ctr_median: 0.0374,
    cpa_median: 90.2,
    cvr_median: 0.0684,
  },
  {
    industry: "home_services",
    platform: "meta_feed",
    cpc_median: 2.93,
    ctr_median: 0.008,
    cpa_median: 28.97,
    cvr_median: 0.066,
  },
  // Nonprofit
  {
    industry: "nonprofit",
    platform: "google_search",
    cpc_median: 1.59,
    ctr_median: 0.0486,
    cpa_median: 30.54,
    cvr_median: 0.01,
  },
  {
    industry: "nonprofit",
    platform: "meta_feed",
    cpc_median: 0.43,
    ctr_median: 0.0119,
    cpa_median: 31.19,
    cvr_median: 0.0139,
  },
  // Dining
  {
    industry: "dining_food",
    platform: "google_search",
    cpc_median: 1.95,
    ctr_median: 0.0575,
    cpa_median: 26.5,
  },
  {
    industry: "dining_food",
    platform: "meta_feed",
    cpc_median: 0.42,
    ctr_median: 0.0124,
    cpa_median: 18.4,
  },
  // Entertainment
  {
    industry: "entertainment",
    platform: "google_search",
    cpc_median: 1.55,
    ctr_median: 0.0629,
    cpa_median: 41.2,
    cvr_median: 0.0231,
  },
  {
    industry: "entertainment",
    platform: "meta_feed",
    cpc_median: 0.38,
    ctr_median: 0.015,
    cpa_median: 12.5,
    cvr_median: 0.051,
  },
  // Apple Search Ads — limited industry coverage
  {
    industry: "ecommerce",
    platform: "apple_search_ads",
    cpc_median: 1.2,
    cpa_median: 3.5,
    ctr_median: 0.045,
  },
  {
    industry: "entertainment",
    platform: "apple_search_ads",
    cpc_median: 0.5,
    cpa_median: 1.8,
    ctr_median: 0.06,
  },
];

/** Lookup helper — returns null if no benchmark exists for that combo. */
export function lookupBenchmark(
  industry: Industry,
  platform: BenchmarkPlatform,
): Benchmark | null {
  return (
    BENCHMARKS.find(
      (b) => b.industry === industry && b.platform === platform,
    ) ?? null
  );
}

/** Which industries have at least one benchmark on `platform`. */
export function industriesWithBenchmark(
  platform: BenchmarkPlatform,
): Industry[] {
  const set = new Set<Industry>();
  for (const b of BENCHMARKS) if (b.platform === platform) set.add(b.industry);
  return [...set];
}

export const ALL_INDUSTRIES: Industry[] = [
  "ecommerce",
  "retail",
  "b2b_saas",
  "b2b_services",
  "legal",
  "healthcare",
  "finance_insurance",
  "real_estate",
  "education",
  "travel_hospitality",
  "automotive",
  "beauty_fitness",
  "home_services",
  "nonprofit",
  "dining_food",
  "entertainment",
];
