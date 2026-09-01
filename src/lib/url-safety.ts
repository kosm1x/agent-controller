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

import { lookup as dnsLookup } from "node:dns";
import type { LookupAddress, LookupAllOptions, LookupOptions } from "node:dns";
import type { LookupFunction } from "node:net";
import { Agent } from "undici";

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
  // IPv6 unique local — the whole fc00::/7 block. The previous /^fc00:/
  // missed fd00::/8, the half of ULA space actually used in practice, which
  // would have defeated the DNS-rebinding check for fd-addressed targets.
  /^f[cd][0-9a-f]{0,2}:/i,
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
  // v7.6.3 C1.5 (re-audit): strip ALL trailing dots, not just one.
  // `\.$` only stripped one trailing dot, leaving `localhost..` → `localhost.`
  // which still bypasses. Browsers and `lightpanda` collapse multi-dot
  // FQDN suffixes; the blocklist must too. Verified live: `URL` parses
  // `http://localhost../` with `hostname="localhost.."` literally.
  const hostname = parsed.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
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

/** Is the (bracket-stripped) hostname an IP literal rather than a DNS name? */
function isIpLiteral(hostname: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":");
}

/** Check one resolved address against the private/reserved blocklist. */
function isBlockedAddress(addr: string): boolean {
  let check = addr.toLowerCase();
  const dottedV4 = check.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (dottedV4) check = dottedV4[1];
  // Hex-mapped spelling (::ffff:7f00:1). libuv prints the dotted form, but a
  // resolver or a caller-supplied literal can hand us this one (audit W4).
  const hexV4 = check.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hexV4) {
    const hi = parseInt(hexV4[1], 16);
    const lo = parseInt(hexV4[2], 16);
    check = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return BLOCKED_IP_PATTERNS.some((p) => p.test(check));
}

/**
 * DNS-resolving variant of `validateOutboundUrl` for async callers that
 * actually open a local connection (http_fetch). The string/regex check
 * alone is bypassable by a public DNS name whose A/AAAA record points at
 * 127.0.0.1 / 10.x / 169.254.169.254 (DNS rebinding): validation passes on
 * the name, fetch() connects to the internal target. Here we resolve the
 * hostname and re-check every returned address.
 *
 * TOCTOU: the record can still change between this lookup and fetch()'s
 * own lookup. `safeFetch` / `safeDispatcher` (below) close that at connect
 * time — re-resolving inside the socket's own lookup and refusing blocked
 * addresses — so pair this validator (a readable reason for the model) with
 * `safeFetch` (the backstop for a record that flips after validation).
 *
 * Fail-closed on resolution errors EXCEPT for names that don't resolve at
 * all (fetch would fail anyway with its own error).
 */
export async function validateOutboundUrlResolved(
  url: string,
): Promise<string | null> {
  const syncErr = validateOutboundUrl(url);
  if (syncErr) return syncErr;

  let hostname: string;
  try {
    hostname = new URL(url).hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .replace(/\.+$/, "");
  } catch {
    return "Invalid URL";
  }

  // IP literals were already fully checked by the sync path.
  if (isIpLiteral(hostname)) return null;

  try {
    const { lookup } = await import("node:dns/promises");
    const addrs = await lookup(hostname, { all: true, verbatim: true });
    for (const { address } of addrs) {
      if (isBlockedAddress(address)) {
        return `Blocked: ${hostname} resolves to private/reserved address ${address}`;
      }
    }
  } catch {
    // NXDOMAIN / resolver failure — fetch() will fail with its own error;
    // nothing internal is reachable through an unresolvable name.
    return null;
  }

  return null;
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
 * Convention: **all entries MUST be lowercase**. The lookup at the
 * call site uses `.toLowerCase()` on the key, so a Set entry like
 * `"Host"` would silently never match. Keep this list lowercase or
 * normalize at insert time.
 *
 * Growth history:
 *  - v7.6.1: initial 15 keys
 *  - v7.6.2 W1 (audit): expanded to 43 keys (webhook/callback/redirect
 *    families) so future third-party MCP servers don't silently bypass
 *  - v7.6.3 M3 (re-audit): added plural forms (`urls`, `links`, `hrefs`,
 *    `targets`, `endpoints`, `pages`) since W3 array walking now handles
 *    `{urls: ["..."]}` style schemas correctly
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
  // v7.6.3 M3: plural / batch forms (W3 array walking handles arrays)
  "urls",
  "links",
  "hrefs",
  "targets",
  "endpoints",
  "pages",
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

// ---------------------------------------------------------------------------
// Connect-time SSRF guard
// (Hermes v0.20.0 #70193 "DNS-pinned SSRF-safe fetches", adopted 2026-09-01)
// ---------------------------------------------------------------------------
//
// `validateOutboundUrlResolved` inspects the name BEFORE fetch() runs its own
// lookup, so a rebinding attacker (TTL 0: a public A record for the check,
// 127.0.0.1 / 169.254.169.254 / 10.x for the connect) slips through the gap
// and reaches hindsight :8888, supabase :8100 or mission-control :8080 from
// inside the box. This dispatcher closes the gap where it lives: the lookup
// the socket actually connects with re-resolves and DROPS blocked addresses,
// so a flipped record fails at connect time. Node's global fetch honours an
// undici `dispatcher` (verified live 2026-09-01: pinned-to-real-IP → 200,
// pinned-to-loopback → TLS alert), so callers keep the WHATWG surface and
// swap `fetch(` for `safeFetch(`. Redirect hops reuse the same dispatcher.

/** Minimal `dns.lookup(host, { all: true }, cb)` shape — injectable for tests. */
export type LookupAllFn = (
  hostname: string,
  options: LookupAllOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    addresses: LookupAddress[],
  ) => void,
) => void;

const defaultLookupAll: LookupAllFn = (hostname, options, callback) =>
  dnsLookup(hostname, options, callback);

export class SsrfBlockedError extends Error {
  readonly code = "ERR_SSRF_BLOCKED";
  constructor(
    readonly hostname: string,
    reason: string,
  ) {
    super(`Blocked: ${reason} (connect-time SSRF guard)`);
    this.name = "SsrfBlockedError";
  }
}

/** Pure split of resolved addresses — `isBlockedAddress` handles mapped-v4 forms. */
export function filterSafeAddresses(addresses: LookupAddress[]): {
  safe: LookupAddress[];
  blocked: LookupAddress[];
} {
  const safe: LookupAddress[] = [];
  const blocked: LookupAddress[] = [];
  for (const a of addresses) {
    (isBlockedAddress(a.address) ? blocked : safe).push(a);
  }
  return { safe, blocked };
}

/**
 * Build a `net.LookupFunction` that resolves with `all: true`, drops blocked
 * addresses and fails the connect when nothing safe remains. A public+private
 * mix keeps the public addresses (net picks among what we hand back).
 */
export function makeSafeLookup(
  resolver: LookupAllFn = defaultLookupAll,
): LookupFunction {
  const warned = new Set<string>();
  return (hostname, options, callback) => {
    const opts: LookupOptions =
      typeof options === "object" && options !== null ? options : {};
    resolver(hostname, { ...opts, all: true }, (err, addresses) => {
      if (err) return callback(err, [], undefined);
      const { safe, blocked } = filterSafeAddresses(addresses ?? []);
      if (blocked.length > 0 && !warned.has(hostname)) {
        if (warned.size >= 200) warned.clear();
        warned.add(hostname);
        console.warn(
          `[url-safety] connect-time SSRF guard: ${hostname} → blocked ` +
            blocked.map((b) => b.address).join(",") +
            (safe.length > 0 ? " (public addresses kept)" : " — connect refused"),
        );
      }
      if (safe.length === 0) {
        return callback(
          new SsrfBlockedError(
            hostname,
            `${hostname} resolves only to private/reserved address(es) ` +
              blocked.map((b) => b.address).join(", "),
          ),
          [],
          undefined,
        );
      }
      if (opts.all) callback(null, safe);
      else callback(null, safe[0].address, safe[0].family);
    });
  };
}

let safeAgent: Agent | null = null;

/** Shared dispatcher whose connect-time lookup enforces the blocklist. */
export function safeDispatcher(): Agent {
  if (!safeAgent) {
    safeAgent = new Agent({ connect: { lookup: makeSafeLookup() } });
  }
  return safeAgent;
}

/** Redirect hops `safeFetch` follows on its own — parity with fetch's own cap. */
export const MAX_SAFE_REDIRECTS = 20;

// Headers fetch itself strips on a cross-origin redirect / on a body-dropping
// method rewrite (WHATWG fetch §4.4 "HTTP-redirect fetch").
const CREDENTIAL_HEADERS = ["authorization", "proxy-authorization", "cookie"];
const BODY_HEADERS = [
  "content-encoding",
  "content-language",
  "content-location",
  "content-type",
  "content-length",
];

function ssrfFailure(hostname: string, reason: string): TypeError {
  // Same shape fetch itself produces for a refused connect, so callers see one
  // failure surface: TypeError("fetch failed") with `cause` = SsrfBlockedError.
  return new TypeError("fetch failed", {
    cause: new SsrfBlockedError(hostname, reason),
  });
}

/**
 * `fetch` with the connect-time SSRF guard. Use it for every URL the model or
 * a third party controls, AFTER `validateOutboundUrl*` (which gives the model a
 * readable reason up front); this guard is the backstop for a DNS record that
 * flips between validation and connect.
 *
 * Redirects are followed HERE, not by fetch: `net.connect` never consults
 * `lookup` for an IP-literal host, so a `Location: http://127.0.0.1:8888/`
 * hop would sail past the dispatcher on a `redirect: "follow"` call. Every hop
 * is re-validated with `validateOutboundUrl` (literals, schemes, blocked
 * names) before it is fetched. `redirect: "manual"` callers (http_fetch,
 * citations) get the 3xx back untouched and keep their own hop loops;
 * `redirect: "error"` rejects on the first 3xx like fetch does.
 *
 * A refused hop or connect surfaces as fetch's own failure shape:
 * `TypeError("fetch failed")` with `cause` = `SsrfBlockedError`.
 */
export async function safeFetch(
  input: string | URL,
  init?: RequestInit,
): Promise<Response> {
  const mode = init?.redirect ?? "follow";
  let current = typeof input === "string" ? input : input.toString();
  let method = (init?.method ?? "GET").toUpperCase();
  let body = init?.body;
  // Owned copy so hop-by-hop edits never touch the caller's object.
  const headers = new Headers(init?.headers);

  for (let hop = 0; hop <= MAX_SAFE_REDIRECTS; hop++) {
    const refused = validateOutboundUrl(current);
    if (refused) {
      let host = current;
      try {
        host = new URL(current).hostname;
      } catch {
        // keep the raw string as the "host" for the message
      }
      throw ssrfFailure(
        host,
        hop === 0 ? refused : `redirect hop ${hop} → ${current}: ${refused}`,
      );
    }

    // `as unknown`: the npm undici Agent and Node's bundled undici-types are two
    // copies of the same Dispatcher interface that TS refuses to relate directly;
    // the runtime contract is identical (verified live, see header comment).
    const res = await fetch(current, {
      ...init,
      method,
      body,
      // Fresh copy per hop: fetch (and any test double) must see this hop's
      // headers, not a view that later hops keep editing.
      headers: new Headers(headers),
      redirect: "manual",
      dispatcher: safeDispatcher(),
    } as unknown as RequestInit);

    // Optional chain on purpose: injected `FetchLike` implementations
    // (citations) declare `headers` optional (audit C1).
    const location = res.headers?.get("location") ?? null;
    const isRedirect = res.status >= 300 && res.status < 400 && location !== null;
    if (!isRedirect || mode === "manual") return res;

    // Release the 3xx body before the next hop (undici holds the socket until
    // the body is consumed or cancelled).
    void res.body?.cancel().catch(() => {});

    if (mode === "error") {
      throw new TypeError("fetch failed", {
        cause: new Error(`redirect refused (redirect: "error"): ${current}`),
      });
    }

    const next = new URL(location, current);
    // Fetch-spec parity (audit W6): credentials never cross an origin boundary…
    if (next.origin !== new URL(current).origin) {
      for (const h of CREDENTIAL_HEADERS) headers.delete(h);
    }
    // …and a method rewrite drops the body together with its describing
    // headers. 303 → GET unless HEAD; 301/302 → GET only for POST.
    const rewrite =
      res.status === 303
        ? method !== "HEAD"
        : (res.status === 301 || res.status === 302) && method === "POST";
    if (rewrite) {
      method = "GET";
      body = undefined;
      for (const h of BODY_HEADERS) headers.delete(h);
    }
    current = next.toString();
  }

  throw new TypeError("fetch failed", {
    cause: new Error(`too many redirects (>${MAX_SAFE_REDIRECTS}) from ${current}`),
  });
}
