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
import {
  fileReadTool,
  fileWriteTool,
  fileDeleteTool,
} from "../builtin/file.js";
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
import {
  grepTool,
  globTool,
  listDirTool,
  codeSearchTool,
} from "../builtin/code-search.js";
import {
  wpPublishTool,
  wpMediaUploadTool,
  wpCategoriesTool,
  wpListPostsTool,
  wpReadPostTool,
} from "../builtin/wordpress.js";
import {
  wpPagesTool,
  wpPluginsTool,
  wpSettingsTool,
  wpDeleteTool,
  wpRawApiTool,
} from "../builtin/wordpress-admin.js";
import { geminiImageTool } from "../builtin/gemini-image.js";
import {
  projectListTool,
  projectGetTool,
  projectUpdateTool,
} from "../builtin/projects.js";
import { exaSearchTool } from "../builtin/exa-search.js";
import { pdfReadTool } from "../builtin/pdf-read.js";
import { hfGenerateTool, hfSpacesTool } from "../builtin/huggingface.js";
import {
  geminiUploadTool,
  geminiResearchTool,
  geminiAudioOverviewTool,
} from "../builtin/gemini-research.js";
import { taskHistoryTool } from "../builtin/task-history.js";
import { crmQueryTool } from "../builtin/crm-query.js";
import {
  jarvisFileReadTool,
  jarvisFileWriteTool,
  jarvisFileUpdateTool,
  jarvisFileListTool,
  jarvisFileDeleteTool,
  jarvisFileMoveTool,
  jarvisFileSearchTool,
} from "../builtin/jarvis-files.js";
import { jarvisInitTool } from "../builtin/jarvis-init.js";
import { northstarSyncTool } from "../builtin/northstar-sync.js";
import {
  knowledgeMapTool,
  knowledgeMapExpandTool,
} from "../builtin/knowledge-map.js";
import { intelQueryTool } from "../builtin/intel-query.js";
import { intelStatusTool } from "../builtin/intel-status.js";
import { intelAlertHistoryTool } from "../builtin/intel-alert-history.js";
import { intelBaselineTool } from "../builtin/intel-baseline.js";
import {
  gitStatusTool,
  gitDiffTool,
  gitCommitTool,
  gitPushTool,
  ghRepoCreateTool,
  ghCreatePrTool,
} from "../builtin/git.js";
import { jarvisDevTool } from "../builtin/jarvis-dev.js";
import {
  jarvisDiagnoseTool,
  jarvisTestRunTool,
} from "../builtin/jarvis-self-repair.js";
import {
  vpsStatusTool,
  vpsDeployTool,
  vpsBackupTool,
  vpsLogsTool,
} from "../builtin/vps-management.js";
import {
  jarvisProposeTool,
  jarvisApplyProposalTool,
} from "../builtin/jarvis-directives.js";
import {
  videoCreateTool,
  videoStatusTool,
  videoScriptTool,
  videoTtsTool,
  videoImageTool,
  videoListProfilesTool,
  videoListVoicesTool,
  videoBackgroundDownloadTool,
} from "../builtin/video.js";
import type { Tool } from "../types.js";

const BUILTIN_TOOLS: Tool[] = [
  shellTool,
  httpTool,
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  fileDeleteTool,
  grepTool,
  globTool,
  listDirTool,
  codeSearchTool,
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
  geminiImageTool,
  projectListTool,
  projectGetTool,
  projectUpdateTool,
  exaSearchTool,
  pdfReadTool,
  hfGenerateTool,
  hfSpacesTool,
  geminiUploadTool,
  geminiResearchTool,
  geminiAudioOverviewTool,
  taskHistoryTool,
  intelQueryTool,
  intelStatusTool,
  intelAlertHistoryTool,
  intelBaselineTool,
  gitStatusTool,
  gitDiffTool,
  gitCommitTool,
  gitPushTool,
  ghRepoCreateTool,
  ghCreatePrTool,
  jarvisDevTool,
  jarvisDiagnoseTool,
  jarvisTestRunTool,
  vpsStatusTool,
  vpsDeployTool,
  vpsBackupTool,
  vpsLogsTool,
  jarvisProposeTool,
  jarvisApplyProposalTool,
  videoCreateTool,
  videoStatusTool,
  videoScriptTool,
  videoTtsTool,
  videoImageTool,
  videoListProfilesTool,
  videoListVoicesTool,
  videoBackgroundDownloadTool,
  jarvisFileReadTool,
  jarvisFileWriteTool,
  jarvisFileUpdateTool,
  jarvisFileListTool,
  jarvisFileDeleteTool,
  jarvisFileMoveTool,
  jarvisFileSearchTool,
  jarvisInitTool,
  northstarSyncTool,
  knowledgeMapTool,
  knowledgeMapExpandTool,
];

// CRM tools — conditionally registered when CRM_API_TOKEN is configured
const CRM_TOOLS: Tool[] = [crmQueryTool];

// WordPress tools — conditionally registered when WP_SITES is configured
const WP_TOOLS: Tool[] = [
  wpListPostsTool,
  wpReadPostTool,
  wpPublishTool,
  wpMediaUploadTool,
  wpCategoriesTool,
  wpPagesTool,
  wpPluginsTool,
  wpSettingsTool,
  wpDeleteTool,
  wpRawApiTool,
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

    // Register CRM tools only when configured
    if (process.env.CRM_API_TOKEN) {
      for (const tool of CRM_TOOLS) {
        registry.register(tool);
      }
      registered.push(...CRM_TOOLS.map((t) => t.name));
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
