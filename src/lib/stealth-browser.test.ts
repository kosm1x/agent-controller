/**
 * Tests for stealth browser — Cloudflare detection, launch flags, solver logic.
 *
 * Does NOT test actual browser launches (would require Playwright binary).
 * Tests the pure detection/decision logic that drives the stealth behavior.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isCloudflareChallenge,
  isStealthRequestAllowed,
  isStealthRequestAllowedResolved,
  STEALTH_LAUNCH_ARGS,
} from "./stealth-browser.js";

// DNS is mocked (as in url-safety.test.ts): names under .internal.test
// resolve to a private address, the rest to a public one, so the resolving
// route check never touches a real resolver.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (host: string) =>
    host.endsWith(".internal.test")
      ? [{ address: "10.0.0.7", family: 4 }]
      : [{ address: "93.184.216.34", family: 4 }],
  ),
}));

describe("isCloudflareChallenge", () => {
  it("detects Cloudflare challenge platform URL", () => {
    const html =
      '<script src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/scripts/..."></script>';
    expect(isCloudflareChallenge(html)).toBe(true);
  });

  it("detects 'Just a moment' waiting page", () => {
    const html =
      "<html><head><title>Just a moment...</title></head><body>Please wait</body></html>";
    expect(isCloudflareChallenge(html)).toBe(true);
  });

  it("detects 'Checking if the site connection is secure'", () => {
    const html =
      '<div>Checking if the site connection is secure</div><div class="cf-challenge-running"></div>';
    expect(isCloudflareChallenge(html)).toBe(true);
  });

  it("detects 'Verify you are human'", () => {
    const html =
      "<h2>Verify you are human</h2><p>Please complete the check</p>";
    expect(isCloudflareChallenge(html)).toBe(true);
  });

  it("detects cf-challenge-running class", () => {
    const html = '<div class="cf-challenge-running">Loading...</div>';
    expect(isCloudflareChallenge(html)).toBe(true);
  });

  it("returns false for normal HTML", () => {
    const html =
      "<html><head><title>My Site</title></head><body><h1>Hello World</h1></body></html>";
    expect(isCloudflareChallenge(html)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isCloudflareChallenge("")).toBe(false);
  });

  it("returns false for Jina Reader markdown output", () => {
    const markdown =
      "# GitHub Repository\n\nThis is a README file with code examples.\n\n```javascript\nconst x = 1;\n```";
    expect(isCloudflareChallenge(markdown)).toBe(false);
  });
});

describe("STEALTH_LAUNCH_ARGS", () => {
  it("includes critical anti-automation flag", () => {
    expect(STEALTH_LAUNCH_ARGS).toContain(
      "--disable-blink-features=AutomationControlled",
    );
  });

  it("includes WebRTC leak prevention", () => {
    expect(STEALTH_LAUNCH_ARGS).toContain(
      "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    );
  });

  it("includes canvas fingerprint noise", () => {
    expect(STEALTH_LAUNCH_ARGS).toContain(
      "--fingerprinting-canvas-image-data-noise",
    );
  });

  it("includes device fingerprint simulation", () => {
    const hasBlink = STEALTH_LAUNCH_ARGS.some((a) =>
      a.includes("primaryPointerType=4"),
    );
    expect(hasBlink).toBe(true);
  });

  it("does NOT include automation flags that get detected", () => {
    const flagStr = STEALTH_LAUNCH_ARGS.join(" ");
    expect(flagStr).not.toContain("--enable-automation");
    expect(flagStr).not.toContain("--disable-popup-blocking");
  });

  it("has at least 30 flags (comprehensive stealth)", () => {
    expect(STEALTH_LAUNCH_ARGS.length).toBeGreaterThanOrEqual(30);
  });
});

describe("fingerprint integration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("createFingerprintedContext is importable from fingerprint module", async () => {
    const mod = await import("./fingerprint.js");
    expect(typeof mod.createFingerprintedContext).toBe("function");
  });

  it("stealth-browser imports fingerprint module for context creation", async () => {
    // Verify the import path exists and the module is structurally correct
    const source = await import("./stealth-browser.js");
    // stealthFetch exists and is a function (it internally uses createFingerprintedContext)
    expect(typeof source.stealthFetch).toBe("function");
    // The fingerprint module should be importable from the same directory
    const fp = await import("./fingerprint.js");
    expect(typeof fp.createFingerprintedContext).toBe("function");
  });
});

describe("stealthFetch request guard (SSRF)", () => {
  afterEach(() => {
    vi.doUnmock("playwright");
    vi.doUnmock("./fingerprint.js");
    vi.doUnmock("./url-safety.js");
    vi.resetModules();
  });

  it("isStealthRequestAllowed: public http(s) passes; private, metadata, loopback and non-http refuse", () => {
    expect(isStealthRequestAllowed("https://example.com/a")).toBe(true);
    for (const url of [
      "http://127.0.0.1:8080/api/jarvis-pull",
      "http://localhost./",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/",
      "http://[::1]:3000/",
      "file:///etc/passwd",
    ]) {
      expect(isStealthRequestAllowed(url)).toBe(false);
    }
  });

  it("isStealthRequestAllowedResolved: refuses a public-looking hostname that resolves private", async () => {
    expect(await isStealthRequestAllowedResolved("https://example.com/a")).toBe(true);
    expect(await isStealthRequestAllowedResolved("https://cdn.internal.test/x.js")).toBe(false);
    expect(await isStealthRequestAllowedResolved("http://127.0.0.1:8080/")).toBe(false);
  });

  it("isStealthRequestAllowedResolved: a rejecting resolver check refuses", async () => {
    const actual = await vi.importActual<typeof import("./url-safety.js")>("./url-safety.js");
    vi.doMock("./url-safety.js", () => ({
      ...actual,
      validateOutboundUrlResolved: vi.fn(async () => {
        throw new Error("resolver exploded");
      }),
    }));
    vi.resetModules();
    const mod = await import("./stealth-browser.js");
    expect(await mod.isStealthRequestAllowedResolved("https://example.com/a")).toBe(false);
  });

  it("registers a route on the context before navigating that aborts private requests", async () => {
    const calls: string[] = [];
    let handler: ((r: unknown) => unknown) | undefined;
    const page = {
      goto: vi.fn(async () => {
        calls.push("goto");
      }),
      content: vi.fn(async () => "<html><body>ok</body></html>"),
      waitForLoadState: vi.fn(async () => {}),
      url: () => "https://example.com/",
    };
    let wsHandler: ((ws: unknown) => unknown) | undefined;
    let wsMatcher: ((u: URL) => boolean) | undefined;
    const context = {
      route: vi.fn(async (_pattern: string, h: (r: unknown) => unknown) => {
        calls.push("route");
        handler = h;
      }),
      routeWebSocket: vi.fn(
        async (m: (u: URL) => boolean, h: (ws: unknown) => unknown) => {
          calls.push("routeWebSocket");
          wsMatcher = m;
          wsHandler = h;
        },
      ),
      addInitScript: vi.fn(async () => {}),
      newPage: vi.fn(async () => page),
    };
    const browser = { close: vi.fn(async () => {}) };
    vi.doMock("playwright", () => ({
      chromium: { launch: vi.fn(async () => browser) },
    }));
    vi.doMock("./fingerprint.js", () => ({
      createFingerprintedContext: vi.fn(async () => context),
    }));
    const { stealthFetch } = await import("./stealth-browser.js");

    const out = await stealthFetch("https://example.com/");
    expect(out?.finalUrl).toBe("https://example.com/");
    expect(calls).toEqual(["route", "routeWebSocket", "goto"]);
    // Every WebSocket is matched and closed — none leaves the guard.
    expect(wsMatcher!(new URL("wss://example.com/socket"))).toBe(true);
    expect(wsMatcher!(new URL("ws://127.0.0.1:8080/"))).toBe(true);
    const ws = { close: vi.fn() };
    await wsHandler!(ws);
    expect(ws.close).toHaveBeenCalled();
    expect(context.route).toHaveBeenCalledWith("**/*", expect.any(Function));

    const fakeRoute = (url: string) => ({
      request: () => ({ url: () => url }),
      continue: vi.fn(),
      abort: vi.fn(),
    });
    const priv = fakeRoute("http://127.0.0.1:8080/api/jarvis-pull");
    await handler!(priv);
    expect(priv.abort).toHaveBeenCalled();
    expect(priv.continue).not.toHaveBeenCalled();
    // Passes the sync string check, but the name resolves to 10.0.0.7.
    const rebound = fakeRoute("https://cdn.internal.test/app.js");
    await handler!(rebound);
    expect(rebound.abort).toHaveBeenCalled();
    expect(rebound.continue).not.toHaveBeenCalled();
    const pub = fakeRoute("https://cdn.example.com/app.js");
    await handler!(pub);
    expect(pub.continue).toHaveBeenCalled();
    expect(pub.abort).not.toHaveBeenCalled();
  });

  it("the plain fallback context blocks service workers (their requests bypass context.route)", async () => {
    const page = {
      goto: vi.fn(async () => {}),
      content: vi.fn(async () => "<html><body>ok</body></html>"),
      waitForLoadState: vi.fn(async () => {}),
      url: () => "https://example.com/",
    };
    const context = {
      route: vi.fn(async () => {}),
      routeWebSocket: vi.fn(async () => {}),
      addInitScript: vi.fn(async () => {}),
      newPage: vi.fn(async () => page),
    };
    const browser = {
      newContext: vi.fn(async () => context),
      close: vi.fn(async () => {}),
    };
    vi.doMock("playwright", () => ({
      chromium: { launch: vi.fn(async () => browser) },
    }));
    vi.doMock("./fingerprint.js", () => ({
      createFingerprintedContext: vi.fn(async () => {
        throw new Error("no fingerprint");
      }),
    }));
    const { stealthFetch } = await import("./stealth-browser.js");

    await stealthFetch("https://example.com/");
    expect(browser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({ serviceWorkers: "block" }),
    );
    expect(context.routeWebSocket).toHaveBeenCalled();
  });
});
