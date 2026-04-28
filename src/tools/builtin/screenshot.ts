/**
 * Screenshot Element Tool (v6.3 D1)
 *
 * Captures web page elements as HiDPI PNGs for content creation.
 * Uses Playwright Chromium directly (not MCP) for reliable headless capture.
 *
 * DSF trick from RedditVideoMakerBot:
 *   device_scale_factor = Math.floor(width / 600) + 1
 *   Gives HiDPI screenshots without changing viewport layout.
 */

import { join } from "path";
import { mkdirSync, readFileSync } from "fs";
import type { Tool } from "../types.js";
import { validateOutboundUrl } from "../../lib/url-safety.js";
import { describeImage } from "../../inference/vision.js";

const SCREENSHOT_DIR = "/tmp/screenshots";

/**
 * Calculate Device Scale Factor for HiDPI captures.
 * At 1080px width → DSF=2 (2x DPI without layout changes).
 */
export function calculateDSF(width: number): number {
  return Math.floor(width / 600) + 1;
}

export const screenshotElementTool: Tool = {
  name: "screenshot_element",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "screenshot_element",
      description: `Capture a web page element as a HiDPI PNG screenshot, optionally with a vision description.

USE WHEN:
- Need a screenshot of a web page or specific element for content creation
- Creating visual assets for overlay videos (video_create mode:"overlay")
- Capturing social media posts, articles, or data visualizations
- You need to SEE what an image at a URL looks like (set describe:true)

Uses Playwright Chromium in headless mode with HiDPI rendering.
Output: PNG file saved to /tmp/screenshots/.

WORKFLOW for video content:
1. screenshot_element url:"..." selector:".post" → PNG path
2. video_create mode:"overlay" with the screenshot as an image asset

WORKFLOW for "see this image":
- screenshot_element url:"https://site.com/path/img.png" describe:true
  → returns { path, description } so you can verify the rendered image
- For raw image URLs, selector:"img" or "body" both work — the browser
  renders the image and the screenshot captures it.`,
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "URL of the page to capture",
          },
          selector: {
            type: "string",
            description:
              'CSS selector of the element to capture (default: "body" for full page)',
          },
          width: {
            type: "number",
            description:
              "Viewport width in pixels (default: 1080). Height auto-adjusts.",
          },
          theme: {
            type: "string",
            enum: ["dark", "light"],
            description:
              "Force dark or light theme via prefers-color-scheme media override",
          },
          inject_text: {
            type: "string",
            description:
              "JavaScript to execute before capture (e.g. text replacement, DOM manipulation)",
          },
          describe: {
            type: "boolean",
            description:
              "If true, run the captured PNG through a vision-language model and include a description in the response. Use when you need to actually SEE what was captured (e.g., 'is the logo correct?', 'does this hero image render well?'). Adds a vision API call (~2-5s).",
          },
          describe_prompt: {
            type: "string",
            description:
              "Optional prompt for the vision model when describe:true. Defaults to a detailed Spanish description. Use this to ask specific questions, e.g. 'List all the text visible in this image' or 'Is the layout broken?'",
          },
        },
        required: ["url"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const url = args.url as string;
    if (!url) return JSON.stringify({ error: "url is required" });

    // SSRF protection: block file://, private IPs, metadata endpoints,
    // non-HTTP schemes. Previously missing from this tool — see
    // V7-READINESS-CRITERIA.md "Known Issues" (v7.6 hardening, day 5 of
    // validation window). Playwright's own protocol allowlist catches
    // file:// but NOT http://localhost:* / RFC1918 ranges, which would
    // let an LLM with screenshot access hit Grafana / Prometheus / etc.
    const urlError = validateOutboundUrl(url);
    if (urlError) {
      return JSON.stringify({ error: urlError, url });
    }

    const selector = (args.selector as string) || "body";
    const width = Math.min(1920, Math.max(320, Number(args.width) || 1080));
    const theme = args.theme as "dark" | "light" | undefined;
    const injectText = args.inject_text as string | undefined;
    const describe = args.describe === true;
    const describePrompt = args.describe_prompt as string | undefined;
    const dsf = calculateDSF(width);

    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const filename = `screenshot-${Date.now()}.png`;
    const outputPath = join(SCREENSHOT_DIR, filename);

    try {
      // Dynamic import to avoid loading Playwright at startup
      const { chromium } = await import("playwright");

      const browser = await chromium.launch({
        headless: true,
        args: ["--disable-blink-features=AutomationControlled"],
      });

      // C1 audit fix: try/finally guarantees browser.close() on all paths
      try {
        const screenshotContextOpts = {
          viewport: { width, height: 1920 },
          deviceScaleFactor: dsf,
          ...(theme && { colorScheme: theme }),
        };

        let context: import("playwright").BrowserContext;
        try {
          const { createFingerprintedContext } =
            await import("../../lib/fingerprint.js");
          context = await createFingerprintedContext(
            browser,
            screenshotContextOpts,
          );
        } catch {
          // Fallback: original behavior without fingerprinting
          context = await browser.newContext(screenshotContextOpts);
        }

        // D4.5: Apply stealth patches to reduce bot detection
        try {
          const { applyStealthPatches } = await import("./stealth.js");
          await applyStealthPatches(context);
        } catch {
          // Non-fatal — stealth patches are best-effort
        }

        const page = await context.newPage();

        // Navigate with timeout
        await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });

        // Optional: inject JavaScript before capture
        if (injectText) {
          try {
            await page.evaluate(injectText);
          } catch {
            // Injected JS failed — continue with capture anyway
          }
          await page.waitForTimeout(500);
        }

        // Capture the element
        const element = await page.$(selector);
        if (!element) {
          return JSON.stringify({
            error: `Element not found: "${selector}"`,
            url,
          });
        }

        await element.screenshot({ path: outputPath });

        const box = await element.boundingBox();

        const result: Record<string, unknown> = {
          path: outputPath,
          width: box ? Math.round(box.width * dsf) : width * dsf,
          height: box ? Math.round(box.height * dsf) : 0,
          dsf,
          selector,
          url,
        };

        if (describe) {
          try {
            const bytes = readFileSync(outputPath);
            const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
            result.description = await describeImage(dataUrl, describePrompt);
          } catch (err) {
            result.description_error =
              err instanceof Error ? err.message : String(err);
          }
        }

        return JSON.stringify(result);
      } finally {
        await browser.close();
      }
    } catch (err) {
      return JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
        url,
      });
    }
  },
};
