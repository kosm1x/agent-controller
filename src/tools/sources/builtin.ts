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
import type { Tool } from "../types.js";

const BUILTIN_TOOLS: Tool[] = [
  shellTool,
  httpTool,
  fileReadTool,
  fileWriteTool,
  webSearchTool,
  webReadTool,
  weatherForecastTool,
  currencyConvertTool,
  geocodeAddressTool,
  chartGenerateTool,
  rssReadTool,
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
    return BUILTIN_TOOLS.map((t) => t.name);
  }

  async healthCheck(): Promise<ToolSourceHealth> {
    return { healthy: true, checkedAt: new Date().toISOString() };
  }

  async teardown(): Promise<void> {
    // Builtins need no teardown
  }
}
