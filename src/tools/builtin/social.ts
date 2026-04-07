/**
 * Social Publishing Tools (v6.3 D2)
 *
 * Tool stubs for multi-platform social media publishing.
 * Full implementation requires Meta/TikTok/YouTube OAuth apps.
 * Scaffolding ships first — OAuth wired when credentials are ready.
 */

import type { Tool } from "../types.js";

const NOT_CONFIGURED_MSG =
  "Social publishing not configured. Register a Meta/TikTok/YouTube OAuth app and set SOCIAL_PUBLISH_ENABLED=true in .env. See V6-ROADMAP.md for setup checklist.";

// ---------------------------------------------------------------------------
// social_publish
// ---------------------------------------------------------------------------

export const socialPublishTool: Tool = {
  name: "social_publish",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "social_publish",
      description: `Publish content to a social media platform.

USE WHEN:
- User asks to post to Facebook, Instagram, TikTok, or YouTube
- Publishing video/image content created by video_create
- Scheduling social media posts for a client

REQUIRES: Social publishing configured (SOCIAL_PUBLISH_ENABLED=true + OAuth credentials).

WORKFLOW:
1. Verify account exists: social_accounts_list platform:"instagram"
2. Publish: social_publish account_id:"..." content_type:"video" media_url:"..." description:"..."
3. Check status: social_publish_status record_id:"..."`,
      parameters: {
        type: "object",
        properties: {
          account_id: {
            type: "string",
            description: "Social account ID (from social_accounts_list)",
          },
          platform: {
            type: "string",
            enum: [
              "facebook",
              "instagram",
              "tiktok",
              "youtube",
              "twitter",
              "linkedin",
            ],
            description: "Target platform",
          },
          content_type: {
            type: "string",
            enum: ["text", "image", "video", "carousel"],
            description: "Type of content to publish",
          },
          title: {
            type: "string",
            description: "Post title (YouTube, LinkedIn)",
          },
          description: {
            type: "string",
            description: "Post description / caption",
          },
          media_url: {
            type: "string",
            description: "Path to media file (image/video) to upload",
          },
          topics: {
            type: "array",
            items: { type: "string" },
            description: "Hashtags / topics",
          },
          scheduled_at: {
            type: "string",
            description:
              "ISO datetime for scheduled publishing (omit for immediate)",
          },
        },
        required: ["account_id", "platform", "content_type"],
      },
    },
  },

  async execute(): Promise<string> {
    // Stub — returns not-configured until OAuth is wired
    return JSON.stringify({ error: NOT_CONFIGURED_MSG });
  },
};

// ---------------------------------------------------------------------------
// social_accounts_list
// ---------------------------------------------------------------------------

export const socialAccountsListTool: Tool = {
  name: "social_accounts_list",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "social_accounts_list",
      description: `List configured social media accounts.

USE WHEN:
- Checking which platforms are connected
- Looking up account_id before publishing`,
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: [
              "facebook",
              "instagram",
              "tiktok",
              "youtube",
              "twitter",
              "linkedin",
            ],
            description: "Filter by platform (optional)",
          },
        },
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    try {
      const { listSocialAccounts } = await import("../../db/social-schema.js");
      const platform = args.platform as string | undefined;
      const accounts = listSocialAccounts(platform);

      if (accounts.length === 0) {
        return JSON.stringify({
          accounts: [],
          message: platform
            ? `No ${platform} accounts configured.`
            : "No social accounts configured. Add accounts via the admin API or .env setup.",
        });
      }

      return JSON.stringify({
        count: accounts.length,
        accounts: accounts.map((a) => ({
          id: a.id,
          platform: a.platform,
          name: a.account_name,
          project: a.project_id,
        })),
      });
    } catch (err) {
      return JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};

// ---------------------------------------------------------------------------
// social_publish_status
// ---------------------------------------------------------------------------

export const socialPublishStatusTool: Tool = {
  name: "social_publish_status",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "social_publish_status",
      description: `Check the status of a social media publish operation.

USE WHEN:
- After social_publish to verify the post went live
- Checking scheduled post status`,
      parameters: {
        type: "object",
        properties: {
          record_id: {
            type: "string",
            description: "Publish record ID (returned by social_publish)",
          },
        },
        required: ["record_id"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const recordId = args.record_id as string;
    if (!recordId) return JSON.stringify({ error: "record_id is required" });

    try {
      const { getPublishRecord } = await import("../../db/social-schema.js");
      const record = getPublishRecord(recordId);

      if (!record) {
        return JSON.stringify({
          error: `Publish record not found: ${recordId}`,
        });
      }

      return JSON.stringify(record);
    } catch (err) {
      return JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};
