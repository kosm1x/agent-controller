/**
 * Browser Fingerprint Injection — realistic, randomized fingerprints per session.
 *
 * Uses Apify's fingerprint-suite (fingerprint-injector) to generate unique,
 * internally-consistent browser fingerprints from a Bayesian network trained
 * on real browser telemetry. Each call produces a different fingerprint:
 * viewport, UA, WebGL, canvas, languages, timezone, plugins, etc.
 *
 * Falls back to static context creation (current behavior) if the package
 * is unavailable or fails.
 */

import type { Browser, BrowserContext } from "playwright";

/** Static fallback — matches the pre-fingerprinting STEALTH_CONTEXT_OPTIONS. */
const STATIC_CONTEXT_OPTIONS = {
  viewport: { width: 1920, height: 1080 },
  screen: { width: 1920, height: 1080 },
  deviceScaleFactor: 2,
  colorScheme: "dark" as const,
  isMobile: false,
  hasTouch: false,
  ignoreHTTPSErrors: true,
  serviceWorkers: "allow" as const,
  permissions: ["geolocation", "notifications"],
};

/**
 * Create a browser context with realistic fingerprint injection.
 * Falls back to manual context creation if fingerprint-injector is unavailable.
 *
 * @param browser - Launched Playwright browser instance
 * @param contextOptions - Override options merged into the context (e.g. viewport for screenshots)
 */
export async function createFingerprintedContext(
  browser: Browser,
  contextOptions?: Record<string, unknown>,
): Promise<BrowserContext> {
  try {
    const { newInjectedContext } = await import("fingerprint-injector");

    return await newInjectedContext(browser, {
      fingerprintOptions: {
        devices: ["desktop"],
        operatingSystems: ["linux", "windows", "macos"],
        browsers: [{ name: "chrome", minVersion: 120 }],
      },
      newContextOptions: {
        ignoreHTTPSErrors: true,
        serviceWorkers: "allow",
        permissions: ["geolocation", "notifications"],
        ...contextOptions,
      },
    });
  } catch (err) {
    console.warn(
      "[stealth] Fingerprint injection unavailable, using static context:",
      err instanceof Error ? err.message : err,
    );
    return browser.newContext({
      ...STATIC_CONTEXT_OPTIONS,
      ...contextOptions,
    });
  }
}
