/**
 * Tests for stealth browser — Cloudflare detection, launch flags, solver logic.
 *
 * Does NOT test actual browser launches (would require Playwright binary).
 * Tests the pure detection/decision logic that drives the stealth behavior.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isCloudflareChallenge,
  STEALTH_LAUNCH_ARGS,
} from "./stealth-browser.js";

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
