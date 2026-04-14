/**
 * URL safety validation — blocks SSRF attack vectors.
 *
 * Prevents LLM-directed requests from reaching:
 * - Cloud metadata endpoints (169.254.169.254)
 * - Internal services (localhost, private IPs)
 * - Non-HTTP schemes (file://, ftp://, gopher://)
 *
 * Used by http_fetch and web_read tools.
 */

/** Private/reserved IP ranges that should never be fetched by tools. */
const BLOCKED_IP_PATTERNS = [
  /^127\./, // Loopback
  /^10\./, // RFC 1918 Class A
  /^172\.(1[6-9]|2\d|3[01])\./, // RFC 1918 Class B
  /^192\.168\./, // RFC 1918 Class C
  /^169\.254\./, // Link-local / cloud metadata
  /^0\./, // Current network
  /^::1$/, // IPv6 loopback
  // v7.6.2 C2: IPv6 unspecified address — routes to loopback on Linux.
  // Previously missed by `::1` pattern. Covers ::, ::0, ::00, etc.
  /^::0*$/,
  /^fc00:/i, // IPv6 unique local
  /^fe80:/i, // IPv6 link-local
];

/** Hostnames that should never be fetched. */
const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
  "instance-data.ec2.internal",
]);

/** Only allow these URL schemes. */
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/**
 * Validate a URL for safe outbound fetching.
 * Returns null if safe, or an error message if blocked.
 */
export function validateOutboundUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Invalid URL";
  }

  // Scheme check
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return `Blocked scheme: ${parsed.protocol} (only http/https allowed)`;
  }

  // Blocked hostnames — strip IPv6 brackets for matching.
  // v7.6.2 C1: also strip trailing FQDN dot. DNS treats `localhost.` and
  // `localhost` identically, and without the strip the blocklist
  // `BLOCKED_HOSTS.has("localhost.")` returned false → bypass.
  const hostname = parsed.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (BLOCKED_HOSTS.has(hostname)) {
    return `Blocked host: ${hostname}`;
  }

  // IPv6-mapped IPv4 detection — Node converts ::ffff:10.0.0.1 to ::ffff:a00:1 (hex)
  // Parse both dotted-decimal and hex-encoded mapped forms
  let checkHost = hostname;
  const dottedV4 = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (dottedV4) {
    checkHost = dottedV4[1];
  } else {
    const hexV4 = hostname.match(/^::ffff:([0-9a-f]+):([0-9a-f]+)$/i);
    if (hexV4) {
      const hi = parseInt(hexV4[1], 16);
      const lo = parseInt(hexV4[2], 16);
      checkHost = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
  }

  // IP address check
  for (const pattern of BLOCKED_IP_PATTERNS) {
    if (pattern.test(checkHost)) {
      return `Blocked private/reserved IP: ${hostname}`;
    }
  }

  // Cloud metadata endpoint (catches IP and hostname variants)
  if (
    hostname === "169.254.169.254" ||
    parsed.pathname.includes("/latest/meta-data")
  ) {
    return "Blocked cloud metadata endpoint";
  }

  return null; // Safe
}

// ---------------------------------------------------------------------------
// v7.6.1 — MCP tool args pre-flight URL validation
// ---------------------------------------------------------------------------

/**
 * Param keys that conventionally hold URLs in MCP tool schemas.
 * Matched case-insensitively. False positives are filtered downstream
 * by `URL.canParse()` + `validateOutboundUrl()` — a non-URL string
 * under these keys is let through unchanged. So we can be generous
 * with the whitelist at zero false-positive cost.
 *
 * v7.6.2 W1: expanded from 15 → 30 keys per QA audit finding.
 * Covers common third-party MCP server conventions (webhook_url,
 * callback, redirect_uri, api_url, etc.) so future schema drift
 * doesn't silently bypass validation.
 */
const URL_PARAM_KEYS = new Set([
  // Direct URL names
  "url",
  "uri",
  "href",
  "link",
  "location",
  "src",
  "goto",
  // Target / destination variants
  "target",
  "target_url",
  "targeturl",
  "destination",
  "destination_url",
  "destinationurl",
  "navigate_to",
  "navigateto",
  "href_to",
  // Source variants
  "source_url",
  "sourceurl",
  // API / endpoint variants
  "endpoint",
  "endpoint_url",
  "api_url",
  "apiurl",
  "base_url",
  "baseurl",
  // Page variants
  "page",
  "page_url",
  "pageurl",
  "website",
  // Webhook / callback / redirect variants (third-party MCP convention)
  "webhook",
  "webhook_url",
  "webhookurl",
  "callback",
  "callback_url",
  "callbackurl",
  "redirect",
  "redirect_uri",
  "redirecturi",
  "redirect_url",
  "redirecturl",
  "return_url",
  "returnurl",
  // Ping / probe / reach variants
  "ping_url",
  "pingurl",
]);

/**
 * Recursively scan an args object for URL-bearing string values and run
 * `validateOutboundUrl` on each. Used by the MCP bridge to pre-flight
 * upstream tool calls before they reach lightpanda / playwright / any
 * other MCP server.
 *
 * Matching rules:
 *  - Only inspects string values whose KEY is in `URL_PARAM_KEYS`
 *    (case-insensitive) — this minimizes false positives on query /
 *    search / title fields that happen to contain a URL substring.
 *  - Only validates values that look like an absolute URL (match
 *    `scheme://`) — bare strings, relative paths, and template
 *    placeholders are let through.
 *  - Walks nested objects up to `maxDepth` levels (default 3) — MCP
 *    tool arg shapes are typically 1-2 levels deep.
 *  - Ignores arrays of non-URL primitives but walks arrays of objects
 *    so a `pages: [{url: "..."}]` shape is still caught.
 *
 * Returns `null` if all URL-shaped values passed validation, or a
 * descriptive error string (with the key path) on the first rejection.
 * Short-circuits on the first block — we don't care which further
 * params would have failed once one is already bad.
 */
export function validateArgsUrls(
  args: unknown,
  opts: { maxDepth?: number } = {},
): string | null {
  const maxDepth = opts.maxDepth ?? 3;
  return walk(args, "", maxDepth);
}

/**
 * Validate a single string that we already know is under a URL-convention
 * key. Returns an error message with the supplied path, or null if clean.
 *
 * v7.6.2 R4: uses `URL.canParse()` as the parse gate instead of a
 * `scheme://` regex. This catches `javascript:`, `data:`, `blob:`,
 * `vbscript:`, `file:` and other schemes that lack `//` — they all
 * parse and then fail the scheme check in `validateOutboundUrl`.
 */
function validateUrlString(value: string, path: string): string | null {
  if (!URL.canParse(value)) return null;
  const err = validateOutboundUrl(value);
  if (err) return `${path}: ${err}`;
  return null;
}

function walk(
  value: unknown,
  path: string,
  remainingDepth: number,
): string | null {
  if (remainingDepth < 0) return null;
  if (value === null || value === undefined) return null;

  if (Array.isArray(value)) {
    // Generic array path: walks objects only (no key context for strings).
    // The URL-key-parent array case is handled inline in the object branch
    // below so string elements there get validated.
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (typeof item === "object" && item !== null) {
        const err = walk(item, `${path}[${i}]`, remainingDepth - 1);
        if (err) return err;
      }
    }
    return null;
  }

  if (typeof value === "object") {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const nextPath = path ? `${path}.${key}` : key;
      const isUrlKey = URL_PARAM_KEYS.has(key.toLowerCase());

      if (isUrlKey && typeof v === "string") {
        // Direct string under a URL-convention key.
        const err = validateUrlString(v, nextPath);
        if (err) return err;
        continue;
      }

      if (isUrlKey && Array.isArray(v)) {
        // v7.6.2 W3: array under a URL-convention key — validate each
        // string element AND walk object elements.
        for (let i = 0; i < v.length; i++) {
          const item = v[i];
          const itemPath = `${nextPath}[${i}]`;
          if (typeof item === "string") {
            const err = validateUrlString(item, itemPath);
            if (err) return err;
          } else if (typeof item === "object" && item !== null) {
            const err = walk(item, itemPath, remainingDepth - 1);
            if (err) return err;
          }
        }
        continue;
      }

      // Not a URL-key string/array — recurse in case there are nested
      // URL params (e.g. `{config: {target_url: "..."}}`).
      if (typeof v === "object" && v !== null) {
        const err = walk(v, nextPath, remainingDepth - 1);
        if (err) return err;
      }
    }
    return null;
  }

  // Primitive non-string values (numbers, booleans, symbols) have no
  // URL semantics. Strings reached at root level (i.e. via a direct
  // `validateArgsUrls("foo")` call) also have no key context and are
  // ignored — callers who want to validate a single URL should use
  // `validateOutboundUrl()` directly.
  return null;
}
