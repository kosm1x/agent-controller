import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../lib/url-safety.js", () => ({
  validateOutboundUrl: vi.fn(),
}));

import { seoLlmsTxtGenerateTool, _testonly } from "./seo-llms-txt-generate.js";

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("parseSitemap", () => {
  it("extracts URLs from a flat sitemap", () => {
    const body = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/a</loc></url>
  <url><loc>https://example.com/b</loc></url>
</urlset>`;
    const parsed = _testonly.parseSitemap(body);
    expect(parsed.urls).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
    expect(parsed.nestedSitemaps).toEqual([]);
  });

  it("extracts nested sitemap references from an index", () => {
    const body = `<sitemapindex>
  <sitemap><loc>https://example.com/sitemap1.xml</loc></sitemap>
  <sitemap><loc>https://example.com/sitemap2.xml</loc></sitemap>
</sitemapindex>`;
    const parsed = _testonly.parseSitemap(body);
    expect(parsed.nestedSitemaps).toEqual([
      "https://example.com/sitemap1.xml",
      "https://example.com/sitemap2.xml",
    ]);
    expect(parsed.urls).toEqual([]);
  });
});

describe("sitemapsFromRobots", () => {
  it("extracts Sitemap: directives", () => {
    const body = `User-agent: *
Disallow: /private/

Sitemap: https://example.com/sitemap.xml
# comment
Sitemap: https://example.com/sitemap-news.xml`;
    expect(_testonly.sitemapsFromRobots(body)).toEqual([
      "https://example.com/sitemap.xml",
      "https://example.com/sitemap-news.xml",
    ]);
  });
});

describe("clusterByPath", () => {
  it("clusters URLs by first path segment", () => {
    const clusters = _testonly.clusterByPath(
      [
        "https://example.com/",
        "https://example.com/blog/a",
        "https://example.com/blog/b",
        "https://example.com/products/x",
      ],
      "https://example.com",
    );
    expect(clusters.get("Home")).toEqual(["https://example.com/"]);
    expect(clusters.get("blog")).toHaveLength(2);
    expect(clusters.get("products")).toEqual([
      "https://example.com/products/x",
    ]);
  });

  it("filters out URLs from other origins", () => {
    const clusters = _testonly.clusterByPath(
      ["https://example.com/a", "https://other.com/b"],
      "https://example.com",
    );
    expect(clusters.size).toBe(1);
  });
});

describe("buildMarkdown", () => {
  it("produces llmstxt.org-compliant structure", () => {
    const clusters = new Map<string, string[]>([
      ["Home", ["https://example.com/"]],
      [
        "blog",
        ["https://example.com/blog/post-a", "https://example.com/blog/post-b"],
      ],
    ]);
    const md = _testonly.buildMarkdown(
      "https://example.com",
      { title: "Example Inc.", summary: "We do stuff." },
      clusters,
    );
    expect(md).toMatch(/^# Example Inc\./);
    expect(md).toContain("> We do stuff.");
    expect(md).toContain("## Home");
    expect(md).toContain("## Blog");
    expect(md).toContain("(https://example.com/blog/post-a)");
  });

  it("falls back to hostname + generic summary when meta missing", () => {
    const md = _testonly.buildMarkdown(
      "https://example.com",
      {},
      new Map([["Home", ["https://example.com/"]]]),
    );
    expect(md).toContain("# example.com");
    expect(md).toContain("Site map for example.com");
  });
});

describe("seo_llms_txt_generate execute", () => {
  it("returns markdown with warnings when sitemap not found", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 })),
    );
    const raw = await seoLlmsTxtGenerateTool.execute({
      url: "https://example.com/",
    });
    const out = JSON.parse(raw);
    expect(out.url_count).toBe(0);
    expect(out.markdown).toContain("No sitemap discovered");
  });

  it("rejects invalid URL", async () => {
    const raw = await seoLlmsTxtGenerateTool.execute({ url: "bogus" });
    expect(raw).toContain("Invalid URL");
  });

  it("blocks recursive sitemap redirect to internal host (threat model)", async () => {
    // Threat: attacker-controlled robots.txt serves `Sitemap: http://localhost/secret`.
    // The tool must block the internal URL at fetchText's validator gate, NOT at
    // the initial URL check (which was for the operator's legit domain).
    const { validateOutboundUrl } = await import("../../lib/url-safety.js");
    vi.mocked(validateOutboundUrl).mockImplementation((url: string) => {
      if (url.includes("localhost") || url.includes("127.0.0.1")) {
        return "Blocked private/reserved IP: 127.0.0.1";
      }
      return null;
    });
    let fetchCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        fetchCalls.push(url);
        if (url.endsWith("/robots.txt")) {
          return new Response(
            `User-agent: *\nDisallow:\nSitemap: http://localhost/internal-sitemap.xml\n`,
            { status: 200 },
          );
        }
        return new Response("", { status: 404 });
      }),
    );
    await seoLlmsTxtGenerateTool.execute({
      url: "https://example.com/",
    });
    // The attacker-controlled localhost URL must NEVER have been fetched.
    expect(fetchCalls.some((u) => u.includes("localhost"))).toBe(false);
    // The legit robots.txt + fallback sitemaps WERE fetched.
    expect(fetchCalls.some((u) => u.endsWith("/robots.txt"))).toBe(true);
  });
});
