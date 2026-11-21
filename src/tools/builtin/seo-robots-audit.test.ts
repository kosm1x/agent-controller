import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../lib/url-safety.js", () => ({
  validateOutboundUrl: vi.fn(),
  // safeFetch delegates to the (stubbed) global fetch here — the connect-time
  // SSRF guard itself is covered in url-safety.test.ts.
  safeFetch: (...args: Parameters<typeof fetch>) => fetch(...args),
}));

import { seoRobotsAuditTool, _testonly } from "./seo-robots-audit.js";
import { AI_BOTS } from "./ai-bots.js";

beforeEach(() => {
  vi.restoreAllMocks();
  // Fail closed: a request no case stubbed is refused, never sent.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("unexpected request in test");
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

// robots.txt that could not be read is a failure and leads with `error`;
// a 404 is a complete audit (everything allowed) and keeps its shape.
describe("seo_robots_audit failure vs. audit", () => {
  const AUDIT_KEYS = ["origin", "fetched", "total_bots_checked", "allowed", "disallowed", "unmentioned", "warnings"];

  function answer(status: number, body: string) {
    const f = vi.fn(async () => new Response(body, { status }));
    vi.stubGlobal("fetch", f);
    return f;
  }

  it("a non-404 error status → error first, the empty audit kept", async () => {
    const f = answer(503, "busy");
    const raw = await seoRobotsAuditTool.execute({ url: "https://example.com/blog" });
    expect(raw.startsWith('{"error":"')).toBe(true);
    const r = JSON.parse(raw);
    expect(Object.keys(r)).toEqual(["error", ...AUDIT_KEYS, "fetch_error"]);
    expect(r).toEqual({
      error: "robots.txt could not be read: HTTP 503",
      origin: "https://example.com",
      fetched: false,
      total_bots_checked: AI_BOTS.length,
      allowed: [],
      disallowed: [],
      unmentioned: [],
      warnings: [],
      fetch_error: "HTTP 503",
    });
    expect(f).toHaveBeenCalledTimes(1);
  });

  function throws(err: Error) {
    const f = vi.fn(async () => {
      throw err;
    });
    vi.stubGlobal("fetch", f);
    return f;
  }

  const emptyAudit = {
    origin: "https://example.com",
    fetched: false,
    total_bots_checked: AI_BOTS.length,
    allowed: [],
    disallowed: [],
    unmentioned: [],
    warnings: [],
  };

  it("the request throws → error first with its message, fetch_error as before", async () => {
    const f = throws(new TypeError("fetch failed"));
    const raw = await seoRobotsAuditTool.execute({ url: "https://example.com/" });
    expect(raw.startsWith('{"error":"')).toBe(true);
    const r = JSON.parse(raw);
    expect(Object.keys(r)).toEqual(["error", ...AUDIT_KEYS, "fetch_error"]);
    expect(r).toEqual({
      error: "robots.txt could not be read: fetch failed",
      ...emptyAudit,
      fetch_error: "fetch failed",
    });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("the request throws with no message → words still complete, fetch_error stays empty", async () => {
    throws(new Error(""));
    const raw = await seoRobotsAuditTool.execute({ url: "https://example.com/" });
    expect(raw.startsWith('{"error":"')).toBe(true);
    const r = JSON.parse(raw);
    expect(Object.keys(r)).toEqual(["error", ...AUDIT_KEYS, "fetch_error"]);
    expect(r.error).toBe("robots.txt could not be read: no error message");
    expect(r.fetch_error).toBe("");
  });

  it("a 404 is unchanged: no error key, origin first, every bot allowed", async () => {
    answer(404, "Not Found");
    const r = JSON.parse(await seoRobotsAuditTool.execute({ url: "https://example.com/" }));
    expect(Object.keys(r)).toEqual([...AUDIT_KEYS, "fetch_error"]);
    expect(r.fetched).toBe(true);
    expect(r.allowed).toHaveLength(AI_BOTS.length);
    expect(r.fetch_error).toBe("HTTP 404");
  });

  it("a 404 warns that there is no robots.txt and its first allowed entry is the default allow", async () => {
    answer(404, "Not Found");
    const r = JSON.parse(await seoRobotsAuditTool.execute({ url: "https://example.com/" }));
    expect(r.warnings).toEqual([
      "No robots.txt found (HTTP 404) — every bot is default-allowed. Consider adding an explicit policy.",
    ]);
    const bot = AI_BOTS[0];
    expect(r.allowed[0]).toEqual({
      name: bot.name,
      user_agent: bot.user_agent,
      operator: bot.operator,
      purpose: bot.purpose,
      state: "allowed",
      matched_group: "(no robots.txt — default allow)",
    });
  });

  it("a read robots.txt is unchanged: no error key, raw_length last", async () => {
    answer(200, "User-agent: *\nAllow: /");
    const r = JSON.parse(await seoRobotsAuditTool.execute({ url: "https://example.com/" }));
    expect(Object.keys(r)).toEqual([...AUDIT_KEYS, "raw_length"]);
    expect(r.fetched).toBe(true);
    expect(r.raw_length).toBe("User-agent: *\nAllow: /".length);
  });
});
