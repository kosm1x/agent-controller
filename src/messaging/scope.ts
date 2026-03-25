/**
 * Tool scoping — pure functions for dynamic tool selection.
 *
 * Extracted from router.ts to enable testing and sandbox evaluation
 * in the tuning system without side effects.
 */

import type { ScopePattern } from "../tuning/types.js";

// ---------------------------------------------------------------------------
// Tool groups — organized for dynamic scoping
// ---------------------------------------------------------------------------

/** Always included: essential tools for every conversation. */
export const CORE_TOOLS = [
  "user_fact_set",
  "user_fact_list",
  "user_fact_delete",
  "web_search",
  "web_read",
  "skill_save",
  "skill_list",
];

/** COMMIT read tools — included by default for quick lookups. */
export const COMMIT_READ_TOOLS = [
  "commit__get_daily_snapshot",
  "commit__get_hierarchy",
  "commit__list_tasks",
  "commit__list_goals",
  "commit__list_objectives",
  "commit__search_journal",
  "commit__list_ideas",
];

/** COMMIT write tools — only when productivity management is the topic. */
export const COMMIT_WRITE_TOOLS = [
  "commit__update_status",
  "commit__complete_recurring",
  "commit__create_task",
  "commit__create_goal",
  "commit__create_objective",
  "commit__create_vision",
  "commit__update_task",
  "commit__update_objective",
  "commit__update_goal",
  "commit__update_vision",
  "commit__bulk_reprioritize",
];

/** Destructive COMMIT tools — only on explicit deletion keywords. */
export const COMMIT_DESTRUCTIVE_TOOLS = ["commit__delete_item"];

/** Scheduling tools — only when reports/automation discussed. */
export const SCHEDULE_TOOLS = ["schedule_task", "delete_schedule"];

/** Google Workspace tools (added when GOOGLE_CLIENT_ID is set). */
export const GOOGLE_TOOLS = [
  "gmail_send",
  "gmail_search",
  "gdrive_list",
  "gdrive_create",
  "gdrive_share",
  "calendar_list",
  "calendar_create",
  "calendar_update",
  "gsheets_read",
  "gsheets_write",
  "gdocs_read",
  "gdocs_write",
  "gslides_create",
  "gtasks_create",
];

/** Coding/file tools — only when code/files are the topic. */
export const CODING_TOOLS = [
  "shell_exec",
  "file_read",
  "file_write",
  "file_edit",
  "grep",
  "glob",
  "list_dir",
];

/** WordPress tools — content + admin, only when blog/site management discussed. */
export const WORDPRESS_TOOLS = [
  "wp_list_posts",
  "wp_read_post",
  "wp_publish",
  "wp_media_upload",
  "wp_categories",
  "wp_pages",
  "wp_plugins",
  "wp_settings",
  "wp_delete",
  "wp_raw_api",
];

/** Other utility tools — always included (lightweight definitions). */
export const MISC_TOOLS = [
  "http_fetch",
  "chart_generate",
  "rss_read",
  "list_schedules",
  "gemini_image",
  "project_list",
  "project_get",
  "project_update",
  "exa_search",
];

/** Lightpanda browser tools — only when web interaction needed. */
export const BROWSER_TOOLS = [
  "browser__goto",
  "browser__markdown",
  "browser__links",
  "browser__evaluate",
  "browser__semantic_tree",
  "browser__interactiveElements",
  "browser__structuredData",
  "browser__click",
  "browser__fill",
  "browser__scroll",
];

// ---------------------------------------------------------------------------
// Default scope patterns
// ---------------------------------------------------------------------------

/** Keyword patterns that activate tool groups. Scans current + recent messages. */
export const DEFAULT_SCOPE_PATTERNS: ScopePattern[] = [
  {
    pattern:
      /\b(crea(r|me)?|actualiz|complet|tareas?|tasks?|metas?|goals?|objetivos?|objectives?|visi[oó]n|pendientes?|commit|productiv|priorid|sprint|haz una|agrega|trackea|pon esto|necesito|tengo que|hay que|deber[ií]a|recu[eé]rdame|no olvides|quiero lograr|me propongo)/i,
    group: "commit_write",
  },
  {
    pattern:
      /\b(elimina(r|la|las|lo|los)?|borra(r|la|las|lo|los)?|delete|quita(r)?|remove)\b/i,
    group: "commit_destructive",
  },
  {
    pattern:
      /\b(emails?|correos?|mails?|gmail|calendar|agenda|eventos?|citas?|reuni[oó]n|drive|document|hojas?|sheets?|slides?|present|google)/i,
    group: "google",
  },
  {
    pattern:
      /\b(naveg|browse|sitio|p[aá]gina|verific|click|login|form|scrape|interact|render|javascript)/i,
    group: "browser",
  },
  {
    pattern:
      /\b(c[oó]digo|code|archivos?|files?|scripts?|deploy|edita|grep|busca(r)?\s+en|estructura|directori|carpetas?|servers?|servidores?|git|npm|build|test|lint|bug|error|fix|debug)/i,
    group: "coding",
  },
  {
    pattern:
      /\b(schedules?|reportes?|programa(r|dos?|ción)?|cron|diarios?|semanal|automat\w*|recurrent)/i,
    group: "schedule",
  },
  {
    pattern:
      /\b(wordpress|wp|blogs?|posts?|art[ií]culos?|publi(ca|car|que)|drafts?|borrador|featured\s*image|hero\s*image|categor[iy]|tags?|plugin|theme|tema|sitio\s+web|header|footer|inyect|inject|tracker|tracking|GA4|analytics|widget|snippet|livingjoyfully|redlightinsider|genera.*imagen|image.*genera|gemini.*imag|imag.*blog|sube.*imagen|upload.*image|media.*upload)/i,
    group: "wordpress",
  },
];

// ---------------------------------------------------------------------------
// Pure scoping function
// ---------------------------------------------------------------------------

export interface ScopeOptions {
  hasGoogle: boolean;
  hasWordpress: boolean;
  hasMemory: boolean;
}

/**
 * Determine which tools to include based on message content.
 *
 * Pure function — no side effects, no process.env reads, no singletons.
 * All external state is passed via parameters.
 *
 * @returns Array of tool names that should be available for this message.
 */
export function scopeToolsForMessage(
  currentMessage: string,
  recentUserMessages: string[],
  patterns: ScopePattern[],
  options: ScopeOptions,
): string[] {
  const contextText = `${currentMessage} ${recentUserMessages.join(" ")}`;

  // Detect which groups are needed
  const activeGroups = new Set<string>();
  for (const { pattern, group } of patterns) {
    if (pattern.test(contextText)) {
      activeGroups.add(group);
    }
  }

  // Assemble scoped tool list
  const tools = [...CORE_TOOLS, ...COMMIT_READ_TOOLS, ...MISC_TOOLS];

  if (activeGroups.has("commit_write")) {
    tools.push(...COMMIT_WRITE_TOOLS);
  }
  if (activeGroups.has("commit_destructive")) {
    tools.push(...COMMIT_DESTRUCTIVE_TOOLS);
  }
  if (activeGroups.has("schedule")) {
    tools.push(...SCHEDULE_TOOLS);
  }
  if (activeGroups.has("google") && options.hasGoogle) {
    tools.push(...GOOGLE_TOOLS);
  }
  if (activeGroups.has("browser")) {
    tools.push(...BROWSER_TOOLS);
  }
  if (activeGroups.has("coding")) {
    tools.push(...CODING_TOOLS);
  }
  if (activeGroups.has("wordpress") && options.hasWordpress) {
    tools.push(...WORDPRESS_TOOLS);
  }
  if (options.hasMemory) {
    tools.push("memory_search", "memory_store");
  }

  return tools;
}

/**
 * Detect which scope groups are active for a message.
 *
 * Utility for the eval harness — returns just the group names,
 * without assembling the full tool list.
 */
export function detectActiveGroups(
  currentMessage: string,
  recentUserMessages: string[],
  patterns: ScopePattern[],
): Set<string> {
  const contextText = `${currentMessage} ${recentUserMessages.join(" ")}`;
  const active = new Set<string>();
  for (const { pattern, group } of patterns) {
    if (pattern.test(contextText)) {
      active.add(group);
    }
  }
  return active;
}
