/**
 * WordPress publishing tools — multi-site.
 *
 * Manages posts, media, and taxonomies via the WP REST API.
 * Configuration: WP_SITES env var — JSON map of site aliases to credentials.
 *
 * Example WP_SITES value:
 * {
 *   "livingjoyfully": { "url": "https://livingjoyfully.art", "username": "admin", "app_password": "xxxx xxxx xxxx" },
 *   "redlightinsider": { "url": "https://redlightinsider.com", "username": "admin", "app_password": "yyyy yyyy yyyy" }
 * }
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

function getSiteNames(): string[] {
  return Object.keys(getSites());
}

function resolveSite(
  siteName?: string,
): { baseUrl: string; authHeader: string; name: string } | string {
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

  const clean = config.url.replace(/\/+$/, "");
  const encoded = Buffer.from(
    `${config.username}:${config.app_password}`,
  ).toString("base64");

  return {
    baseUrl: `${clean}/wp-json/wp/v2`,
    authHeader: `Basic ${encoded}`,
    name: key,
  };
}

async function wpFetch(
  site: { baseUrl: string; authHeader: string },
  path: string,
  options: RequestInit = {},
): Promise<{ status: number; data: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${site.baseUrl}${path}`, {
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

/** Build a dynamic site description snippet for tool descriptions. */
function siteParamDescription(): string {
  const names = getSiteNames();
  if (names.length === 0) return "Site alias (no sites configured yet).";
  if (names.length === 1)
    return `Site alias. Only "${names[0]}" is configured — omit to use it by default.`;
  return `Site alias — REQUIRED when multiple sites are configured. Available: ${names.join(", ")}`;
}

// ---------------------------------------------------------------------------
// wp_publish — create or update a post
// ---------------------------------------------------------------------------

export const wpPublishTool: Tool = {
  name: "wp_publish",
  requiresConfirmation: true,
  definition: {
    type: "function",
    function: {
      name: "wp_publish",
      description: `Create or update a WordPress post via the REST API.

WHEN TO USE:
- User asks to publish, create, or upload a blog post / article
- User asks to update an existing post (provide post_id)

WORKFLOW for new posts:
1. Call wp_publish with status "draft" to create the post
2. If you have an image URL, call wp_media_upload first to get a media_id, then pass it as featured_media
3. Call wp_publish again with status "publish" and post_id to go live

DO NOT narrate or simulate publishing — you MUST call this tool. If it fails, report the actual error.`,
      parameters: {
        type: "object",
        properties: {
          site: {
            type: "string",
            description: "Site alias from WP_SITES config.",
          },
          title: {
            type: "string",
            description: "Post title (required for new posts)",
          },
          content: {
            type: "string",
            description:
              "Post body in HTML. Use proper tags: <h2>, <p>, <ul>, <li>, <blockquote>, <strong>, <em>. Do NOT use markdown.",
          },
          excerpt: {
            type: "string",
            description: "Short summary / meta description (1-2 sentences)",
          },
          status: {
            type: "string",
            enum: ["draft", "publish", "pending", "private", "future"],
            description:
              'Post status. Use "draft" to review first, "publish" to go live immediately. Default: "draft"',
          },
          post_id: {
            type: "integer",
            description:
              "Existing post ID to update. Omit to create a new post.",
          },
          slug: {
            type: "string",
            description:
              "URL slug (e.g. 'my-great-post'). Auto-generated from title if omitted.",
          },
          categories: {
            type: "array",
            items: { type: "integer" },
            description:
              "Array of category IDs. Use wp_categories to look up IDs first.",
          },
          tags: {
            type: "array",
            items: { type: "integer" },
            description:
              "Array of tag IDs. Use wp_categories to look up IDs first.",
          },
          featured_media: {
            type: "integer",
            description:
              "Media ID for the featured/hero image. Upload with wp_media_upload first.",
          },
          format: {
            type: "string",
            enum: [
              "standard",
              "aside",
              "gallery",
              "image",
              "link",
              "quote",
              "status",
              "video",
              "audio",
            ],
            description: 'Post format. Default: "standard"',
          },
          date: {
            type: "string",
            description:
              'ISO 8601 date for scheduled posts (use with status "future"). Example: "2026-04-01T09:00:00"',
          },
        },
        required: [],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    // Update site param description dynamically
    (
      this.definition.function.parameters as Record<string, unknown> & {
        properties: Record<string, Record<string, unknown>>;
      }
    ).properties.site.description = siteParamDescription();

    const resolved = resolveSite(args.site as string | undefined);
    if (typeof resolved === "string") {
      return JSON.stringify({ success: false, error: resolved });
    }

    const postId = args.post_id as number | undefined;
    const method = postId ? "PUT" : "POST";
    const path = postId ? `/posts/${postId}` : "/posts";

    const body: Record<string, unknown> = {};
    const fields = [
      "title",
      "content",
      "excerpt",
      "status",
      "slug",
      "categories",
      "tags",
      "featured_media",
      "format",
      "date",
    ];
    for (const f of fields) {
      if (args[f] !== undefined) body[f] = args[f];
    }

    // Default to draft for safety
    if (!body.status && !postId) body.status = "draft";

    const { status, data } = await wpFetch(resolved, path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (status >= 200 && status < 300) {
      const d = data as Record<string, unknown>;
      const link =
        (d.link as string) ??
        ((d.guid as Record<string, string>)?.rendered || "");
      return JSON.stringify({
        success: true,
        site: resolved.name,
        post_id: d.id,
        status: d.status,
        link,
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
// wp_media_upload — upload an image from a URL
// ---------------------------------------------------------------------------

export const wpMediaUploadTool: Tool = {
  name: "wp_media_upload",
  requiresConfirmation: true,
  definition: {
    type: "function",
    function: {
      name: "wp_media_upload",
      description: `Upload an image to the WordPress media library from a URL.

WHEN TO USE:
- Before creating a post that needs a featured/hero image
- When you have a generated image URL and need a WordPress media_id

Returns a media_id that you pass to wp_publish as featured_media.

DO NOT fabricate media_ids — you MUST call this tool to get a real one.`,
      parameters: {
        type: "object",
        properties: {
          site: {
            type: "string",
            description: "Site alias from WP_SITES config.",
          },
          image_url: {
            type: "string",
            description:
              "URL of the image to download and upload to WordPress. Must be a direct image URL.",
          },
          filename: {
            type: "string",
            description:
              'Filename for the uploaded image (e.g. "hero-image.jpg"). Include extension.',
          },
          alt_text: {
            type: "string",
            description: "Alt text for accessibility and SEO.",
          },
          caption: {
            type: "string",
            description: "Image caption (shown below the image).",
          },
          title: {
            type: "string",
            description:
              "Media title in WordPress library. Defaults to filename.",
          },
        },
        required: ["image_url", "filename"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const resolved = resolveSite(args.site as string | undefined);
    if (typeof resolved === "string") {
      return JSON.stringify({ success: false, error: resolved });
    }

    const imageUrl = args.image_url as string;
    const filename = args.filename as string;
    const altText = args.alt_text as string | undefined;
    const caption = args.caption as string | undefined;
    const title = (args.title as string) ?? filename.replace(/\.[^.]+$/, "");

    // Download the image
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const imgResponse = await fetch(imageUrl, {
        signal: controller.signal,
      });
      if (!imgResponse.ok) {
        return JSON.stringify({
          success: false,
          error: `Failed to download image: ${imgResponse.status} ${imgResponse.statusText}`,
        });
      }

      const contentType =
        imgResponse.headers.get("content-type") ?? "image/jpeg";
      const imageBuffer = Buffer.from(await imgResponse.arrayBuffer());

      clearTimeout(timeout);

      // Upload to WordPress
      const uploadController = new AbortController();
      const uploadTimeout = setTimeout(
        () => uploadController.abort(),
        TIMEOUT_MS,
      );

      try {
        const uploadResponse = await fetch(`${resolved.baseUrl}/media`, {
          method: "POST",
          headers: {
            Authorization: resolved.authHeader,
            "Content-Type": contentType,
            "Content-Disposition": `attachment; filename="${filename}"`,
          },
          body: imageBuffer,
          signal: uploadController.signal,
        });

        const text = await uploadResponse.text();
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }

        if (uploadResponse.status >= 200 && uploadResponse.status < 300) {
          const d = data as Record<string, unknown>;
          const mediaId = d.id as number;

          // Set alt text / caption if provided
          if (altText || caption) {
            const meta: Record<string, unknown> = {};
            if (altText) meta.alt_text = altText;
            if (caption) meta.caption = caption;
            if (title) meta.title = title;
            await wpFetch(resolved, `/media/${mediaId}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(meta),
            });
          }

          return JSON.stringify({
            success: true,
            site: resolved.name,
            media_id: mediaId,
            source_url: (d.source_url as string) ?? "",
            title,
          });
        }

        return JSON.stringify({
          success: false,
          site: resolved.name,
          http_status: uploadResponse.status,
          error: data,
        });
      } finally {
        clearTimeout(uploadTimeout);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ success: false, error: message });
    } finally {
      clearTimeout(timeout);
    }
  },
};

// ---------------------------------------------------------------------------
// wp_categories — list categories and tags
// ---------------------------------------------------------------------------

export const wpCategoriesTool: Tool = {
  name: "wp_categories",
  definition: {
    type: "function",
    function: {
      name: "wp_categories",
      description: `List WordPress categories or tags. Use this to look up IDs before creating a post.

WHEN TO USE:
- Before calling wp_publish with categories or tags — you need integer IDs, not names
- To check what categories/tags exist on the site

Returns an array of {id, name, slug, count} objects.`,
      parameters: {
        type: "object",
        properties: {
          site: {
            type: "string",
            description: "Site alias from WP_SITES config.",
          },
          taxonomy: {
            type: "string",
            enum: ["categories", "tags"],
            description:
              'Which taxonomy to list. Default: "categories". Use "tags" for tags.',
          },
          search: {
            type: "string",
            description: "Search term to filter results.",
          },
          per_page: {
            type: "integer",
            description: "Number of results (max 100). Default: 100.",
          },
        },
        required: [],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const resolved = resolveSite(args.site as string | undefined);
    if (typeof resolved === "string") {
      return JSON.stringify({ success: false, error: resolved });
    }

    const taxonomy = (args.taxonomy as string) ?? "categories";
    const search = args.search as string | undefined;
    const perPage = (args.per_page as number) ?? 100;

    const params = new URLSearchParams({
      per_page: String(perPage),
    });
    if (search) params.set("search", search);

    const { status, data } = await wpFetch(
      resolved,
      `/${taxonomy}?${params.toString()}`,
    );

    if (status >= 200 && status < 300 && Array.isArray(data)) {
      const items = data.map((item: Record<string, unknown>) => ({
        id: item.id,
        name: item.name,
        slug: item.slug,
        count: item.count,
        parent: item.parent ?? null,
      }));
      return JSON.stringify({
        success: true,
        site: resolved.name,
        count: items.length,
        items,
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
