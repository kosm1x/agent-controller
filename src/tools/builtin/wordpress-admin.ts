/**
 * WordPress admin tools — site management beyond content.
 *
 * Manages pages, plugins, settings, and provides a raw API escape hatch.
 * Uses the same WP_SITES config as wordpress.ts.
 */

import type { Tool } from "../types.js";

const TIMEOUT_MS = 30_000;

interface WpSiteConfig {
  url: string;
  username: string;
  app_password: string;
}

type WpSitesMap = Record<string, WpSiteConfig>;

function getSites(): WpSitesMap {
  const raw = process.env.WP_SITES;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as WpSitesMap;
  } catch {
    return {};
  }
}

function resolveSite(
  siteName?: string,
): { baseUrl: string; authHeader: string; name: string } | string {
  const sites = getSites();
  const names = Object.keys(sites);
  if (names.length === 0)
    return "WordPress not configured. Set WP_SITES env var.";
  const key = siteName ?? (names.length === 1 ? names[0] : undefined);
  if (!key) return `Multiple sites. Specify "site": ${names.join(", ")}`;
  const config = sites[key];
  if (!config) return `Site "${key}" not found. Available: ${names.join(", ")}`;
  const clean = config.url.replace(/\/+$/, "");
  return {
    baseUrl: `${clean}/wp-json/wp/v2`,
    authHeader: `Basic ${Buffer.from(`${config.username}:${config.app_password}`).toString("base64")}`,
    name: key,
  };
}

/** Resolve site but return the raw URL (no /wp-json/wp/v2 suffix) for raw API calls. */
function resolveSiteRaw(
  siteName?: string,
): { siteUrl: string; authHeader: string; name: string } | string {
  const sites = getSites();
  const names = Object.keys(sites);
  if (names.length === 0)
    return "WordPress not configured. Set WP_SITES env var.";
  const key = siteName ?? (names.length === 1 ? names[0] : undefined);
  if (!key) return `Multiple sites. Specify "site": ${names.join(", ")}`;
  const config = sites[key];
  if (!config) return `Site "${key}" not found. Available: ${names.join(", ")}`;
  const clean = config.url.replace(/\/+$/, "");
  return {
    siteUrl: clean,
    authHeader: `Basic ${Buffer.from(`${config.username}:${config.app_password}`).toString("base64")}`,
    name: key,
  };
}

async function wpFetch(
  site: { baseUrl?: string; authHeader: string },
  fullUrl: string,
  options: RequestInit = {},
): Promise<{ status: number; data: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(fullUrl, {
      ...options,
      headers: {
        Authorization: site.authHeader,
        ...options.headers,
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: response.status, data };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// wp_pages — list and manage pages
// ---------------------------------------------------------------------------

export const wpPagesTool: Tool = {
  name: "wp_pages",
  definition: {
    type: "function",
    function: {
      name: "wp_pages",
      description: `List WordPress pages. Returns page IDs, titles, statuses, and links.

USE WHEN:
- To find pages on a site (About, Contact, etc.)
- To get a page ID before updating it with wp_publish (pages use post_id too)
- To check what pages exist

Pages can be created/updated with wp_publish — just add type="page" mentally. The WP REST API
treats pages similarly to posts for create/update operations.`,
      parameters: {
        type: "object",
        properties: {
          site: { type: "string", description: "Site alias." },
          status: {
            type: "string",
            enum: ["publish", "draft", "pending", "private", "any"],
            description: 'Filter by status. Default: "any".',
          },
          search: {
            type: "string",
            description: "Search term to filter pages.",
          },
          per_page: {
            type: "integer",
            description: "Results per page (max 100). Default: 20.",
          },
        },
        required: [],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const resolved = resolveSite(args.site as string | undefined);
    if (typeof resolved === "string")
      return JSON.stringify({ success: false, error: resolved });

    const params = new URLSearchParams({
      status: (args.status as string) ?? "any",
      per_page: String((args.per_page as number) ?? 20),
      orderby: "menu_order",
      order: "asc",
    });
    if (args.search) params.set("search", args.search as string);

    const { status, data } = await wpFetch(
      resolved,
      `${resolved.baseUrl}/pages?${params}`,
    );

    if (status >= 200 && status < 300 && Array.isArray(data)) {
      const items = data.map((p: Record<string, unknown>) => ({
        id: p.id,
        title: (p.title as Record<string, string>)?.rendered ?? "",
        status: p.status,
        slug: p.slug,
        link: p.link,
        parent: p.parent,
        menu_order: p.menu_order,
      }));
      return JSON.stringify({
        success: true,
        site: resolved.name,
        count: items.length,
        pages: items,
      });
    }
    return JSON.stringify({
      success: false,
      site: resolved.name,
      http_status: status,
      error: data,
    });
  },
};

// ---------------------------------------------------------------------------
// wp_plugins — list, activate, deactivate, install plugins
// ---------------------------------------------------------------------------

export const wpPluginsTool: Tool = {
  name: "wp_plugins",
  requiresConfirmation: true,
  definition: {
    type: "function",
    function: {
      name: "wp_plugins",
      description: `Manage WordPress plugins — list, activate, deactivate, or install.

USE WHEN:
- To check what plugins are installed on a site
- To activate/deactivate a plugin
- To install a plugin from the WordPress.org repository (by slug)

WORKFLOW for GA4 / script injection:
1. Call wp_plugins action="list" to check if a header scripts plugin exists
2. If not: wp_plugins action="install" slug="insert-headers-and-footers" (or "wpcode-insert-headers-and-footers")
3. wp_plugins action="activate" plugin="<plugin_file>" (use the "plugin" field from the list)
4. Use wp_raw_api to configure the plugin's settings (each plugin stores its options differently)

COMMON PLUGINS for script injection:
- "insert-headers-and-footers" (WPCode) — stores header scripts in wp_option "ihaf_insert_header"
- "header-footer-code-manager" — stores in custom post type`,
      parameters: {
        type: "object",
        properties: {
          site: { type: "string", description: "Site alias." },
          action: {
            type: "string",
            enum: ["list", "activate", "deactivate", "install"],
            description: "Action to perform.",
          },
          plugin: {
            type: "string",
            description:
              'Plugin identifier for activate/deactivate — the "plugin" field from the list response (e.g. "akismet/akismet.php").',
          },
          slug: {
            type: "string",
            description:
              'Plugin slug for install — the WordPress.org slug (e.g. "insert-headers-and-footers").',
          },
          search: {
            type: "string",
            description: "Search term when action is list.",
          },
        },
        required: ["action"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const resolved = resolveSite(args.site as string | undefined);
    if (typeof resolved === "string")
      return JSON.stringify({ success: false, error: resolved });

    const action = args.action as string;

    if (action === "list") {
      const params = new URLSearchParams();
      if (args.search) params.set("search", args.search as string);
      const { status, data } = await wpFetch(
        resolved,
        `${resolved.baseUrl}/plugins?${params}`,
      );
      if (status >= 200 && status < 300 && Array.isArray(data)) {
        const items = data.map((p: Record<string, unknown>) => ({
          plugin: p.plugin,
          name: (p.name as string) ?? "",
          status: p.status,
          version: (p.version as string) ?? "",
          description:
            typeof p.description === "object"
              ? ((p.description as Record<string, string>)?.raw ?? "").slice(
                  0,
                  100,
                )
              : String(p.description ?? "").slice(0, 100),
        }));
        return JSON.stringify({
          success: true,
          site: resolved.name,
          count: items.length,
          plugins: items,
        });
      }
      return JSON.stringify({
        success: false,
        site: resolved.name,
        http_status: status,
        error: data,
      });
    }

    if (action === "activate" || action === "deactivate") {
      const plugin = args.plugin as string;
      if (!plugin)
        return JSON.stringify({
          success: false,
          error: 'Missing "plugin" parameter (e.g. "akismet/akismet.php").',
        });
      const newStatus = action === "activate" ? "active" : "inactive";
      const { status, data } = await wpFetch(
        resolved,
        `${resolved.baseUrl}/plugins/${encodeURIComponent(plugin)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: newStatus }),
        },
      );
      if (status >= 200 && status < 300) {
        const d = data as Record<string, unknown>;
        return JSON.stringify({
          success: true,
          site: resolved.name,
          plugin: d.plugin,
          status: d.status,
        });
      }
      return JSON.stringify({
        success: false,
        site: resolved.name,
        http_status: status,
        error: data,
      });
    }

    if (action === "install") {
      const slug = args.slug as string;
      if (!slug)
        return JSON.stringify({
          success: false,
          error:
            'Missing "slug" parameter (e.g. "insert-headers-and-footers").',
        });
      const { status, data } = await wpFetch(
        resolved,
        `${resolved.baseUrl}/plugins`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug, status: "active" }),
        },
      );
      if (status >= 200 && status < 300) {
        const d = data as Record<string, unknown>;
        return JSON.stringify({
          success: true,
          site: resolved.name,
          plugin: d.plugin,
          status: d.status,
          name: d.name,
        });
      }
      return JSON.stringify({
        success: false,
        site: resolved.name,
        http_status: status,
        error: data,
      });
    }

    return JSON.stringify({
      success: false,
      error: `Unknown action: ${action}`,
    });
  },
};

// ---------------------------------------------------------------------------
// wp_settings — read and update core site settings
// ---------------------------------------------------------------------------

export const wpSettingsTool: Tool = {
  name: "wp_settings",
  definition: {
    type: "function",
    function: {
      name: "wp_settings",
      description: `Read or update WordPress site settings (title, tagline, URL, timezone, etc.).

USE WHEN:
- To check or change the site title, tagline, or description
- To verify the site URL or admin email
- To check the timezone or date/time format

For reading, call without any update fields. For updating, include the fields to change.`,
      parameters: {
        type: "object",
        properties: {
          site: { type: "string", description: "Site alias." },
          title: { type: "string", description: "Site title to set." },
          description: {
            type: "string",
            description: "Site tagline/description to set.",
          },
        },
        required: [],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const resolved = resolveSite(args.site as string | undefined);
    if (typeof resolved === "string")
      return JSON.stringify({ success: false, error: resolved });

    const updates: Record<string, unknown> = {};
    if (args.title !== undefined) updates.title = args.title;
    if (args.description !== undefined) updates.description = args.description;

    const hasUpdates = Object.keys(updates).length > 0;

    const { status, data } = await wpFetch(
      resolved,
      `${resolved.baseUrl}/settings`,
      hasUpdates
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(updates),
          }
        : {},
    );

    if (status >= 200 && status < 300) {
      const d = data as Record<string, unknown>;
      return JSON.stringify({
        success: true,
        site: resolved.name,
        action: hasUpdates ? "updated" : "read",
        settings: {
          title: d.title,
          description: d.description,
          url: d.url,
          email: d.email,
          timezone: d.timezone_string,
          date_format: d.date_format,
          time_format: d.time_format,
          language: d.language,
          posts_per_page: d.posts_per_page,
        },
      });
    }
    return JSON.stringify({
      success: false,
      site: resolved.name,
      http_status: status,
      error: data,
    });
  },
};

// ---------------------------------------------------------------------------
// wp_delete — delete posts, pages, or media
// ---------------------------------------------------------------------------

export const wpDeleteTool: Tool = {
  name: "wp_delete",
  requiresConfirmation: true,
  definition: {
    type: "function",
    function: {
      name: "wp_delete",
      description: `Delete a WordPress post, page, or media item by ID.

USE WHEN:
- User EXPLICITLY asks to remove a post, page, or uploaded image
- Cleaning up test content the user identifies by name/ID

DO NOT USE unless the user specifically requested deletion. "Clean up" or "organize" does NOT mean delete.

By default sends to trash (recoverable). Use force=true only when user says "permanently delete".

AFTER DELETING: Report what was deleted (title, type, ID) and whether it went to trash or was permanent.`,
      parameters: {
        type: "object",
        properties: {
          site: { type: "string", description: "Site alias." },
          id: { type: "integer", description: "ID of the item to delete." },
          type: {
            type: "string",
            enum: ["posts", "pages", "media"],
            description: 'Content type. Default: "posts".',
          },
          force: {
            type: "boolean",
            description: "Permanently delete (bypass trash). Default: false.",
          },
        },
        required: ["id"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const resolved = resolveSite(args.site as string | undefined);
    if (typeof resolved === "string")
      return JSON.stringify({ success: false, error: resolved });

    const id = args.id as number;
    const type = (args.type as string) ?? "posts";
    const force = (args.force as boolean) ?? false;

    const params = force ? "?force=true" : "";
    const { status, data } = await wpFetch(
      resolved,
      `${resolved.baseUrl}/${type}/${id}${params}`,
      { method: "DELETE" },
    );

    if (status >= 200 && status < 300) {
      const d = data as Record<string, unknown>;
      return JSON.stringify({
        success: true,
        site: resolved.name,
        deleted_id: id,
        type,
        trashed: !force,
        title: (d.title as Record<string, string>)?.rendered ?? "",
      });
    }
    return JSON.stringify({
      success: false,
      site: resolved.name,
      http_status: status,
      error: data,
    });
  },
};

// ---------------------------------------------------------------------------
// wp_raw_api — escape hatch for any WP REST endpoint
// ---------------------------------------------------------------------------

export const wpRawApiTool: Tool = {
  name: "wp_raw_api",
  requiresConfirmation: true,
  definition: {
    type: "function",
    function: {
      name: "wp_raw_api",
      description: `Call any WordPress REST API endpoint directly. This is the escape hatch for
operations not covered by specific wp_* tools.

USE WHEN:
- You need to call a plugin's custom REST endpoint
- You need to read/write wp_options (via a plugin that exposes them)
- You need to manage widgets, menus, or other less-common resources
- You need to configure a plugin's settings after installing it

EXAMPLES:
- List widgets: method="GET" path="/wp/v2/widgets"
- List widget areas: method="GET" path="/wp/v2/sidebars"
- Create widget: method="POST" path="/wp/v2/widgets" body={"sidebar":"wp_head","instance":{"content":"<script>...</script>"}}
- Read options (if exposed): method="GET" path="/wp/v2/settings"
- Call plugin endpoint: method="POST" path="/wpcode/v1/snippet" body={...}

The path is appended to the site's /wp-json/ base URL.`,
      parameters: {
        type: "object",
        properties: {
          site: { type: "string", description: "Site alias." },
          method: {
            type: "string",
            enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
            description: 'HTTP method. Default: "GET".',
          },
          path: {
            type: "string",
            description:
              'REST API path after /wp-json/ (e.g. "/wp/v2/widgets", "/wpcode/v1/snippets"). Include leading slash.',
          },
          body: {
            type: "object",
            description: "JSON body for POST/PUT/PATCH requests.",
          },
          query: {
            type: "object",
            description: "Query parameters as key-value pairs.",
          },
        },
        required: ["path"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const resolved = resolveSiteRaw(args.site as string | undefined);
    if (typeof resolved === "string")
      return JSON.stringify({ success: false, error: resolved });

    const method = (args.method as string) ?? "GET";
    const path = args.path as string;
    const body = args.body as Record<string, unknown> | undefined;
    const query = args.query as Record<string, string> | undefined;

    let url = `${resolved.siteUrl}/wp-json${path}`;
    if (query) {
      const params = new URLSearchParams(query);
      url += `?${params}`;
    }

    const options: RequestInit = { method };
    if (body && ["POST", "PUT", "PATCH"].includes(method)) {
      options.headers = { "Content-Type": "application/json" };
      options.body = JSON.stringify(body);
    }

    const { status, data } = await wpFetch(resolved, url, options);

    return JSON.stringify({
      success: status >= 200 && status < 300,
      site: resolved.name,
      http_status: status,
      data:
        typeof data === "string"
          ? data.slice(0, 3000)
          : JSON.stringify(data).length > 3000
            ? JSON.stringify(data).slice(0, 3000) + "...(truncated)"
            : data,
    });
  },
};
