/**
 * Tests for ads_creative_gen — framework/validation, brief loading, variant persistence.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initDatabase, closeDatabase, getDatabase } from "../../db/index.js";

const mockInfer = vi.fn();
vi.mock("../../inference/adapter.js", () => ({
  infer: (...args: unknown[]) => mockInfer(...args),
}));

import { adsCreativeGenTool } from "./ads-creative-gen.js";

beforeEach(() => {
  initDatabase(":memory:");
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS ads_brand_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      source_url TEXT,
      brand_name TEXT,
      profile TEXT,
      raw_source_preview TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS ads_creatives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_name TEXT NOT NULL,
      framework TEXT NOT NULL,
      platform TEXT NOT NULL,
      objective TEXT NOT NULL,
      brief_id INTEGER,
      variants TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  mockInfer.mockReset();
});
afterEach(() => {
  closeDatabase();
  vi.restoreAllMocks();
});

describe("ads_creative_gen", () => {
  it("rejects unknown framework", async () => {
    const out = JSON.parse(
      await adsCreativeGenTool.execute({
        offer: "x",
        objective: "conversions",
        platform: "meta_feed",
        framework: "BOGUS",
        brand: "b",
        audience: "a",
      }),
    );
    expect(out.error).toMatch(/framework must be one of/);
  });

  it("rejects unknown platform", async () => {
    const out = JSON.parse(
      await adsCreativeGenTool.execute({
        offer: "x",
        objective: "conversions",
        platform: "radio_ads",
        framework: "AIDA",
        brand: "b",
        audience: "a",
      }),
    );
    expect(out.error).toMatch(/platform must be one of/);
  });

  it("requires brand + audience when brief_id is absent", async () => {
    const out = JSON.parse(
      await adsCreativeGenTool.execute({
        offer: "x",
        objective: "conversions",
        platform: "meta_feed",
        framework: "AIDA",
      }),
    );
    expect(out.error).toMatch(/(brand|audience)/);
  });

  it("generates variants with inline brand/audience", async () => {
    mockInfer.mockResolvedValue({
      content: JSON.stringify({
        variants: [
          {
            headline: "Ship 2x faster",
            body: "Crisp Co helps founders skip the yak shave.",
            cta: "Try free",
            framework_sections: {
              attention: "Ship 2x faster",
              interest: "Skip the yak shave",
              desire: "Founders using Crisp ship weekly",
              action: "Try free",
            },
          },
          {
            headline: "Momentum, on tap",
            body: "Crisp's daily flow cuts hours of setup.",
            cta: "Get started",
          },
        ],
      }),
    });
    const out = JSON.parse(
      await adsCreativeGenTool.execute({
        brand: "Crisp Co",
        audience: "SaaS founders",
        offer: "A dev-ops automation tool, $49/mo",
        objective: "conversions",
        platform: "meta_feed",
        framework: "AIDA",
        n_variants: 2,
      }),
    );
    expect(out.n_variants).toBe(2);
    expect(out.variants[0].headline).toBe("Ship 2x faster");
    expect(out.creative_set_id).toBeGreaterThan(0);
  });

  it("loads brand + voice cues from a stored brief_id", async () => {
    const db = getDatabase();
    const profile = {
      voice: { descriptor: "Confident, warm" },
      audience_hints: ["solo operators", "indie hackers"],
      keywords_lexicon: ["ship", "momentum"],
      avoid_lexicon: ["synergy"],
    };
    const info = db
      .prepare(
        "INSERT INTO ads_brand_profiles (domain, brand_name, profile) VALUES (?, ?, ?)",
      )
      .run("crisp.co", "Crisp Co", JSON.stringify(profile));
    const briefId = Number(info.lastInsertRowid);

    mockInfer.mockResolvedValue({
      content: JSON.stringify({
        variants: [
          {
            headline: "Momentum starts here",
            body: "Ship faster with Crisp.",
            cta: "Try now",
          },
        ],
      }),
    });

    const out = JSON.parse(
      await adsCreativeGenTool.execute({
        brief_id: briefId,
        offer: "A dev-ops tool, $49/mo",
        objective: "conversions",
        platform: "meta_feed",
        framework: "PAS",
      }),
    );
    expect(out.brand).toBe("Crisp Co");
    expect(out.brief_id).toBe(briefId);

    // The LLM prompt must include the voice descriptor and lexicons.
    const call = mockInfer.mock.calls[0][0];
    const userMsg = call.messages.find(
      (m: { role: string }) => m.role === "user",
    );
    expect(userMsg.content).toMatch(/Confident, warm/);
    expect(userMsg.content).toMatch(/ship.*momentum/i);
    expect(userMsg.content).toMatch(/synergy/);
  });

  it("clamps n_variants to 1-5", async () => {
    mockInfer.mockResolvedValue({
      content: JSON.stringify({
        variants: Array.from({ length: 5 }, (_, i) => ({
          headline: `h${i}`,
          body: `b${i}`,
          cta: "go",
        })),
      }),
    });
    const out = JSON.parse(
      await adsCreativeGenTool.execute({
        brand: "X",
        audience: "Y",
        offer: "z",
        objective: "conversions",
        platform: "meta_feed",
        framework: "AIDA",
        n_variants: 100,
      }),
    );
    const call = mockInfer.mock.calls[0][0];
    const userMsg = call.messages.find(
      (m: { role: string }) => m.role === "user",
    );
    expect(userMsg.content).toMatch(/Produce 5 distinct variants/);
    expect(out.n_variants).toBe(5);
  });

  it("returns error when LLM output has no parsable variants", async () => {
    mockInfer.mockResolvedValue({ content: "not json" });
    const out = JSON.parse(
      await adsCreativeGenTool.execute({
        brand: "X",
        audience: "Y",
        offer: "z",
        objective: "conversions",
        platform: "meta_feed",
        framework: "AIDA",
      }),
    );
    expect(out.error).toMatch(/LLM|variants|failed/i);
  });
});
