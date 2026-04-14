/**
 * Tests for URL safety validation — SSRF protection.
 */

import { describe, it, expect } from "vitest";
import { validateOutboundUrl, validateArgsUrls } from "./url-safety.js";

describe("validateOutboundUrl", () => {
  // --- Should BLOCK ---

  it("blocks localhost", () => {
    expect(validateOutboundUrl("http://localhost/secret")).toMatch(/Blocked/);
  });

  it("blocks 127.0.0.1", () => {
    expect(validateOutboundUrl("http://127.0.0.1/")).toMatch(/Blocked/);
  });

  it("blocks 10.x private range", () => {
    expect(validateOutboundUrl("http://10.0.0.1/admin")).toMatch(/Blocked/);
  });

  it("blocks 172.16.x private range", () => {
    expect(validateOutboundUrl("http://172.16.0.1/")).toMatch(/Blocked/);
  });

  it("blocks 192.168.x private range", () => {
    expect(validateOutboundUrl("http://192.168.1.1/")).toMatch(/Blocked/);
  });

  it("blocks cloud metadata IP", () => {
    expect(
      validateOutboundUrl("http://169.254.169.254/latest/meta-data"),
    ).toMatch(/Blocked/);
  });

  it("blocks metadata hostname", () => {
    expect(validateOutboundUrl("http://metadata.google.internal/")).toMatch(
      /Blocked/,
    );
  });

  it("blocks file:// scheme", () => {
    expect(validateOutboundUrl("file:///etc/passwd")).toMatch(/Blocked/);
  });

  it("blocks ftp:// scheme", () => {
    expect(validateOutboundUrl("ftp://evil.com/payload")).toMatch(/Blocked/);
  });

  it("blocks IPv6 loopback [::1]", () => {
    expect(validateOutboundUrl("http://[::1]/")).toMatch(/Blocked/);
  });

  it("blocks IPv6 unique local fc00:", () => {
    expect(validateOutboundUrl("http://[fc00::1]/")).toMatch(/Blocked/);
  });

  it("blocks IPv6 link-local fe80:", () => {
    expect(validateOutboundUrl("http://[fe80::1]/")).toMatch(/Blocked/);
  });

  it("blocks IPv6-mapped IPv4 loopback", () => {
    expect(validateOutboundUrl("http://[::ffff:127.0.0.1]/")).toMatch(
      /Blocked/,
    );
  });

  it("blocks IPv6-mapped IPv4 metadata", () => {
    expect(validateOutboundUrl("http://[::ffff:169.254.169.254]/")).toMatch(
      /Blocked/,
    );
  });

  it("blocks IPv6-mapped IPv4 private", () => {
    expect(validateOutboundUrl("http://[::ffff:10.0.0.1]/")).toMatch(/Blocked/);
  });

  // v7.6.2 C1 regression: trailing-dot hostname bypass.
  it("blocks localhost. (FQDN trailing dot)", () => {
    expect(validateOutboundUrl("http://localhost./secret")).toMatch(
      /Blocked host: localhost/,
    );
  });

  it("blocks metadata.google.internal. (FQDN trailing dot)", () => {
    expect(validateOutboundUrl("http://metadata.google.internal./v1/")).toMatch(
      /Blocked/,
    );
  });

  // v7.6.2 C2 regression: IPv6 unspecified address bypass.
  it("blocks IPv6 unspecified address [::]", () => {
    expect(validateOutboundUrl("http://[::]/")).toMatch(/Blocked/);
  });

  it("blocks IPv6 unspecified address [::0]", () => {
    expect(validateOutboundUrl("http://[::0]/")).toMatch(/Blocked/);
  });

  // v7.6.2 R4 regression: non-http schemes previously bypassed the
  // scheme gate in validateArgsUrls because they lack `://`. They now
  // reach validateOutboundUrl and get rejected by the scheme check.
  it("blocks javascript: URI", () => {
    expect(
      validateOutboundUrl('javascript:fetch("http://169.254.169.254")'),
    ).toMatch(/Blocked scheme/);
  });

  it("blocks data: URI", () => {
    expect(
      validateOutboundUrl("data:text/html,<script>alert(1)</script>"),
    ).toMatch(/Blocked scheme/);
  });

  it("blocks vbscript: URI", () => {
    expect(validateOutboundUrl("vbscript:msgbox")).toMatch(/Blocked scheme/);
  });

  it("blocks 0.0.0.0", () => {
    expect(validateOutboundUrl("http://0.0.0.0/")).toMatch(/Blocked/);
  });

  it("blocks metadata pathname even on public host", () => {
    expect(
      validateOutboundUrl("http://169.254.169.254/latest/meta-data/iam"),
    ).toMatch(/Blocked/);
  });

  it("blocks instance-data.ec2.internal", () => {
    expect(validateOutboundUrl("http://instance-data.ec2.internal/")).toMatch(
      /Blocked/,
    );
  });

  it("returns error for invalid URL", () => {
    expect(validateOutboundUrl("not-a-url")).toBe("Invalid URL");
  });

  // --- Should ALLOW ---

  it("allows normal HTTPS URL", () => {
    expect(validateOutboundUrl("https://github.com/user/repo")).toBeNull();
  });

  it("allows normal HTTP URL", () => {
    expect(validateOutboundUrl("http://example.com/page")).toBeNull();
  });

  it("allows public IP", () => {
    expect(validateOutboundUrl("http://8.8.8.8/dns")).toBeNull();
  });

  it("allows Jina Reader URL", () => {
    expect(
      validateOutboundUrl("https://r.jina.ai/https://example.com"),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateArgsUrls — MCP tool args pre-flight (v7.6.1)
// ---------------------------------------------------------------------------

describe("validateArgsUrls", () => {
  // --- Allow paths ---

  it("allows public http URL under 'url' key", () => {
    expect(validateArgsUrls({ url: "https://example.com/page" })).toBeNull();
  });

  it("allows non-URL string under 'url' key (no scheme)", () => {
    // A search query that happens to live under a `url`-ish key.
    // Not our job to second-guess — only absolute URLs are validated.
    expect(validateArgsUrls({ url: "how to fix bug" })).toBeNull();
  });

  it("allows relative path under 'url' key", () => {
    expect(validateArgsUrls({ url: "./page.html" })).toBeNull();
  });

  it("allows non-URL-key string that looks like a URL", () => {
    // String under a key NOT in URL_PARAM_KEYS — skipped.
    // E.g., a description field mentioning http://localhost.
    expect(
      validateArgsUrls({ description: "see http://localhost/docs" }),
    ).toBeNull();
  });

  it("allows empty args", () => {
    expect(validateArgsUrls({})).toBeNull();
    expect(validateArgsUrls(null)).toBeNull();
    expect(validateArgsUrls(undefined)).toBeNull();
  });

  // --- Block paths ---

  it("blocks file:// under 'url' key", () => {
    const result = validateArgsUrls({ url: "file:///root/claude/.env" });
    expect(result).toMatch(/url:/);
    expect(result).toMatch(/Blocked scheme/);
  });

  it("blocks http://localhost under 'url' key", () => {
    const result = validateArgsUrls({ url: "http://localhost:3000/api" });
    expect(result).toMatch(/url:/);
    expect(result).toMatch(/Blocked host/);
  });

  it("blocks 169.254.169.254 under 'url' key", () => {
    const result = validateArgsUrls({
      url: "http://169.254.169.254/latest/meta-data",
    });
    expect(result).toMatch(/url:/);
    expect(result).toMatch(/Blocked/);
  });

  it("blocks 127.0.0.1 under 'uri' key (alternate key)", () => {
    const result = validateArgsUrls({ uri: "http://127.0.0.1:9090/metrics" });
    expect(result).toMatch(/uri:/);
  });

  it("blocks 10.x under 'href' key", () => {
    const result = validateArgsUrls({ href: "http://10.0.0.5/" });
    expect(result).toMatch(/href:/);
  });

  it("blocks URL nested in config object under 'target_url'", () => {
    const result = validateArgsUrls({
      config: { target_url: "http://192.168.1.1/" },
    });
    expect(result).toMatch(/config\.target_url:/);
    expect(result).toMatch(/Blocked/);
  });

  it("blocks URL inside an array of objects", () => {
    const result = validateArgsUrls({
      pages: [{ url: "https://example.com" }, { url: "http://localhost:3000" }],
    });
    expect(result).toMatch(/pages\[1\]\.url:/);
    expect(result).toMatch(/Blocked host/);
  });

  it("short-circuits on first bad URL (doesn't validate further)", () => {
    // Second URL would also be blocked but the first is returned.
    const result = validateArgsUrls({
      url: "http://127.0.0.1/first",
      target: "file:///etc/passwd",
    });
    // Order of Object.entries is insertion order; first bad wins.
    expect(result).toMatch(/url:/);
  });

  it("respects maxDepth to prevent runaway recursion", () => {
    // Deeply nested URL beyond maxDepth should NOT be walked.
    const deep = {
      level1: {
        level2: {
          level3: {
            level4: {
              // Beyond default depth 3 — should be skipped.
              url: "http://localhost:3000",
            },
          },
        },
      },
    };
    expect(validateArgsUrls(deep)).toBeNull();
  });

  it("walks exactly to maxDepth when set", () => {
    const deep = {
      level1: {
        level2: {
          url: "http://localhost:3000",
        },
      },
    };
    const result = validateArgsUrls(deep);
    expect(result).toMatch(/level1\.level2\.url:/);
  });

  it("handles non-object args gracefully", () => {
    expect(validateArgsUrls("just a string")).toBeNull();
    expect(validateArgsUrls(42)).toBeNull();
    expect(validateArgsUrls(true)).toBeNull();
  });

  // ---------------------------------------------------------------------
  // v7.6.2 regression tests — QA audit findings
  // ---------------------------------------------------------------------

  // C1: trailing-dot hostname bypass
  it("blocks http://localhost./ at the args walker level", () => {
    const result = validateArgsUrls({ url: "http://localhost./secret" });
    expect(result).toMatch(/url:/);
    expect(result).toMatch(/Blocked host: localhost/);
  });

  // C2: IPv6 unspecified address bypass
  it("blocks http://[::]/ at the args walker level", () => {
    const result = validateArgsUrls({ url: "http://[::]/admin" });
    expect(result).toMatch(/url:/);
    expect(result).toMatch(/Blocked/);
  });

  // R4: javascript: URI via URL.canParse gate (previously bypassed)
  it("blocks javascript: URI under url key", () => {
    const result = validateArgsUrls({
      url: 'javascript:fetch("http://169.254.169.254")',
    });
    expect(result).toMatch(/url:/);
    expect(result).toMatch(/Blocked scheme: javascript:/);
  });

  it("blocks data: URI under url key", () => {
    const result = validateArgsUrls({
      url: "data:text/html,<script>alert(1)</script>",
    });
    expect(result).toMatch(/Blocked scheme: data:/);
  });

  it("blocks file: URI without // under url key", () => {
    // Bare `file:/etc/passwd` (no //) — previously bypassed the regex gate.
    // URL.canParse accepts it; validateOutboundUrl rejects the scheme.
    const result = validateArgsUrls({ url: "file:/etc/passwd" });
    expect(result).toMatch(/Blocked scheme: file:/);
  });

  // W1: expanded whitelist coverage
  it("blocks URL under 'webhook_url' key (expanded whitelist)", () => {
    const result = validateArgsUrls({
      webhook_url: "http://127.0.0.1:9090/metrics",
    });
    expect(result).toMatch(/webhook_url:/);
    expect(result).toMatch(/Blocked/);
  });

  it("blocks URL under 'callback_url' key", () => {
    const result = validateArgsUrls({
      callback_url: "http://10.0.0.5/callback",
    });
    expect(result).toMatch(/callback_url:/);
  });

  it("blocks URL under 'redirect_uri' key", () => {
    const result = validateArgsUrls({
      redirect_uri: "http://169.254.169.254/latest/meta-data",
    });
    expect(result).toMatch(/redirect_uri:/);
  });

  it("blocks URL under 'destination' key", () => {
    const result = validateArgsUrls({
      destination: "http://192.168.1.1/admin",
    });
    expect(result).toMatch(/destination:/);
  });

  it("blocks URL under 'api_url' key", () => {
    const result = validateArgsUrls({
      api_url: "http://[::1]:9090/metrics",
    });
    expect(result).toMatch(/api_url:/);
  });

  // W3: arrays of strings under URL-convention keys
  it("blocks array of URL strings under 'urls' (wait — 'urls' not in whitelist)", () => {
    // 'urls' is NOT in the whitelist. Only singular keys are. Document
    // this as an explicit gap that future schema drift might hit.
    const result = validateArgsUrls({
      urls: ["http://localhost/first", "http://ok.com"],
    });
    expect(result).toBeNull();
  });

  it("blocks bad URL in array under 'url' (singular) key", () => {
    // Rare pattern but legal: `{url: ["http://ok.com", "http://localhost/"]}`
    // With W3 the walker now validates string elements when the parent
    // key IS in URL_PARAM_KEYS.
    const result = validateArgsUrls({
      url: ["https://ok.com", "http://localhost:3000/api"],
    });
    expect(result).toMatch(/url\[1\]:/);
    expect(result).toMatch(/Blocked/);
  });

  it("blocks bad URL in array under 'endpoint' key with nested object element", () => {
    // Mixed array: string element + object element. Both should be
    // walked.
    const result = validateArgsUrls({
      endpoint: ["https://ok.com", { target_url: "http://192.168.1.1" }],
    });
    expect(result).toMatch(/endpoint\[1\]\.target_url:/);
  });

  it("allows non-URL strings in array under URL key", () => {
    // Array of strings under a URL key where the values are not URLs
    // (e.g. relative paths or search terms) should be let through.
    const result = validateArgsUrls({
      url: ["./page1", "./page2", "search query"],
    });
    expect(result).toBeNull();
  });
});
