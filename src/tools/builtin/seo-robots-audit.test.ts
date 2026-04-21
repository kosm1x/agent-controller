import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../lib/url-safety.js", () => ({
  validateOutboundUrl: vi.fn(),
}));

import { seoRobotsAuditTool, _testonly } from "./seo-robots-audit.js";

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseRobotsTxt", () => {
  it("groups User-agent blocks correctly", () => {
    const groups = _testonly.parseRobotsTxt(
      `User-agent: GPTBot
Disallow: /

User-agent: *
Allow: /
Disallow: /private/`,
    );
    expect(groups).toHaveLength(2);
    expect(groups[0].userAgents).toEqual(["GPTBot"]);
    expect(groups[0].disallow).toEqual(["/"]);
    expect(groups[1].userAgents).toEqual(["*"]);
    expect(groups[1].allow).toEqual(["/"]);
    expect(groups[1].disallow).toEqual(["/private/"]);
  });

  it("merges consecutive User-agent lines into one group", () => {
    const groups = _testonly.parseRobotsTxt(
      `User-agent: GPTBot
User-agent: ClaudeBot
Disallow: /`,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].userAgents).toEqual(["GPTBot", "ClaudeBot"]);
    expect(groups[0].disallow).toEqual(["/"]);
  });

  it("strips comments", () => {
    const groups = _testonly.parseRobotsTxt(
      `User-agent: GPTBot  # AI bot
Disallow: /  # block everything`,
    );
    expect(groups[0].disallow).toEqual(["/"]);
  });
});

describe("seo_robots_audit execute", () => {
  it("classifies 404 robots.txt as all bots allowed + warning", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Not Found", { status: 404 })),
    );
    const raw = await seoRobotsAuditTool.execute({
      url: "https://example.com/",
    });
    const out = JSON.parse(raw);
    expect(out.fetched).toBe(true);
    expect(out.disallowed).toHaveLength(0);
    expect(out.unmentioned).toHaveLength(0);
    expect(out.allowed.length).toBeGreaterThan(0);
    expect(out.warnings.some((w: string) => /No robots\.txt/i.test(w))).toBe(
      true,
    );
    vi.unstubAllGlobals();
  });

  it("detects GPTBot-blocked + Google-Extended-open contradiction warning", async () => {
    const body = `User-agent: GPTBot
Disallow: /

User-agent: *
Allow: /`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200 })),
    );
    const raw = await seoRobotsAuditTool.execute({
      url: "https://example.com/",
    });
    const out = JSON.parse(raw);
    expect(
      out.disallowed.some((b: { name: string }) => b.name === "GPTBot"),
    ).toBe(true);
    const gExt = out.allowed.find(
      (b: { name: string }) => b.name === "Google-Extended",
    );
    expect(gExt).toBeTruthy();
    expect(
      out.warnings.some((w: string) =>
        /GPTBot.*blocked.*Google-Extended/i.test(w),
      ),
    ).toBe(true);
    vi.unstubAllGlobals();
  });

  it("rejects invalid URL", async () => {
    const raw = await seoRobotsAuditTool.execute({ url: "not-a-url" });
    expect(raw).toContain("Invalid URL");
  });

  it("requires url parameter", async () => {
    const raw = await seoRobotsAuditTool.execute({});
    expect(raw).toContain("url parameter is required");
  });

  it("rejects SSRF-unsafe URLs via validateOutboundUrl", async () => {
    const { validateOutboundUrl } = await import("../../lib/url-safety.js");
    vi.mocked(validateOutboundUrl).mockReturnValueOnce(
      "Blocked cloud metadata endpoint",
    );
    const raw = await seoRobotsAuditTool.execute({
      url: "http://169.254.169.254/",
    });
    expect(raw).toContain("URL rejected");
    expect(raw).toContain("metadata");
  });
});
