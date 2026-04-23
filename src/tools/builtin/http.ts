/**
 * HTTP fetch tool.
 *
 * Makes HTTP requests and returns the response.
 */

import type { Tool } from "../types.js";
import { validateOutboundUrl } from "../../lib/url-safety.js";

const TIMEOUT_MS = 15_000;
const MAX_BODY = 20_000; // chars

export const httpTool: Tool = {
  name: "http_fetch",
  deferred: true,
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

    // SSRF protection — block private IPs, metadata endpoints, non-HTTP schemes
    const urlError = validateOutboundUrl(url);
    if (urlError) {
      return JSON.stringify({ error: urlError, url });
    }

    const method = ((args.method as string) ?? "GET").toUpperCase();
    const headers = (args.headers as Record<string, string>) ?? {};
    const body = args.body as string | undefined;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: method !== "GET" && method !== "DELETE" ? body : undefined,
        signal: controller.signal,
      });

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
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: message });
    } finally {
      clearTimeout(timeout);
    }
  },
};
