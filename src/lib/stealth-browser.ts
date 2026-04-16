/**
 * Stealth Browser — anti-bot Playwright wrapper with Cloudflare Turnstile solver.
 *
 * Ported from Scrapling (D4Vinci/Scrapling, Apache 2.0) stealth patterns.
 * Zero new dependencies — uses Playwright APIs we already have.
 *
 * Two capabilities:
 * 1. Stealth launch flags that reduce bot detection fingerprint
 * 2. Cloudflare Turnstile solver (non-interactive + interactive challenges)
 *
 * Usage:
 *   const html = await stealthFetch("https://cf-protected-site.com");
 */

import { applyStealthPatches } from "../tools/builtin/stealth.js";

// ---------------------------------------------------------------------------
// Stealth launch flags (from Scrapling constants.py)
// ---------------------------------------------------------------------------

/** Base performance flags — reduce noise, disable unnecessary features. */
const DEFAULT_ARGS = [
  "--no-pings",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-infobars",
  "--disable-breakpad",
  "--disable-sync",
  "--disable-logging",
  "--disable-dev-shm-usage",
  "--disable-hang-monitor",
  "--disable-translate",
  "--disable-ipc-flooding-protection",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  "--disable-component-update",
  "--disable-domain-reliability",
] as const;

/** Anti-detection flags — make headless Chromium look like a real browser. */
const STEALTH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--lang=en-US",
  "--mute-audio",
  "--hide-scrollbars",
  "--ignore-gpu-blocklist",
  "--force-color-profile=srgb",
  "--metrics-recording-only",
  "--test-type",
  "--password-store=basic",
  "--use-mock-keychain",
  "--disable-features=IsolateOrigins,site-per-process,ImprovedCookieControls,LazyFrameLoading,GlobalMediaControls,DestroyProfileOnBrowserClose,MediaRouter,AcceptCHFrame,AutoExpandDetailsElement,CertificateTransparencyComponentUpdater,AvoidUnnecessaryBeforeUnloadCheckSync",
  "--enable-features=NetworkService,NetworkServiceInProcess",
  // Device fingerprint — simulate real desktop hardware
  "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
  // WebRTC leak prevention
  "--webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--force-webrtc-ip-handling-policy",
  // Canvas noise for fingerprint evasion
  "--fingerprinting-canvas-image-data-noise",
] as const;

/** Combined launch args for stealth browser. */
export const STEALTH_LAUNCH_ARGS = [...DEFAULT_ARGS, ...STEALTH_ARGS];

// ---------------------------------------------------------------------------
// Cloudflare Turnstile solver (ported from Scrapling _stealth.py)
// ---------------------------------------------------------------------------

/** Iframe URL pattern for Cloudflare challenges. */
const CF_CHALLENGE_PATTERN =
  /challenges\.cloudflare\.com\/cdn-cgi\/challenge-platform/;

/** Turnstile widget script pattern. */
const CF_TURNSTILE_SCRIPT =
  'script[src*="challenges.cloudflare.com/turnstile/v"]';

type ChallengeType =
  | "non-interactive"
  | "managed"
  | "interactive"
  | "turnstile"
  | null;

/**
 * Detect which type of Cloudflare challenge is present on the page.
 */
async function detectCloudflare(
  page: import("playwright").Page,
): Promise<ChallengeType> {
  const html = await page.content();

  // Check for challenge platform iframe types
  if (html.includes("cType: 'non-interactive'")) return "non-interactive";
  if (html.includes("cType: 'managed'")) return "managed";
  if (html.includes("cType: 'interactive'")) return "interactive";

  // Check for embedded Turnstile widget
  const turnstile = await page.$(CF_TURNSTILE_SCRIPT);
  if (turnstile) return "turnstile";

  return null;
}

/**
 * Detect if the page is showing a Cloudflare challenge.
 * Checks both the HTML content and the page title.
 */
export function isCloudflareChallenge(html: string): boolean {
  return (
    html.includes("challenges.cloudflare.com") ||
    html.includes("<title>Just a moment") ||
    html.includes("Checking if the site connection is secure") ||
    html.includes("Verify you are human") ||
    html.includes("cf-challenge-running")
  );
}

/**
 * Attempt to solve a Cloudflare Turnstile challenge on the current page.
 * Handles non-interactive (wait), managed (click), and interactive (click) types.
 *
 * Returns true if challenge was solved, false if no challenge or solver failed.
 */
export async function solveCloudflareTurnstile(
  page: import("playwright").Page,
  maxRetries = 3,
): Promise<boolean> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const challengeType = await detectCloudflare(page);
    if (!challengeType) return attempt > 0; // solved on previous iteration

    console.log(
      `[stealth] Cloudflare ${challengeType} challenge detected (attempt ${attempt + 1}/${maxRetries})`,
    );

    if (challengeType === "non-interactive") {
      // Wait for the "Just a moment..." page to auto-resolve
      try {
        await page.waitForFunction(
          `!document.title.includes("Just a moment")`,
          undefined,
          { timeout: 15_000 },
        );
        await page.waitForLoadState("networkidle", { timeout: 10_000 });
        continue; // Re-check if another challenge appears
      } catch {
        console.warn("[stealth] Non-interactive challenge timed out");
        return false;
      }
    }

    // managed, interactive, turnstile — need to click the checkbox
    try {
      // Find the challenge iframe
      const frames = page.frames();
      const cfFrame = frames.find((f) => CF_CHALLENGE_PATTERN.test(f.url()));

      if (cfFrame) {
        const frameElement = await cfFrame.frameElement();
        const box = await frameElement.boundingBox();
        if (box) {
          // Click with human-like random offset (Scrapling pattern: 26-28px, 25-27px)
          const x = box.x + 26 + Math.random() * 2;
          const y = box.y + 25 + Math.random() * 2;
          await page.mouse.click(x, y, {
            delay: 50 + Math.random() * 100,
            button: "left",
          });
        }
      } else {
        // Fallback: try clicking the Turnstile checkbox directly
        const checkbox = await page.$('input[type="checkbox"]');
        if (checkbox) {
          const box = await checkbox.boundingBox();
          if (box) {
            await page.mouse.click(
              box.x + box.width / 2 + Math.random() * 4 - 2,
              box.y + box.height / 2 + Math.random() * 4 - 2,
              { delay: 50 + Math.random() * 100 },
            );
          }
        }
      }

      // Wait for challenge resolution
      await page.waitForTimeout(3000 + Math.random() * 2000);
      await page.waitForLoadState("load", { timeout: 10_000 }).catch(() => {});
    } catch (err) {
      console.warn(
        `[stealth] Challenge click failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Final check: is the challenge still present?
  const finalType = await detectCloudflare(page);
  if (finalType) {
    console.warn(
      `[stealth] Cloudflare challenge persists after ${maxRetries} attempts`,
    );
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Public API — stealth fetch
// ---------------------------------------------------------------------------

/**
 * Fetch a URL using a stealth-configured Playwright browser.
 * Automatically handles Cloudflare Turnstile challenges.
 *
 * Returns the page content as clean text, or null on failure.
 * Caller is responsible for formatting the result.
 */
export async function stealthFetch(
  url: string,
  options?: {
    timeoutMs?: number;
    waitForSelector?: string;
    extractMarkdown?: boolean;
  },
): Promise<{ content: string; finalUrl: string; solved: boolean } | null> {
  const timeoutMs = options?.timeoutMs ?? 30_000;

  try {
    const { chromium } = await import("playwright");

    const browser = await chromium.launch({
      headless: true,
      args: [...STEALTH_LAUNCH_ARGS],
    });

    try {
      let context: import("playwright").BrowserContext;
      try {
        const { createFingerprintedContext } = await import("./fingerprint.js");
        context = await createFingerprintedContext(browser);
      } catch {
        // Fallback: plain context without fingerprinting
        context = await browser.newContext({
          ignoreHTTPSErrors: true,
          serviceWorkers: "allow" as const,
        });
      }

      // Apply JS-level stealth patches (navigator.webdriver, etc.) — best-effort
      try {
        await applyStealthPatches(context);
      } catch {
        // Non-fatal — stealth patches are supplementary
      }

      const page = await context.newPage();

      // Navigate
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      });

      // Detect and solve Cloudflare challenges
      let solved = false;
      const html = await page.content();
      if (isCloudflareChallenge(html)) {
        solved = await solveCloudflareTurnstile(page);
        if (!solved) {
          console.warn(`[stealth] Could not solve Cloudflare for ${url}`);
        }
      }

      // Wait for network idle after potential challenge resolution
      await page
        .waitForLoadState("networkidle", { timeout: 10_000 })
        .catch(() => {});

      // Optional: wait for specific selector
      if (options?.waitForSelector) {
        await page
          .waitForSelector(options.waitForSelector, { timeout: 10_000 })
          .catch(() => {});
      }

      // Extract content
      let content: string;
      if (options?.extractMarkdown) {
        // Extract readable text content (similar to Jina Reader output)
        // String expression to avoid TS DOM type errors (runs in browser context)
        content = await page.evaluate(`(() => {
          document.querySelectorAll(
            "script, style, nav, footer, header, aside, .cookie-banner, .popup, .modal, .ad, [role=banner], [role=navigation]"
          ).forEach(el => el.remove());
          const title = document.title;
          const body = document.body?.innerText ?? "";
          return "# " + title + "\\n\\n" + body;
        })()`);
      } else {
        content = await page.content();
      }

      const finalUrl = page.url();
      return { content, finalUrl, solved };
    } finally {
      await browser.close();
    }
  } catch (err) {
    console.warn(
      `[stealth] Fetch failed for ${url}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
