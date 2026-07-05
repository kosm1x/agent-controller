/**
 * HTTP fetch tool.
 *
 * Makes HTTP requests and returns the response.
 */

import type { Tool } from "../types.js";
import { validateOutboundUrlResolved } from "../../lib/url-safety.js";

const TIMEOUT_MS = 15_000;
const MAX_BODY = 20_000; // chars
const MAX_REDIRECTS = 5; // cap the redirect chain (H3)

export const httpTool: Tool = {
  name: "http_fetch",
  deferred: true,
  // Verb is caller-controlled — POST/PUT/DELETE all allowed. Conservative.
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
  definition: {
    type: "function",
    function: {
      name: "http_fetch",
      description: `Make an HTTP request to a public URL and return the response (status + headers + truncated body).

WHEN TO USE:
- Calling a JSON API without a dedicated tool (small internal service, webhook test, an ad-hoc REST endpoint)
- POSTing to a form or webhook the user supplies
- Fetching a raw file that is NOT an HTML page (PDF → pdf_read, HTML → web_read instead)

WHEN NOT TO USE:
- Fetching a web page for reading → use web_read (handles extraction, charsets, redirects properly)
- Search → use web_search / exa_search
- Google Workspace APIs → use the gdocs/gsheets/gdrive/gmail/gcal tools (they handle OAuth)
- GitHub → use gh_* tools (auth + rate limits)
- WordPress → use wp_* tools (auth, media handling)

BOUNDARIES:
- Body is truncated to 20,000 chars. For larger payloads use a stream-aware tool.
- Timeout is 15s. Slow endpoints will fail — don't retry in a loop.
- SSRF-protected: private IPs (10.x, 192.168.x, 169.254.x), localhost, metadata endpoints all rejected.
- Supports GET, POST, PUT, DELETE, PATCH.`,
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to fetch",
          },
          method: {
            type: "string",
            enum: ["GET", "POST", "PUT", "DELETE", "PATCH"],
            description: "HTTP method (default: GET)",
          },
          headers: {
            type: "object",
            description: "Request headers as key-value pairs",
          },
          body: {
            type: "string",
            description: "Request body (for POST/PUT/PATCH)",
          },
        },
        required: ["url"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const url = args.url as string;
    if (!url) {
      return JSON.stringify({ error: "url is required" });
    }

    // SSRF protection — block private IPs, metadata endpoints, non-HTTP
    // schemes, AND names that resolve to private addresses (DNS rebinding):
    // this tool opens a local connection, so the string-level check alone is
    // bypassable via an attacker-controlled A record pointing at 127.0.0.1.
    const urlError = await validateOutboundUrlResolved(url);
    if (urlError) {
      return JSON.stringify({ error: urlError, url });
    }

    const method = ((args.method as string) ?? "GET").toUpperCase();
    const headers = (args.headers as Record<string, string>) ?? {};
    const body = args.body as string | undefined;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      // H3: manual redirect handling. undici's default `follow` would chase a
      // 3xx Location UNCHECKED — a public URL could 302 to http://127.0.0.1:8100
      // (local Supabase/Kong), :8080 (this control plane), :9090, and the body
      // would come back to the LLM. The initial SSRF guard only saw the FIRST
      // hop. Re-validate every hop's resolved Location against the same
      // outbound guard (incl. DNS resolution) before following, and cap the
      // chain so a redirect loop can't spin.
      let currentUrl = url;
      let currentMethod = method;
      let currentBody =
        method !== "GET" && method !== "DELETE" ? body : undefined;

      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const response = await fetch(currentUrl, {
          method: currentMethod,
          headers,
          body: currentBody,
          signal: controller.signal,
          redirect: "manual",
        });

        const isRedirect =
          response.status >= 300 &&
          response.status < 400 &&
          response.headers.has("location");

        if (!isRedirect) {
          const text = await response.text();
          const trimmed =
            text.length > MAX_BODY
              ? text.slice(0, MAX_BODY) +
                `\n... (truncated, ${text.length} total chars)`
              : text;

          return JSON.stringify({
            status: response.status,
            headers: Object.fromEntries(response.headers.entries()),
            body: trimmed,
            // Surface the final URL when a redirect chain was followed.
            ...(currentUrl !== url ? { finalUrl: currentUrl } : {}),
          });
        }

        // Resolve the Location against the current URL (it may be relative).
        let nextUrl: string;
        try {
          nextUrl = new URL(
            response.headers.get("location") as string,
            currentUrl,
          ).toString();
        } catch {
          return JSON.stringify({
            error: "Invalid redirect Location header",
            url: currentUrl,
          });
        }

        const redirectErr = await validateOutboundUrlResolved(nextUrl);
        if (redirectErr) {
          return JSON.stringify({
            error: `Blocked redirect: ${redirectErr}`,
            url: nextUrl,
          });
        }

        // Per HTTP semantics, 301/302/303 downgrade to GET and drop the body;
        // 307/308 preserve method + body. Mirror browser behavior.
        if (
          response.status === 301 ||
          response.status === 302 ||
          response.status === 303
        ) {
          currentMethod = "GET";
          currentBody = undefined;
        }
        currentUrl = nextUrl;
      }

      return JSON.stringify({
        error: `Too many redirects (>${MAX_REDIRECTS})`,
        url: currentUrl,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: message });
    } finally {
      clearTimeout(timeout);
    }
  },
};
