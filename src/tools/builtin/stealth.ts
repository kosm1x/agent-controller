/**
 * Playwright Stealth Patches (v6.3 D4.5)
 *
 * 5 addInitScript patches to make headless Chromium less detectable.
 * Applied to screenshot_element's browser context.
 *
 * Source: browser-fingerprinting reference (niespodd/browser-fingerprinting).
 */

import type { BrowserContext } from "playwright";

/** Stealth scripts — executed in the browser page context (not Node.js). */
const STEALTH_SCRIPTS: string[] = [
  // 1. document.hasFocus() → always true
  `Object.defineProperty(document, "hasFocus", { value: () => true });`,

  // 2. visibilityState → "visible"
  `Object.defineProperty(document, "visibilityState", { get: () => "visible" });
   Object.defineProperty(document, "hidden", { get: () => false });`,

  // 3. navigator.webdriver → undefined
  `Object.defineProperty(navigator, "webdriver", { get: () => undefined });`,

  // 4. navigator.connection → plausible values
  `if (!("connection" in navigator)) {
     Object.defineProperty(navigator, "connection", {
       get: () => ({ effectiveType: "4g", rtt: 50, downlink: 10, saveData: false })
     });
   }`,

  // 5. performance.memory → plausible Chrome heap
  `if (performance && !("memory" in performance)) {
     Object.defineProperty(performance, "memory", {
       get: () => ({ jsHeapSizeLimit: 2172649472, totalJSHeapSize: 35839739, usedJSHeapSize: 24486188 })
     });
   }`,
];

/**
 * Apply stealth patches to a Playwright browser context.
 * Call after context creation, before page.goto().
 */
export async function applyStealthPatches(
  context: BrowserContext,
): Promise<void> {
  for (const script of STEALTH_SCRIPTS) {
    await context.addInitScript({ content: script });
  }
}

/** Export for testing. */
export { STEALTH_SCRIPTS };
