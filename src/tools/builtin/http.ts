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
      description:
        "Make an HTTP request to a URL and return the response. Supports GET, POST, PUT, DELETE.",
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
