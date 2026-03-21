/**
 * Builtin tool source — registers all core built-in tools.
 */

import type { ToolRegistry } from "../registry.js";
import type {
  ToolSource,
  ToolSourceManifest,
  ToolSourceHealth,
} from "../source.js";
import { shellTool } from "../builtin/shell.js";
import { httpTool } from "../builtin/http.js";
import { fileReadTool, fileWriteTool } from "../builtin/file.js";
import { webSearchTool } from "../builtin/web-search.js";
import { webReadTool } from "../builtin/web-read.js";
import { weatherForecastTool } from "../builtin/weather.js";
import { currencyConvertTool } from "../builtin/currency.js";
import { geocodeAddressTool } from "../builtin/geocoding.js";
import { chartGenerateTool } from "../builtin/chart.js";
import { rssReadTool } from "../builtin/rss.js";
import {
  scheduleTaskTool,
  listSchedulesTool,
  deleteScheduleTool,
} from "../builtin/schedule.js";
import {
  userFactSetTool,
  userFactListTool,
  userFactDeleteTool,
} from "../builtin/user-facts.js";
import {
  evolutionGetDataTool,
  evolutionDeactivateSkillTool,
} from "../builtin/evolution-data.js";
import { fileEditTool } from "../builtin/code-editing.js";
import { grepTool, globTool, listDirTool } from "../builtin/code-search.js";
import {
  wpPublishTool,
  wpMediaUploadTool,
  wpCategoriesTool,
  wpListPostsTool,
  wpReadPostTool,
} from "../builtin/wordpress.js";
import type { Tool } from "../types.js";

const BUILTIN_TOOLS: Tool[] = [
  shellTool,
  httpTool,
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  grepTool,
  globTool,
  listDirTool,
  webSearchTool,
  webReadTool,
  weatherForecastTool,
  currencyConvertTool,
  geocodeAddressTool,
  chartGenerateTool,
  rssReadTool,
  scheduleTaskTool,
  listSchedulesTool,
  deleteScheduleTool,
  userFactSetTool,
  userFactListTool,
  userFactDeleteTool,
  evolutionGetDataTool,
  evolutionDeactivateSkillTool,
];

// WordPress tools — conditionally registered when WP_URL is configured
const WP_TOOLS: Tool[] = [
  wpListPostsTool,
  wpReadPostTool,
  wpPublishTool,
  wpMediaUploadTool,
  wpCategoriesTool,
];

export class BuiltinToolSource implements ToolSource {
  readonly manifest: ToolSourceManifest = {
    name: "builtin",
    version: "1.0.0",
    description: "Core built-in tools (shell, http, file, web, utilities)",
  };

  async initialize(): Promise<void> {
    // Builtins need no setup
  }

  async registerTools(registry: ToolRegistry): Promise<string[]> {
    for (const tool of BUILTIN_TOOLS) {
      registry.register(tool);
    }
    const registered = BUILTIN_TOOLS.map((t) => t.name);

    // Register WordPress tools only when configured
    if (process.env.WP_SITES) {
      for (const tool of WP_TOOLS) {
        registry.register(tool);
      }
      registered.push(...WP_TOOLS.map((t) => t.name));
    }

    return registered;
  }

  async healthCheck(): Promise<ToolSourceHealth> {
    return { healthy: true, checkedAt: new Date().toISOString() };
  }

  async teardown(): Promise<void> {
    // Builtins need no teardown
  }
}
