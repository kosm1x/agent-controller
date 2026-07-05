/**
 * Shared WordPress REST client — site config, Basic-auth, and fetch
 * plumbing for wordpress.ts (content tools) and wordpress-admin.ts
 * (admin tools). Previously each file re-implemented this independently.
 *
 * Configuration: WP_SITES env var — JSON map of site aliases to credentials:
 * { "alias": { "url": "https://…", "username": "…", "app_password": "…" } }
 */

const TIMEOUT_MS = 30_000;

export interface WpSiteConfig {
  url: string;
  username: string;
  app_password: string;
}

export type WpSitesMap = Record<string, WpSiteConfig>;

export function getSites(): WpSitesMap {
  const raw = process.env.WP_SITES;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as WpSitesMap;
  } catch {
    return {};
  }
}

export function getSiteNames(): string[] {
  return Object.keys(getSites());
}

/** Resolve a site alias to its config. Returns a user-facing error string on failure. */
function resolveConfig(
  siteName?: string,
): { config: WpSiteConfig; name: string } | string {
  const sites = getSites();
  const names = Object.keys(sites);

  if (names.length === 0) {
    return "WordPress not configured. Set the WP_SITES environment variable with site credentials.";
  }

  // If no site specified and only one exists, use it
  const key = siteName ?? (names.length === 1 ? names[0] : undefined);
  if (!key) {
    return `Multiple sites configured. You MUST specify the "site" parameter. Available: ${names.join(", ")}`;
  }

  const config = sites[key];
  if (!config) {
    return `Site "${key}" not found. Available: ${names.join(", ")}`;
  }

  return { config, name: key };
}

function authHeaderFor(config: WpSiteConfig): string {
  const encoded = Buffer.from(
    `${config.username}:${config.app_password}`,
  ).toString("base64");
  return `Basic ${encoded}`;
}

function cleanUrl(config: WpSiteConfig): string {
  return config.url.replace(/\/+$/, "");
}

/** Resolve a site alias to its /wp-json/wp/v2 base + Basic-auth header. */
export function resolveSite(
  siteName?: string,
): { baseUrl: string; authHeader: string; name: string } | string {
  const resolved = resolveConfig(siteName);
  if (typeof resolved === "string") return resolved;
  return {
    baseUrl: `${cleanUrl(resolved.config)}/wp-json/wp/v2`,
    authHeader: authHeaderFor(resolved.config),
    name: resolved.name,
  };
}

/** Same resolution, but returns the bare site URL (no /wp-json/wp/v2 suffix) for raw API calls. */
export function resolveSiteRaw(
  siteName?: string,
): { siteUrl: string; authHeader: string; name: string } | string {
  const resolved = resolveConfig(siteName);
  if (typeof resolved === "string") return resolved;
  return {
    siteUrl: cleanUrl(resolved.config),
    authHeader: authHeaderFor(resolved.config),
    name: resolved.name,
  };
}

/**
 * Authenticated fetch against `${site.baseUrl}${path}`. Returns the HTTP
 * status + the body (JSON-parsed when possible, raw text otherwise) —
 * callers branch on status, nothing is thrown for non-2xx.
 */
export async function wpFetch(
  site: { baseUrl: string; authHeader: string },
  path: string,
  options: RequestInit = {},
): Promise<{ status: number; data: unknown }> {
  const response = await fetch(`${site.baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: site.authHeader,
      ...options.headers,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  return { status: response.status, data };
}
