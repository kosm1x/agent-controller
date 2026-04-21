/**
 * Tests for ads_audit — check framework scoring, persistence, benchmark context.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDatabase, closeDatabase, getDatabase } from "../../db/index.js";

import { adsAuditTool } from "./ads-audit.js";
import {
  scoreAudit,
  checksForPlatform,
  ALL_CHECKS,
  type AdAccountSnapshot,
} from "./ads-references/checks-framework.js";

describe("ads_audit", () => {
  beforeEach(() => {
    initDatabase(":memory:");
  });
  afterEach(() => {
    closeDatabase();
  });

  it("rejects invalid platform", async () => {
    const out = JSON.parse(
      await adsAuditTool.execute({
        platform: "tv_ads",
        account_name: "x",
        snapshot: {},
      }),
    );
    expect(out.error).toMatch(/platform must be one of/);
  });

  it("rejects missing account_name", async () => {
    const out = JSON.parse(
      await adsAuditTool.execute({
        platform: "google_ads",
        snapshot: {},
      }),
    );
    expect(out.error).toMatch(/account_name/);
  });

  it("scores a healthy Google Ads snapshot highly", async () => {
    const snapshot = {
      conversion_tracking_enabled: true,
      pixel_installed: true,
      enhanced_conversions_enabled: true,
      quality_score: 8,
      negative_keywords_count: 40,
      brand_separation: true,
      ad_extensions_count: 6,
      bidding_strategy: "target_cpa",
      roas: 4.5,
      ctr: 0.05,
      active_creatives: 5,
      stale_creatives: 1,
      audience_exclusions_configured: true,
      geo_presence_targeting: true,
      frequency: 2.5,
      zero_conversion_campaigns: 0,
      active_campaigns: 10,
    };
    const out = JSON.parse(
      await adsAuditTool.execute({
        platform: "google_ads",
        account_name: "ACME Search",
        snapshot,
      }),
    );
    expect(out.score).toBeGreaterThanOrEqual(90);
    expect(out.grade).toBe("A");
    expect(out.findings.priorities).toEqual([]);
  });

  it("scores a broken Meta snapshot low and reports criticals first", async () => {
    const snapshot = {
      conversion_tracking_enabled: false,
      pixel_installed: false,
      enhanced_conversions_enabled: false,
      roas: 0.5,
      frequency: 7,
      active_creatives: 1,
      stale_creatives: 1,
    };
    const out = JSON.parse(
      await adsAuditTool.execute({
        platform: "meta_ads",
        account_name: "Struggle Co",
        snapshot,
      }),
    );
    expect(out.score).toBeLessThan(40);
    expect(["D", "F"]).toContain(out.grade);
    const sev = out.findings.priorities.map(
      (p: { severity: string }) => p.severity,
    );
    // Criticals must come before lower-severity items.
    const firstLow = sev.findIndex((s: string) => s !== "critical");
    const lastCritical = sev.lastIndexOf("critical");
    if (firstLow !== -1) {
      expect(lastCritical).toBeLessThan(firstLow);
    }
    const critIds = out.findings.priorities
      .filter((p: { severity: string }) => p.severity === "critical")
      .map((p: { id: string }) => p.id);
    expect(critIds).toContain("xp_conversion_tracking_enabled");
    expect(critIds).toContain("xp_pixel_installed");
  });

  it("excludes not-applicable checks from the denominator", async () => {
    // Empty snapshot → every check is not_applicable → score should be 0/0 → 0
    // but must not throw or return NaN.
    const out = JSON.parse(
      await adsAuditTool.execute({
        platform: "google_ads",
        account_name: "Partial",
        snapshot: {},
      }),
    );
    expect(out.meta.checks_applicable).toBe(0);
    expect(out.meta.checks_not_applicable).toBeGreaterThan(0);
    expect(out.score).toBe(0);
    expect(out.grade).toBe("F");
  });

  it("persists to ads_audits when the schema exists", async () => {
    const db = getDatabase();
    db.exec(`
      CREATE TABLE IF NOT EXISTS ads_audits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_name TEXT NOT NULL,
        platform TEXT NOT NULL,
        score INTEGER,
        grade TEXT,
        raw_weighted REAL,
        max_weighted REAL,
        findings TEXT,
        snapshot TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    const out = JSON.parse(
      await adsAuditTool.execute({
        platform: "google_ads",
        account_name: "Persist Test",
        snapshot: {
          conversion_tracking_enabled: true,
          pixel_installed: true,
          roas: 3.0,
        },
      }),
    );
    expect(out.audit_id).toBeGreaterThan(0);
    const row = db
      .prepare(
        "SELECT account_name, platform, grade FROM ads_audits WHERE id = ?",
      )
      .get(out.audit_id) as {
      account_name: string;
      platform: string;
      grade: string;
    };
    expect(row.account_name).toBe("Persist Test");
    expect(row.platform).toBe("google_ads");
    expect(row.grade).toMatch(/^[A-F]$/);
  });

  it("appends benchmark notes when industry is provided", async () => {
    const snapshot: Partial<AdAccountSnapshot> = {
      conversion_tracking_enabled: true,
      pixel_installed: true,
      roas: 2.0,
      ctr: 0.01, // below ecommerce google_search median of 3.76%
      cpa: 120, // far above ecommerce/google median of $45.27
    };
    const out = JSON.parse(
      await adsAuditTool.execute({
        platform: "google_ads",
        account_name: "Benchmark Co",
        snapshot,
        industry: "ecommerce",
      }),
    );
    expect(out.benchmark_notes.length).toBeGreaterThan(0);
    expect(out.benchmark_notes.join(" ")).toMatch(/(median|below|above|×)/i);
  });

  it("checksForPlatform includes cross_platform + platform-specific", () => {
    const google = checksForPlatform("google_ads");
    const meta = checksForPlatform("meta_ads");
    // Both lists include cross-platform + their own.
    expect(google.some((c) => c.platforms.includes("cross_platform"))).toBe(
      true,
    );
    expect(google.some((c) => c.platforms.includes("google_ads"))).toBe(true);
    expect(meta.some((c) => c.platforms.includes("meta_ads"))).toBe(true);
    // But google list does not include meta-specific.
    expect(
      google.some(
        (c) =>
          c.platforms.includes("meta_ads") &&
          !c.platforms.includes("cross_platform"),
      ),
    ).toBe(false);
  });

  it("scoreAudit returns deterministic categories", () => {
    const scored = scoreAudit({
      platform: "meta_ads",
      conversion_tracking_enabled: true,
      pixel_installed: true,
    });
    expect(scored.category_scores).toHaveProperty("tracking");
    expect(scored.category_scores).toHaveProperty("budget");
    expect(scored.category_scores).toHaveProperty("creative");
    expect(scored.category_scores).toHaveProperty("targeting");
    expect(scored.category_scores).toHaveProperty("technical");
  });

  it("all check IDs are unique", () => {
    const ids = ALL_CHECKS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("suppresses duplicate cross-platform checks on platforms with specific variants (round-1 MINOR)", () => {
    // xp_pixel_installed must be absent on platforms whose specific variants
    // already cover it. Keep on google_ads/meta_ads where there is no
    // platform-specific pixel check (m_capi_enabled checks a different field).
    for (const p of ["linkedin_ads", "tiktok_ads", "microsoft_ads"] as const) {
      expect(
        checksForPlatform(p).some((c) => c.id === "xp_pixel_installed"),
      ).toBe(false);
    }
    expect(
      checksForPlatform("meta_ads").some((c) => c.id === "xp_pixel_installed"),
    ).toBe(true);
    expect(
      checksForPlatform("google_ads").some(
        (c) => c.id === "xp_pixel_installed",
      ),
    ).toBe(true);

    // xp_conversion_tracking_enabled: superseded on youtube_ads / apple_search_ads
    for (const p of ["youtube_ads", "apple_search_ads"] as const) {
      expect(
        checksForPlatform(p).some(
          (c) => c.id === "xp_conversion_tracking_enabled",
        ),
      ).toBe(false);
    }
    expect(
      checksForPlatform("google_ads").some(
        (c) => c.id === "xp_conversion_tracking_enabled",
      ),
    ).toBe(true);

    // Meta supersedes three cross-platform checks.
    const metaIds = new Set(checksForPlatform("meta_ads").map((c) => c.id));
    expect(metaIds.has("xp_enhanced_conversions")).toBe(false);
    expect(metaIds.has("xp_audience_exclusions")).toBe(false);
    expect(metaIds.has("xp_active_creatives_min")).toBe(false);
    // But the platform-specific replacements ARE present.
    expect(metaIds.has("m_capi_enabled")).toBe(true);
    expect(metaIds.has("m_audience_exclusions")).toBe(true);
    expect(metaIds.has("m_creative_rotation_min_3")).toBe(true);
  });
});
