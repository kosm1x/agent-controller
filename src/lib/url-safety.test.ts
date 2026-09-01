/**
 * Tests for URL safety validation — SSRF protection.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { Agent } from "undici";
import {
  validateOutboundUrl,
  validateArgsUrls,
  filterSafeAddresses,
  makeSafeLookup,
  safeDispatcher,
  safeFetch,
  SsrfBlockedError,
  MAX_SAFE_REDIRECTS,
  type LookupAllFn,
} from "./url-safety.js";
import { lookup as dnsLookupP } from "node:dns/promises";

// Ubuntu ships `ip6-localhost` → ::1 in /etc/hosts; the connect-time e2e case
// needs a loopback NAME that is not in BLOCKED_HOSTS. Skip cleanly elsewhere.
const HAS_IP6_LOCALHOST = await dnsLookupP("ip6-localhost", { all: true })
  .then((a) => a.some((x) => x.address === "::1"))
  .catch(() => false);

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
  it("blocks localhost. (single trailing dot FQDN)", () => {
    expect(validateOutboundUrl("http://localhost./secret")).toMatch(
      /Blocked host: localhost/,
    );
  });

  it("blocks metadata.google.internal. (single trailing dot FQDN)", () => {
    expect(validateOutboundUrl("http://metadata.google.internal./v1/")).toMatch(
      /Blocked/,
    );
  });

  // v7.6.3 C1.5 regression (re-audit): MULTIPLE trailing dots.
  // The v7.6.2 fix used `\.$` which only stripped one dot, leaving
  // `localhost..` → `localhost.` which still bypassed BLOCKED_HOSTS.
  // Fixed in v7.6.3 with `\.+$` to strip all trailing dots.
  it("blocks localhost.. (double trailing dot)", () => {
    expect(validateOutboundUrl("http://localhost../secret")).toMatch(
      /Blocked host: localhost/,
    );
  });

  it("blocks localhost... (triple trailing dot)", () => {
    expect(validateOutboundUrl("http://localhost.../secret")).toMatch(
      /Blocked host: localhost/,
    );
  });

  it("blocks metadata.google.internal.. (multi trailing dot FQDN)", () => {
    expect(
      validateOutboundUrl("http://metadata.google.internal../v1/"),
    ).toMatch(/Blocked/);
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

  // v7.6.3 M3 (re-audit): plural URL keys added to the whitelist.
  // Previously `urls` was not whitelisted and arrays bypassed validation.
  it("blocks array of URLs under 'urls' (plural — added v7.6.3)", () => {
    const result = validateArgsUrls({
      urls: ["https://ok.com", "http://localhost/secret"],
    });
    expect(result).toMatch(/urls\[1\]:/);
    expect(result).toMatch(/Blocked host: localhost/);
  });

  it("blocks array under 'endpoints' (plural — added v7.6.3)", () => {
    const result = validateArgsUrls({
      endpoints: ["https://api.public.com", "http://10.0.0.5/internal"],
    });
    expect(result).toMatch(/endpoints\[1\]:/);
    expect(result).toMatch(/Blocked private/);
  });

  it("blocks array under 'pages' (plural — added v7.6.3)", () => {
    const result = validateArgsUrls({
      pages: ["http://[::]/admin", "https://ok.com"],
    });
    expect(result).toMatch(/pages\[0\]:/);
    expect(result).toMatch(/Blocked/);
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

// Hermes v0.20.0 #70193 — connect-time guard (2026-09-01). The validator above
// checks the NAME before fetch; these pin the lookup the socket actually uses.
describe("connect-time SSRF guard (makeSafeLookup / safeDispatcher / safeFetch)", () => {
  const A = (address: string, family: 4 | 6 = 4) => ({ address, family });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("filterSafeAddresses splits blocked from public, incl. mapped-v4 loopback", () => {
    const { safe, blocked } = filterSafeAddresses([
      A("10.0.0.5"),
      A("93.184.216.34"),
      A("::ffff:127.0.0.1", 6),
      A("2606:2800:21f:cb07:6820:80da:af6b:8b2c", 6),
    ]);
    expect(safe.map((a) => a.address)).toEqual([
      "93.184.216.34",
      "2606:2800:21f:cb07:6820:80da:af6b:8b2c",
    ]);
    expect(blocked.map((a) => a.address)).toEqual([
      "10.0.0.5",
      "::ffff:127.0.0.1",
    ]);
  });

  it("safe lookup drops private records and keeps public ones (all:true and single-address shapes)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolver: LookupAllFn = (_h, _o, cb) =>
      cb(null, [A("10.0.0.5"), A("93.184.216.34")]);
    const lookup = makeSafeLookup(resolver);
    const all = await new Promise<unknown>((res) =>
      lookup("example.com", { all: true }, (err, addrs) => res(err ?? addrs)),
    );
    expect(all).toEqual([A("93.184.216.34")]);
    const one = await new Promise<unknown>((res) =>
      lookup("example.com", {}, (err, addr, fam) => res(err ?? [addr, fam])),
    );
    expect(one).toEqual(["93.184.216.34", 4]);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringMatching(/connect-time SSRF guard: example\.com → blocked 10\.0\.0\.5/),
    );
  });

  it("safe lookup fails the connect with ERR_SSRF_BLOCKED when only blocked records remain (rebinding flip)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolver: LookupAllFn = (_h, _o, cb) =>
      cb(null, [A("127.0.0.1"), A("::1", 6)]);
    const err = await new Promise<unknown>((res) =>
      makeSafeLookup(resolver)("evil.example", { all: true }, (e) => res(e)),
    );
    expect(err).toBeInstanceOf(SsrfBlockedError);
    expect((err as SsrfBlockedError).code).toBe("ERR_SSRF_BLOCKED");
    expect((err as Error).message).toMatch(/evil\.example.*127\.0\.0\.1, ::1/);
  });

  it("resolver errors pass through unchanged (ENOTFOUND stays fetch's own failure)", async () => {
    const enotfound = Object.assign(new Error("getaddrinfo ENOTFOUND nope.invalid"), {
      code: "ENOTFOUND",
    });
    const resolver: LookupAllFn = (_h, _o, cb) => cb(enotfound, []);
    const err = await new Promise<unknown>((res) =>
      makeSafeLookup(resolver)("nope.invalid", { all: true }, (e) => res(e)),
    );
    expect(err).toBe(enotfound);
  });

  it("safeDispatcher is one shared undici Agent", () => {
    const d = safeDispatcher();
    expect(d).toBeInstanceOf(Agent);
    expect(safeDispatcher()).toBe(d);
  });

  it.runIf(HAS_IP6_LOCALHOST)("safeFetch refuses a name that resolves to loopback AT CONNECT TIME (no network needed)", async () => {
    // `ip6-localhost` is an Ubuntu /etc/hosts alias for ::1 that is NOT in
    // BLOCKED_HOSTS, so the sync validator passes it and only the connect-time
    // lookup can refuse it — the rebinding shape, offline.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = await safeFetch("http://ip6-localhost:65530/").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    const cause = (err as Error).cause as SsrfBlockedError;
    expect(cause).toBeInstanceOf(SsrfBlockedError);
    expect(cause.code).toBe("ERR_SSRF_BLOCKED");
    expect(cause.hostname).toBe("ip6-localhost");
    expect(cause.message).toMatch(/resolves only to private\/reserved address\(es\) ::1/);
  });
});

// `net.connect` never consults `lookup` for IP-literal hosts, so safeFetch
// follows redirects itself and re-validates every hop.
describe("safeFetch redirect handling — every hop re-validated", () => {
  const redirect = (status: number, location: string) =>
    new Response(null, { status, headers: { location } });
  const ok = () => new Response("ok", { status: 200 });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("refuses a redirect to a private IP literal (the lookup-bypass case)", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(redirect(302, "http://127.0.0.1:8888/v1/default/banks"));
    vi.stubGlobal("fetch", mock);
    const err = await safeFetch("https://public.example/start").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    const cause = (err as Error).cause as SsrfBlockedError;
    expect(cause).toBeInstanceOf(SsrfBlockedError);
    expect(cause.hostname).toBe("127.0.0.1");
    expect(cause.message).toMatch(/redirect hop 1 → http:\/\/127\.0\.0\.1:8888/);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect to a blocked scheme or metadata host", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(redirect(301, "http://169.254.169.254/latest/meta-data/")),
    );
    const err = await safeFetch("https://public.example/a").catch((e: unknown) => e);
    expect(((err as Error).cause as SsrfBlockedError).code).toBe("ERR_SSRF_BLOCKED");
  });

  it("follows a public redirect with redirect:'manual' underneath and resolves relative Locations", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(redirect(302, "/moved"))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", mock);
    const res = await safeFetch("https://public.example/start", {
      headers: { "x-test": "1" },
    });
    expect(res.status).toBe(200);
    expect(mock).toHaveBeenCalledTimes(2);
    expect(mock.mock.calls[1][0]).toBe("https://public.example/moved");
    for (const call of mock.mock.calls) {
      expect(call[1].redirect).toBe("manual");
      expect(Object.fromEntries(call[1].headers)).toEqual({ "x-test": "1" });
      expect(call[1].dispatcher).toBe(safeDispatcher());
    }
  });

  it("rewrites POST→GET and drops the body on 303 (fetch-spec parity)", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(redirect(303, "https://public.example/done"))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", mock);
    await safeFetch("https://public.example/form", { method: "POST", body: "a=1" });
    expect(mock.mock.calls[0][1].method).toBe("POST");
    expect(mock.mock.calls[1][1].method).toBe("GET");
    expect(mock.mock.calls[1][1].body).toBeUndefined();
  });

  it("redirect:'manual' returns the 3xx untouched (http_fetch / citations keep their own hop loops)", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(redirect(302, "http://127.0.0.1:8888/"));
    vi.stubGlobal("fetch", mock);
    const res = await safeFetch("https://public.example/x", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://127.0.0.1:8888/");
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("redirect:'error' rejects on the first 3xx", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(redirect(302, "https://public.example/y")));
    await expect(
      safeFetch("https://public.example/x", { redirect: "error" }),
    ).rejects.toMatchObject({ message: "fetch failed" });
  });

  it("gives up after MAX_SAFE_REDIRECTS hops", async () => {
    const mock = vi.fn().mockResolvedValue(redirect(302, "https://public.example/loop"));
    vi.stubGlobal("fetch", mock);
    const err = await safeFetch("https://public.example/loop").catch((e: unknown) => e);
    expect(((err as Error).cause as Error).message).toMatch(/too many redirects/);
    expect(mock).toHaveBeenCalledTimes(MAX_SAFE_REDIRECTS + 1);
  });
});

// R1 audit folds (2026-09-01): C1 FetchLike parity, W4 hex-mapped v4, W6 header
// hygiene across hops, W8 warn-once.
describe("safeFetch — R1 audit folds", () => {
  const redirect = (status: number, location: string) =>
    new Response(null, { status, headers: { location } });
  const ok = () => new Response("ok", { status: 200 });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("C1: tolerates a FetchLike response without headers (citations contract)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({ status: 200, text: async () => "body" }),
    );
    const res = await safeFetch("https://public.example/no-headers");
    expect(res.status).toBe(200);
  });

  it("W4: hex-mapped IPv4 (::ffff:7f00:1, ::ffff:a00:1) is blocked like the dotted form", () => {
    const { blocked, safe } = filterSafeAddresses([
      { address: "::ffff:7f00:1", family: 6 },
      { address: "::ffff:a00:1", family: 6 },
      { address: "::ffff:5db8:d822", family: 6 }, // 93.184.216.34
    ]);
    expect(blocked.map((a) => a.address)).toEqual(["::ffff:7f00:1", "::ffff:a00:1"]);
    expect(safe.map((a) => a.address)).toEqual(["::ffff:5db8:d822"]);
  });

  it("W6: strips credentials on a cross-origin hop, keeps them same-origin", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(redirect(302, "https://public.example/same"))
      .mockResolvedValueOnce(redirect(302, "https://other.example/cross"))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", mock);
    await safeFetch("https://public.example/start", {
      headers: { authorization: "Bearer t", cookie: "a=b", "x-keep": "1" },
    });
    const h = (i: number) => Object.fromEntries(mock.mock.calls[i][1].headers);
    expect(h(1)).toEqual({ authorization: "Bearer t", cookie: "a=b", "x-keep": "1" });
    expect(h(2)).toEqual({ "x-keep": "1" });
  });

  it("W6: 303 drops the body AND its describing headers; HEAD stays HEAD", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(redirect(303, "https://public.example/done"))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", mock);
    await safeFetch("https://public.example/form", {
      method: "POST",
      body: "a=1",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-keep": "1" },
    });
    expect(mock.mock.calls[1][1].method).toBe("GET");
    expect(mock.mock.calls[1][1].body).toBeUndefined();
    expect(Object.fromEntries(mock.mock.calls[1][1].headers)).toEqual({ "x-keep": "1" });

    const mock2 = vi
      .fn()
      .mockResolvedValueOnce(redirect(303, "https://public.example/done"))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", mock2);
    await safeFetch("https://public.example/probe", { method: "HEAD" });
    expect(mock2.mock.calls[1][1].method).toBe("HEAD");
  });

  it("W6: the caller's headers object is never mutated", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(redirect(302, "https://other.example/x"))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", mock);
    const mine = { authorization: "Bearer t" };
    await safeFetch("https://public.example/start", { headers: mine });
    expect(mine).toEqual({ authorization: "Bearer t" });
  });

  it("W8: a mixed public+private record warns once per hostname", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolver: LookupAllFn = (_h, _o, cb) =>
      cb(null, [{ address: "10.0.0.5", family: 4 }, { address: "93.184.216.34", family: 4 }]);
    const lookup = makeSafeLookup(resolver);
    const once = () =>
      new Promise<void>((res) => lookup("mixed.example", { all: true }, () => res()));
    await once();
    await once();
    await once();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
