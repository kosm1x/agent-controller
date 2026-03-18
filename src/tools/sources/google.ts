/**
 * Google Workspace tool source — wraps 14 Google API tools.
 */

import type { ToolRegistry } from "../registry.js";
import type {
  ToolSource,
  ToolSourceManifest,
  ToolSourceHealth,
} from "../source.js";
import {
  getAccessToken,
  isGoogleConfigured,
  resetTokenCache,
} from "../../google/auth.js";

export class GoogleToolSource implements ToolSource {
  readonly manifest: ToolSourceManifest = {
    name: "google",
    version: "1.0.0",
    description:
      "Google Workspace tools (Gmail, Drive, Calendar, Docs, Sheets, Slides, Tasks)",
  };

  async initialize(): Promise<void> {
    if (!isGoogleConfigured()) {
      throw new Error(
        "Google OAuth not configured (missing GOOGLE_CLIENT_ID or GOOGLE_REFRESH_TOKEN)",
      );
    }
  }

  async registerTools(registry: ToolRegistry): Promise<string[]> {
    const names: string[] = [];

    const { gmailSendTool, gmailSearchTool } =
      await import("../builtin/google-gmail.js");
    const { gdriveListTool, gdriveCreateTool, gdriveShareTool } =
      await import("../builtin/google-drive.js");
    const { calendarListTool, calendarCreateTool, calendarUpdateTool } =
      await import("../builtin/google-calendar.js");
    const {
      gsheetsReadTool,
      gsheetsWriteTool,
      gdocsReadTool,
      gdocsWriteTool,
      gslidesCreateTool,
      gtasksCreateTool,
    } = await import("../builtin/google-docs.js");

    const tools = [
      gmailSendTool,
      gmailSearchTool,
      gdriveListTool,
      gdriveCreateTool,
      gdriveShareTool,
      calendarListTool,
      calendarCreateTool,
      calendarUpdateTool,
      gsheetsReadTool,
      gsheetsWriteTool,
      gdocsReadTool,
      gdocsWriteTool,
      gslidesCreateTool,
      gtasksCreateTool,
    ];

    for (const tool of tools) {
      registry.register(tool);
      names.push(tool.name);
    }

    return names;
  }

  async healthCheck(): Promise<ToolSourceHealth> {
    try {
      await getAccessToken();
      return { healthy: true, checkedAt: new Date().toISOString() };
    } catch (err) {
      return {
        healthy: false,
        message: err instanceof Error ? err.message : String(err),
        checkedAt: new Date().toISOString(),
      };
    }
  }

  async teardown(): Promise<void> {
    resetTokenCache();
  }
}
