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
import { screenshotElementTool } from "../builtin/screenshot.js";
import {
  socialPublishTool,
  socialAccountsListTool,
  socialPublishStatusTool,
} from "../builtin/social.js";
import { humanizeTextTool } from "../builtin/writing.js";
import {
  dashboardGenerateTool,
  dashboardListTool,
} from "../builtin/dashboard.js";
import { batchDecomposeTool } from "../builtin/batch.js";
import { seoPageAuditTool } from "../builtin/seo-page-audit.js";
import { seoKeywordResearchTool } from "../builtin/seo-keyword-research.js";
import { seoMetaGenerateTool } from "../builtin/seo-meta-generate.js";
import { seoSchemaGenerateTool } from "../builtin/seo-schema-generate.js";
import { seoContentBriefTool } from "../builtin/seo-content-brief.js";
import { googleWorkspaceCliTool } from "../builtin/google-workspace-cli.js";
import {
  marketQuoteTool,
  marketHistoryTool,
  marketWatchlistAddTool,
  marketWatchlistRemoveTool,
  marketWatchlistListTool,
  marketBudgetStatsTool,
  marketIndicatorsTool,
  marketScanTool,
  macroRegimeTool,
  marketSignalsTool,
} from "../builtin/market.js";
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
  screenshotElementTool,
  humanizeTextTool,
  dashboardGenerateTool,
  dashboardListTool,
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
  batchDecomposeTool,
  seoPageAuditTool,
  seoKeywordResearchTool,
  seoMetaGenerateTool,
  seoSchemaGenerateTool,
  seoContentBriefTool,
  // F1 finance tools (v7.0 Phase β S1) — deferred, scope 'finance'
  marketQuoteTool,
  marketHistoryTool,
  marketWatchlistAddTool,
  marketWatchlistRemoveTool,
  marketWatchlistListTool,
  marketBudgetStatsTool,
  // F2+F4 indicator engine + scan (v7.0 Phase β S2) — deferred, scope 'finance'
  marketIndicatorsTool,
  marketScanTool,
  // F3+F5 signal detector + macro regime (v7.0 Phase β S3) — deferred, scope 'finance'
  macroRegimeTool,
  marketSignalsTool,
];

// Social publishing tools — conditionally registered when SOCIAL_PUBLISH_ENABLED is configured
const SOCIAL_TOOLS: Tool[] = [
  socialPublishTool,
  socialAccountsListTool,
  socialPublishStatusTool,
];

// CRM tools — conditionally registered when CRM_API_TOKEN is configured
const CRM_TOOLS: Tool[] = [crmQueryTool];

// Google Workspace CLI dispatch tool — registered when GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN
// are configured. v7.6 infrastructure unblocker for Chat, Tasks, People, Forms,
// Meet, Classroom, Admin Reports, Apps Script, Keep, Workspace Events. Per-call
// token injection via getAccessToken() — no parallel credential store.
const GWS_TOOLS: Tool[] = [googleWorkspaceCliTool];

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

    // Register social publishing tools when enabled
    if (process.env.SOCIAL_PUBLISH_ENABLED === "true") {
      for (const tool of SOCIAL_TOOLS) {
        registry.register(tool);
      }
      registered.push(...SOCIAL_TOOLS.map((t) => t.name));
    }

    // Register gws dispatch tool only when Google OAuth is configured.
    // The tool re-checks at call time via isGoogleConfigured() — the env
    // gate here just hides it from the inventory entirely when missing.
    if (
      process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GOOGLE_REFRESH_TOKEN
    ) {
      for (const tool of GWS_TOOLS) {
        registry.register(tool);
      }
      registered.push(...GWS_TOOLS.map((t) => t.name));
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
