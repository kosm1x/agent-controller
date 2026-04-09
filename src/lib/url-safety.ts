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

  // Blocked hostnames
  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(hostname)) {
    return `Blocked host: ${hostname}`;
  }

  // IP address check
  for (const pattern of BLOCKED_IP_PATTERNS) {
    if (pattern.test(hostname)) {
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
