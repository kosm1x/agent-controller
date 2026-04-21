import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../lib/stealth-browser.js", () => ({
  stealthFetch: vi.fn(),
}));

const mockDbRun = vi.fn().mockReturnValue({ lastInsertRowid: 1 });
const mockDbPrepare = vi.fn().mockReturnValue({ run: mockDbRun });
vi.mock("../../db/index.js", () => ({
  getDatabase: () => ({ prepare: mockDbPrepare }),
  writeWithRetry: (fn: () => unknown) => fn(),
}));

import { aiOverviewTrackTool, _testonly } from "./ai-overview-track.js";
import { stealthFetch } from "../../lib/stealth-browser.js";

beforeEach(() => {
  vi.restoreAllMocks();
  mockDbRun.mockReturnValue({ lastInsertRowid: 1 });
  mockDbPrepare.mockReturnValue({ run: mockDbRun });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("detectAIOverview", () => {
  it("detects via data-attrid marker", () => {
    const r = _testonly.detectAIOverview(
      `<div data-attrid="AIOverview">...</div>`,
    );
    expect(r.present).toBe(true);
    expect(r.signal).toContain("AIOverview");
  });

  it("detects via visible text label only when structural cue co-occurs", () => {
    // Text alone must NOT trigger — organic snippets mentioning "AI Overview"
    // should never false-positive.
    const textOnly = _testonly.detectAIOverview(
      `<div><h2>AI Overview</h2><p>summary</p></div>`,
    );
    expect(textOnly.present).toBe(false);

    // Text + structural cue (role / jscontroller / data-attrid) triggers.
    const textPlusStructural = _testonly.detectAIOverview(
      `<div role="region"><h2>AI Overview</h2><p>summary</p></div>`,
    );
    expect(textPlusStructural.present).toBe(true);
    expect(textPlusStructural.signal).toContain("proximity+structural");
  });

  it("detects via aria-label marker", () => {
    const r = _testonly.detectAIOverview(
      `<div aria-label="AI Overview"><p>summary</p></div>`,
    );
    expect(r.present).toBe(true);
    expect(r.signal).toContain("aria-label");
  });

  it("returns false when no marker present", () => {
    const r = _testonly.detectAIOverview(
      `<html><body><h1>Just normal SERP</h1></body></html>`,
    );
    expect(r.present).toBe(false);
  });
});

describe("detectBotBlock", () => {
  it("catches unusual traffic page", () => {
    expect(
      _testonly.detectBotBlock(
        "<p>Our systems have detected unusual traffic from your computer network.</p>",
      ),
    ).toBe(true);
  });

  it("catches CAPTCHA title", () => {
    expect(_testonly.detectBotBlock(`<title>Google Captcha</title>`)).toBe(
      true,
    );
  });

  it("returns false for normal SERP", () => {
    expect(
      _testonly.detectBotBlock("<title>query - Google Search</title>"),
    ).toBe(false);
  });
});

describe("extractOrganicResults", () => {
  it("parses Google SERP organic anchors with h3 titles", () => {
    const html = `
<a href="/url?q=https://example.com/page1"><h3>Example Page 1</h3></a>
<a href="/url?q=https://example.org/about"><h3>About Example</h3></a>
<a href="https://www.google.com/ads"><h3>Google Ads</h3></a>
`;
    const results = _testonly.extractOrganicResults(html);
    expect(results).toHaveLength(2); // Google self-links filtered out
    expect(results[0].url).toBe("https://example.com/page1");
    expect(results[0].title).toBe("Example Page 1");
  });

  it("returns empty when no <h3> pattern matches", () => {
    const results = _testonly.extractOrganicResults(
      `<a href="https://example.com">Click here</a>`,
    );
    expect(results).toEqual([]);
  });
});

describe("ai_overview_track execute", () => {
  it("returns blocked status on anti-bot interstitial", async () => {
    vi.mocked(stealthFetch).mockResolvedValue({
      content: "<p>Our systems have detected unusual traffic</p>",
      finalUrl: "https://www.google.com/sorry",
      solved: false,
    });
    const raw = await aiOverviewTrackTool.execute({ query: "test" });
    const out = JSON.parse(raw);
    expect(out.fetch_status).toBe("blocked");
    expect(out.present).toBe(false);
    expect(out.note).toContain("SERP_API_KEY");
  });

  it("returns empty status when stealthFetch returns null", async () => {
    vi.mocked(stealthFetch).mockResolvedValue(null);
    const raw = await aiOverviewTrackTool.execute({ query: "test" });
    const out = JSON.parse(raw);
    expect(out.fetch_status).toBe("empty");
  });

  it("detects AI Overview + populates sources", async () => {
    const html = `
<div data-attrid="AIOverview">
  <p>AI-generated summary here</p>
  <a href="https://source-a.com/article">Source A</a>
  <a href="https://source-b.org/guide">Source B</a>
</div>
<a href="/url?q=https://example.com/organic"><h3>Organic Result</h3></a>
`;
    vi.mocked(stealthFetch).mockResolvedValue({
      content: html,
      finalUrl: "https://www.google.com/search",
      solved: false,
    });
    const raw = await aiOverviewTrackTool.execute({ query: "claude code" });
    const out = JSON.parse(raw);
    expect(out.present).toBe(true);
    expect(out.detection_signal).toContain("AIOverview");
    expect(out.sources.length).toBeGreaterThan(0);
    expect(out.serp_top.length).toBeGreaterThan(0);
  });

  it("requires query parameter", async () => {
    const raw = await aiOverviewTrackTool.execute({});
    expect(raw).toContain("query parameter is required");
  });
});
