/**
 * Shared cookie-authed X request. Launches a stealth Chromium context with an
 * account's session cookies and runs a callback against its APIRequestContext —
 * the browser-TLS mechanism the post/probe paths use. Extracted from
 * cookie-backend.ts so the read path (notifications/mentions) reuses the exact
 * same authed transport instead of duplicating the launch/cookie logic.
 */

import { getXGlobals, type AccountCreds } from "./config.js";
import { STEALTH_LAUNCH_ARGS } from "../stealth-browser.js";

/** Auth headers for X's internal API (bearer + ct0 CSRF + session markers). */
export function authHeaders(creds: AccountCreds): Record<string, string> {
  return {
    authorization: getXGlobals().bearer,
    "x-csrf-token": creds.ct0 ?? "",
    "x-twitter-auth-type": "OAuth2Session",
    "x-twitter-active-user": "yes",
    "content-type": "application/json",
  };
}

/** Cookies on both apex domains (X migrated x.com↔twitter.com). */
export function cookiePayload(creds: AccountCreds) {
  const out: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
  }> = [];
  for (const domain of [".x.com", ".twitter.com"]) {
    if (creds.authToken)
      out.push({
        name: "auth_token",
        value: creds.authToken,
        domain,
        path: "/",
      });
    if (creds.ct0)
      out.push({ name: "ct0", value: creds.ct0, domain, path: "/" });
  }
  return out;
}

export async function withAuthedRequest<T>(
  creds: AccountCreds,
  fn: (request: import("playwright").APIRequestContext) => Promise<T>,
): Promise<T> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: true,
    args: [...STEALTH_LAUNCH_ARGS],
  });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    await context.addCookies(cookiePayload(creds));
    return await fn(context.request);
  } finally {
    await browser.close().catch(() => {});
  }
}
