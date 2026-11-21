import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Fail closed: a browser fetch no case set is refused, never started.
vi.mock("../../lib/stealth-browser.js", () => ({
  stealthFetch: vi.fn(async () => {
    throw new Error("unexpected browser fetch in test");
  }),
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
  vi.mocked(stealthFetch).mockReset();
  mockDbRun.mockClear();
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

// A check that observed nothing leads with `error`; what is stored and every
// other key stay as before. A fetched page whose organic list did not parse
// is a degraded result and keeps its shape.
describe("ai_overview_track failure vs. result", () => {
  const BASE = ["query", "present", "sources", "serp_top", "fetch_status"];

  function expectStored(status: string) {
    expect(mockDbRun).toHaveBeenCalledTimes(1);
    expect(mockDbRun).toHaveBeenCalledWith("test", 0, "[]", "[]", status);
  }

  it("an empty fetch → error first, snapshot stored as before", async () => {
    vi.mocked(stealthFetch).mockResolvedValueOnce(null);
    const raw = await aiOverviewTrackTool.execute({ query: "test" });
    expect(raw.startsWith('{"error":"')).toBe(true);
    const r = JSON.parse(raw);
    expect(Object.keys(r)).toEqual(["error", ...BASE, "note"]);
    expect(r).toEqual({
      error: "The stealth fetch returned no page: AI Overview presence was not checked.",
      query: "test",
      present: false,
      sources: [],
      serp_top: [],
      fetch_status: "empty",
      note: "Stealth fetch returned empty. Provision SERP_API_KEY (SerpAPI fallback) for a reliable alternative.",
    });
    expectStored("empty");
  });

  it("an anti-bot page → error first, snapshot stored as before", async () => {
    vi.mocked(stealthFetch).mockResolvedValueOnce({
      content: "<p>Our systems have detected unusual traffic</p>",
      finalUrl: "https://www.google.com/sorry",
      solved: false,
    });
    const raw = await aiOverviewTrackTool.execute({ query: "test" });
    expect(raw.startsWith('{"error":"')).toBe(true);
    const r = JSON.parse(raw);
    expect(Object.keys(r)).toEqual(["error", ...BASE, "note"]);
    expect(r).toEqual({
      error: "Google served an anti-bot interstitial: AI Overview presence was not checked.",
      query: "test",
      present: false,
      sources: [],
      serp_top: [],
      fetch_status: "blocked",
      note: "Google served an anti-bot interstitial. Provision SERP_API_KEY for SerpAPI fallback (follow-up).",
    });
    expectStored("blocked");
  });

  it("the fetch throws → error first from its message, stored status unchanged", async () => {
    vi.mocked(stealthFetch).mockRejectedValueOnce(new Error("navigation timeout"));
    const raw = await aiOverviewTrackTool.execute({ query: "test" });
    expect(raw.startsWith('{"error":"')).toBe(true);
    const r = JSON.parse(raw);
    expect(Object.keys(r)).toEqual(["error", ...BASE, "note", "snapshot_id"]);
    expect(r).toEqual({
      error: "The SERP check failed: navigation timeout",
      query: "test",
      present: false,
      sources: [],
      serp_top: [],
      fetch_status: "parse_error",
      note: "navigation timeout",
      snapshot_id: 1,
    });
    expectStored("parse_error");
  });

  it("the fetch throws with no message → words still complete, note and stored row unchanged", async () => {
    vi.mocked(stealthFetch).mockRejectedValueOnce(new Error(""));
    const raw = await aiOverviewTrackTool.execute({ query: "test" });
    expect(raw.startsWith('{"error":"')).toBe(true);
    const r = JSON.parse(raw);
    expect(Object.keys(r)).toEqual(["error", ...BASE, "note", "snapshot_id"]);
    expect(r.error).toBe("The SERP check failed: no error message");
    expect(r.note).toBe("");
    expectStored("parse_error");
  });

  it("a fetched page with no organic results is unchanged: no error key", async () => {
    vi.mocked(stealthFetch).mockResolvedValueOnce({
      content: `<div data-attrid="AIOverview"><p>Summary</p></div>`,
      finalUrl: "https://www.google.com/search",
      solved: false,
    });
    const r = JSON.parse(await aiOverviewTrackTool.execute({ query: "test" }));
    expect(Object.keys(r)).toEqual([...BASE, "detection_signal", "note", "snapshot_id"]);
    expect(r.fetch_status).toBe("parse_error");
    expect(r.present).toBe(true);
    expect(r.note).toBe(
      "SERP fetched but no organic results parsed — Google DOM may have changed; heuristics need refresh.",
    );
  });

  it("an ok check is unchanged: no error key", async () => {
    vi.mocked(stealthFetch).mockResolvedValueOnce({
      content: `<a href="/url?q=https://example.com/organic"><h3>Organic Result</h3></a>`,
      finalUrl: "https://www.google.com/search",
      solved: false,
    });
    const r = JSON.parse(await aiOverviewTrackTool.execute({ query: "test" }));
    // No panel found: detection_signal is undefined and drops out of the JSON.
    expect(Object.keys(r)).toEqual([...BASE, "snapshot_id"]);
    expect(r.fetch_status).toBe("ok");
    expect(r.present).toBe(false);
  });
});
