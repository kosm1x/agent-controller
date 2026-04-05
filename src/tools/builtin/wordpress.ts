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

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Tool } from "../types.js";

const TIMEOUT_MS = 30_000;
const WP_TEMP_DIR = "/tmp/wp_content";

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

/** Strip HTML tags for length comparison. */
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

/** Count structural HTML elements (headings, paragraphs, lists, blockquotes). */
function countStructuralElements(html: string): number {
  const matches = html.match(
    /<(h[1-6]|p|ul|ol|li|blockquote|figure|table|tr)\b/gi,
  );
  return matches ? matches.length : 0;
}

// ---------------------------------------------------------------------------
// Read-before-write tracking — enforces that wp_read_post is called before
// wp_publish when updating an existing post. Module-level state shared within
// the Node process.
// ---------------------------------------------------------------------------

/** Simple hash for content comparison (djb2). */
function hashContent(s: string): number {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  }
  return hash;
}

/** Map of "site:postId" → { timestamp, contentHash } of last wp_read_post call. */
const recentReads = new Map<string, { ts: number; contentHash: number }>();
const READ_TTL_MS = 15 * 60 * 1000; // 15 minutes

function recordRead(site: string, postId: number, content: string): void {
  // Purge stale entries
  const now = Date.now();
  for (const [key, entry] of recentReads) {
    if (now - entry.ts > READ_TTL_MS) recentReads.delete(key);
  }
  recentReads.set(`${site}:${postId}`, {
    ts: now,
    contentHash: hashContent(content),
  });
}

function wasReadRecently(site: string, postId: number): boolean {
  const entry = recentReads.get(`${site}:${postId}`);
  if (!entry) return false;
  return Date.now() - entry.ts < READ_TTL_MS;
}

function getOriginalContentHash(site: string, postId: number): number | null {
  const entry = recentReads.get(`${site}:${postId}`);
  return entry ? entry.contentHash : null;
}

/** Exported for testing only. */
export const _testing = {
  stripHtml,
  countStructuralElements,
  recordRead,
  wasReadRecently,
  getOriginalContentHash,
  recentReads,
};

// ---------------------------------------------------------------------------
// wp_list_posts — list posts from a site
// ---------------------------------------------------------------------------

export const wpListPostsTool: Tool = {
  name: "wp_list_posts",
  definition: {
    type: "function",
    function: {
      name: "wp_list_posts",
      description: `List WordPress posts from a site. Returns post IDs, titles, statuses, and links.

WHEN TO USE:
- To find a post's ID before updating it with wp_publish
- To see what posts exist on a site
- To check the current status of posts (draft, published, etc.)

ALWAYS call this BEFORE wp_publish with post_id — you need the real post ID, do NOT guess.`,
      parameters: {
        type: "object",
        properties: {
          site: {
            type: "string",
            description: "Site alias from WP_SITES config.",
          },
          status: {
            type: "string",
            enum: ["publish", "draft", "pending", "private", "any"],
            description:
              'Filter by post status. Default: "any". Use "publish" for live posts, "draft" for drafts.',
          },
          search: {
            type: "string",
            description: "Search term to filter posts by title/content.",
          },
          per_page: {
            type: "integer",
            description: "Number of results (max 100). Default: 20.",
          },
          page: {
            type: "integer",
            description: "Page number for pagination. Default: 1.",
          },
          orderby: {
            type: "string",
            enum: ["date", "title", "modified", "id"],
            description: 'Sort field. Default: "date".',
          },
          order: {
            type: "string",
            enum: ["asc", "desc"],
            description: 'Sort order. Default: "desc".',
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

    const params = new URLSearchParams();
    const status = (args.status as string) ?? "any";
    params.set("status", status);
    params.set("per_page", String((args.per_page as number) ?? 20));
    params.set("page", String((args.page as number) ?? 1));
    params.set("orderby", (args.orderby as string) ?? "date");
    params.set("order", (args.order as string) ?? "desc");

    if (args.search) params.set("search", args.search as string);

    const { status: httpStatus, data } = await wpFetch(
      resolved,
      `/posts?${params.toString()}`,
    );

    if (httpStatus >= 200 && httpStatus < 300 && Array.isArray(data)) {
      // Compact response: id, title, date, status, link, categories, tags.
      // Omit slug/modified/excerpt to stay under truncation limit (12K chars)
      // for large sites. The LLM can use wp_read_post for full content.
      const items = data.map((post: Record<string, unknown>) => ({
        id: post.id,
        title: (post.title as Record<string, string>)?.rendered ?? "",
        status: post.status,
        date: (post.date as string)?.slice(0, 10) ?? "",
        link: post.link,
        categories: post.categories,
        tags: post.tags,
      }));
      return JSON.stringify({
        success: true,
        site: resolved.name,
        count: items.length,
        note: "Post IDs are NOT sequential. Use ONLY the IDs listed here for wp_read_post.",
        posts: items,
      });
    }

    return JSON.stringify({
      success: false,
      site: resolved.name,
      http_status: httpStatus,
      error: data,
    });
  },
};

// ---------------------------------------------------------------------------
// wp_read_post — read a single post's full content
// ---------------------------------------------------------------------------

export const wpReadPostTool: Tool = {
  name: "wp_read_post",
  definition: {
    type: "function",
    function: {
      name: "wp_read_post",
      description: `Read a single WordPress post's full content by ID.

WHEN TO USE:
- BEFORE editing a post's content with wp_publish
- To verify a post was published correctly after calling wp_publish
- To get the full HTML content of an existing post

HOW IT WORKS:
The full article HTML is saved to a temp file at /tmp/wp_content/<site>_<post_id>.html.
This file is the source of truth for the article content. You get back the file path +
metadata (title, status, categories, etc.) + a short content preview.

WORKFLOW for editing content:
1. Call wp_read_post — saves full HTML to file, returns file path
2. Use file_read to inspect the file if needed
3. Use file_edit to make targeted changes to the HTML file
4. Call wp_publish with post_id and content_file=<the file path>

This approach prevents content truncation and article destruction.`,
      parameters: {
        type: "object",
        properties: {
          site: {
            type: "string",
            description: "Site alias from WP_SITES config.",
          },
          post_id: {
            type: "integer",
            description: "The WordPress post ID to read.",
          },
        },
        required: ["post_id"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const resolved = resolveSite(args.site as string | undefined);
    if (typeof resolved === "string") {
      return JSON.stringify({ success: false, error: resolved });
    }

    const postId = args.post_id as number;
    const { status, data } = await wpFetch(resolved, `/posts/${postId}`);

    if (status >= 200 && status < 300) {
      const d = data as Record<string, unknown>;
      const content = (d.content as Record<string, string>)?.rendered ?? "";

      // Track this read so wp_publish can verify it was called first
      recordRead(resolved.name, postId, content);

      // Write full content to temp file — avoids inference adapter truncation
      if (!existsSync(WP_TEMP_DIR)) mkdirSync(WP_TEMP_DIR, { recursive: true });
      const contentFile = join(WP_TEMP_DIR, `${resolved.name}_${postId}.html`);
      writeFileSync(contentFile, content, "utf-8");

      // Compact response: only audit-relevant fields + file path for editing.
      // Full content is saved to content_file — use file_read to inspect.
      const plainText = stripHtml(content);
      const wordCount = plainText.split(/\s+/).filter(Boolean).length;

      return JSON.stringify({
        success: true,
        site: resolved.name,
        post_id: d.id,
        title: (d.title as Record<string, string>)?.rendered ?? "",
        status: d.status,
        date: (d.date as string)?.slice(0, 10) ?? "",
        link: d.link,
        word_count: wordCount,
        categories: d.categories,
        tags: d.tags,
        content_file: contentFile,
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
- User asks to republish or change post status

WORKFLOW for new posts:
1. Write the full HTML body to a temp file using file_write (e.g. /tmp/wp_content/new_post.html)
2. Call wp_publish with content_file=<that path> and status "draft"
3. If you have an image URL, call wp_media_upload first to get a media_id, then pass it as featured_media
4. Call wp_publish again with status "publish" and post_id to go live

IMPORTANT: NEVER pass long content inline via the "content" parameter — it will be truncated by
the inference engine. ALWAYS use file_write + content_file for any content longer than 2 paragraphs.

WORKFLOW for status-only changes (republish, unpublish, etc.):
1. Call wp_list_posts to find the post ID
2. Call wp_publish with post_id and status ONLY — do NOT include "content" or "content_file"
   Omitting content preserves the existing article body. No need for wp_read_post.

WORKFLOW for editing existing content (PREFERRED — prevents truncation):
1. Call wp_list_posts to find the post ID
2. Call wp_read_post — saves full HTML to a temp file, returns the file path in content_file
3. Use file_edit to make targeted changes to the HTML file
4. Call wp_publish with post_id and content_file=<the file path from step 2>
   The tool reads the full content from the file and publishes it.

CRITICAL: If you only want to change status, tags, categories, or featured_media — do NOT
include "content" or "content_file". The "content" field REPLACES the entire article body.

ALWAYS use content_file for any substantial content (new or existing). Write the HTML to a file
with file_write first, then pass the path here. Inline "content" is only safe for very short text.

DO NOT narrate or simulate publishing — you MUST call this tool. If it fails, report the actual error.

AFTER PUBLISHING: Report the post title, URL, status (draft/publish), and post ID.`,
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
              "Short post body in HTML (max 1-2 paragraphs). For longer content, use file_write + content_file instead to avoid truncation.",
          },
          content_file: {
            type: "string",
            description:
              "Path to an HTML file containing the full article body. Use this when editing existing posts: " +
              "wp_read_post saves content to a file, you edit it with file_edit, then pass the path here. " +
              "Preferred over 'content' for existing articles — avoids truncation.",
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
              "Existing post ID to update. Omit to create a new post. MUST call wp_read_post first to get current content.",
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
    const contentFile = args.content_file as string | undefined;

    // Resolve content: prefer content_file over inline content
    let newContent = args.content as string | undefined;
    if (contentFile) {
      if (!existsSync(contentFile)) {
        return JSON.stringify({
          success: false,
          error: `content_file not found: ${contentFile}. Call wp_read_post first to create it.`,
        });
      }
      newContent = readFileSync(contentFile, "utf-8");
    }

    // ---------- Guard 0: Edit-verification (content_file only) ----------
    // When publishing via content_file, verify the file was actually modified.
    // Catches the case where file_edit failed (old_string not found) but the
    // LLM proceeded to wp_publish anyway, publishing unchanged content.
    if (postId && contentFile && newContent) {
      const originalHash = getOriginalContentHash(resolved.name, postId);
      if (originalHash !== null && hashContent(newContent) === originalHash) {
        return JSON.stringify({
          success: false,
          error:
            "BLOCKED: content_file is identical to what wp_read_post saved — " +
            "file_edit likely failed (old_string not found). " +
            "Re-read the file with file_read, verify your old_string matches exactly, " +
            "then call file_edit again before retrying wp_publish.",
          post_id: postId,
          content_file: contentFile,
        });
      }
    }

    // ---------- Guard 1: Read-before-write enforcement ----------
    // When updating an existing post, wp_read_post MUST have been called first.
    // This is no longer advisory — it's enforced at the tool level.
    if (postId && newContent) {
      if (!wasReadRecently(resolved.name, postId)) {
        return JSON.stringify({
          success: false,
          error:
            "BLOCKED: You must call wp_read_post for this post BEFORE calling wp_publish. " +
            "This is required to prevent article destruction. Call wp_read_post(" +
            `post_id=${postId}) first, then modify the full content, then call wp_publish.`,
          post_id: postId,
        });
      }
    }

    // ---------- Guard 2: Content destruction safeguard ----------
    // When updating an existing post with new content, fetch the current
    // content and compare. Uses three layers:
    //   1. Text length ratio (stripped HTML) — threshold 80%
    //   2. Raw HTML length ratio — threshold 70%
    //   3. Structural element count — must not drop by more than 30%
    if (postId && newContent) {
      const { status: existingStatus, data: existingData } = await wpFetch(
        resolved,
        `/posts/${postId}`,
      );

      if (existingStatus >= 200 && existingStatus < 300) {
        const existing = existingData as Record<string, unknown>;
        const existingContent =
          (existing.content as Record<string, string>)?.rendered ?? "";
        const existingTextLen = stripHtml(existingContent).length;
        const newTextLen = stripHtml(newContent).length;
        const existingHtmlLen = existingContent.length;
        const newHtmlLen = newContent.length;
        const existingStructure = countStructuralElements(existingContent);
        const newStructure = countStructuralElements(newContent);

        const existingTitle =
          (existing.title as Record<string, string>)?.rendered ?? "";

        // Layer 1: Text content must be at least 80% of existing
        if (existingTextLen > 200 && newTextLen < existingTextLen * 0.8) {
          return JSON.stringify({
            success: false,
            error:
              `CONTENT DESTRUCTION BLOCKED: New text content (${newTextLen} chars) is ` +
              `only ${Math.round((newTextLen / existingTextLen) * 100)}% of existing article ` +
              `"${existingTitle}" (${existingTextLen} chars). ` +
              "You MUST include the FULL article text. Call wp_read_post, modify ONLY the " +
              "requested parts, and send the COMPLETE content.",
            existing_text_length: existingTextLen,
            new_text_length: newTextLen,
            ratio: Math.round((newTextLen / existingTextLen) * 100),
            post_id: postId,
          });
        }

        // Layer 2: Raw HTML must be at least 70% of existing
        if (existingHtmlLen > 300 && newHtmlLen < existingHtmlLen * 0.7) {
          return JSON.stringify({
            success: false,
            error:
              `CONTENT DESTRUCTION BLOCKED: New HTML (${newHtmlLen} chars) is ` +
              `only ${Math.round((newHtmlLen / existingHtmlLen) * 100)}% of existing HTML ` +
              `for "${existingTitle}" (${existingHtmlLen} chars). ` +
              "Significant formatting/structure is being lost. Use wp_read_post to get " +
              "the current HTML and preserve it.",
            existing_html_length: existingHtmlLen,
            new_html_length: newHtmlLen,
            post_id: postId,
          });
        }

        // Layer 3: Structural elements must not drop by more than 30%
        if (existingStructure >= 5 && newStructure < existingStructure * 0.7) {
          return JSON.stringify({
            success: false,
            error:
              `CONTENT DESTRUCTION BLOCKED: New content has ${newStructure} structural ` +
              `elements but existing article "${existingTitle}" has ${existingStructure}. ` +
              "Headings, paragraphs, or list items are being lost. Use wp_read_post " +
              "and preserve the document structure.",
            existing_elements: existingStructure,
            new_elements: newStructure,
            post_id: postId,
          });
        }
      }
    }

    const method = postId ? "PUT" : "POST";
    const path = postId ? `/posts/${postId}` : "/posts";

    const body: Record<string, unknown> = {};
    const fields = [
      "title",
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
    // Use resolved content (from content_file or inline content)
    if (newContent !== undefined) body.content = newContent;

    // Default to draft for safety
    if (!body.status && !postId) body.status = "draft";

    const { status, data } = await wpFetch(resolved, path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (status >= 200 && status < 300) {
      const d = data as Record<string, unknown>;
      const postStatus = d.status as string;
      const link =
        (d.link as string) ??
        ((d.guid as Record<string, string>)?.rendered || "");
      const result: Record<string, unknown> = {
        success: true,
        site: resolved.name,
        post_id: d.id,
        status: postStatus,
        title: (d.title as Record<string, string>)?.rendered ?? "",
      };
      // Only include the link if the post is published — draft links return 404
      // for unauthenticated visitors and confuse users.
      if (postStatus === "publish") {
        result.link = link;
      } else {
        result.note =
          `Post saved as ${postStatus}. The link will only work after publishing. ` +
          `To publish: call wp_publish with post_id=${d.id} and status="publish".`;
      }
      return JSON.stringify(result);
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

    // Support local file paths (from gemini_image) and HTTP URLs
    const isLocalFile =
      imageUrl.startsWith("file://") || imageUrl.startsWith("/");
    let imageBuffer: Buffer;
    let contentType: string;

    if (isLocalFile) {
      const filePath = imageUrl.startsWith("file://")
        ? imageUrl.slice(7)
        : imageUrl;
      if (!existsSync(filePath)) {
        return JSON.stringify({
          success: false,
          error: `Local file not found: ${filePath}`,
        });
      }
      imageBuffer = readFileSync(filePath) as Buffer;
      contentType = filename.endsWith(".png")
        ? "image/png"
        : filename.endsWith(".webp")
          ? "image/webp"
          : "image/jpeg";
    } else {
      // Download from URL
      const controller = new AbortController();
      const dlTimeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
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
        contentType = imgResponse.headers.get("content-type") ?? "image/jpeg";
        imageBuffer = Buffer.from(await imgResponse.arrayBuffer());
      } finally {
        clearTimeout(dlTimeout);
      }
    }

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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ success: false, error: message });
    } finally {
      clearTimeout(uploadTimeout);
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
