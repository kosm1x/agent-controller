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

  // Blocked hostnames — strip IPv6 brackets for matching
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
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
 * Matched case-insensitively. Keep this narrow — we'd rather miss a
 * non-standard name than false-positive on a query parameter that
 * happens to be under a url-shaped key.
 */
const URL_PARAM_KEYS = new Set([
  "url",
  "uri",
  "href",
  "link",
  "target",
  "target_url",
  "targeturl",
  "location",
  "src",
  "source_url",
  "sourceurl",
  "endpoint",
  "page",
  "page_url",
  "pageurl",
  "navigate_to",
  "navigateto",
  "goto",
]);

const URL_SCHEME_RE = /^[a-z][a-z0-9+\-.]*:\/\//i;

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

function walk(
  value: unknown,
  path: string,
  remainingDepth: number,
): string | null {
  if (remainingDepth < 0) return null;
  if (value === null || value === undefined) return null;

  if (typeof value === "string") {
    // String values are ONLY validated if the leaf key we arrived here
    // through is a known URL convention — enforced by the caller, so
    // we just validate the string here.
    if (!URL_SCHEME_RE.test(value)) return null;
    const err = validateOutboundUrl(value);
    if (err) return `${path}: ${err}`;
    return null;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      // Arrays of strings: skip (no key context, too many false positives).
      // Arrays of objects: walk into each.
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
      if (URL_PARAM_KEYS.has(key.toLowerCase()) && typeof v === "string") {
        // Validate this string directly — it's under a URL-convention key.
        if (URL_SCHEME_RE.test(v)) {
          const err = validateOutboundUrl(v);
          if (err) return `${nextPath}: ${err}`;
        }
        continue;
      }
      // Not a URL-key string — recurse in case there are nested URL
      // params (e.g. {config: {target_url: "..."}}).
      if (typeof v === "object" && v !== null) {
        const err = walk(v, nextPath, remainingDepth - 1);
        if (err) return err;
      }
    }
    return null;
  }

  return null;
}
