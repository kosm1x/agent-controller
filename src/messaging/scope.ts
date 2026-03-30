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
  "exa_search",
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
  "commit__create_suggestion",
];

/** COMMIT journal — only when user explicitly asks to write a journal entry. */
export const COMMIT_JOURNAL_TOOLS = ["commit__create_journal"];

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

/** Other utility tools — always included (keep minimal for token budget). */
export const MISC_TOOLS = [
  "http_fetch",
  "list_schedules",
  "project_list",
  "project_get",
  "project_update",
  "pdf_read",
  "browser__goto",
  "browser__markdown",
];

/** Specialty tools — keyword-gated to save tokens. */
export const SPECIALTY_TOOLS = [
  "chart_generate",
  "rss_read",
  "gemini_image",
  "hf_generate",
  "hf_spaces",
];

/** Gemini research tools — document analysis, Q&A, podcast generation.
 *  Scope-gated: only when research/analysis/study keywords detected. */
export const RESEARCH_TOOLS = [
  "gemini_upload",
  "gemini_research",
  "gemini_audio_overview",
];

/** Lightpanda interactive browser tools — only when web interaction needed.
 *  browser__goto and browser__markdown are always available via MISC_TOOLS. */
export const BROWSER_TOOLS = [
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
      /\b(tareas?|tasks?|metas?|goals?|objetivos?|objectives?|visi[oó]n|pendientes?|commit|productiv|priorid|sprint|COMMIT|diario|journal|briefing|resumen del d[ií]a|proyectos?|projects?)/i,
    group: "commit_read",
  },
  {
    pattern:
      /\b(crea(r|me)?\s+(una?\s+)?(tarea|meta|objetivo|goal|task)|trackea|pon esto|agrega.*pendiente|haz una tarea|quiero lograr|me propongo|sincroniza\S*(\s+\S+){0,3}\s*(tarea|meta|objetivo|goal|task|commit|repo)|actual[ií]za\S*(\s+\S+){0,3}\s*(tarea|meta|objetivo|goal|task|status|nombre|title)|c[aá]mbia\S*(\s+\S+){0,3}\s*(tarea|meta|objetivo|goal|task|status|estado|nombre|title)|ren[oó]mbra\S*(\s+\S+){0,3}\s*(tarea|meta|objetivo|goal|task)|(?:c[aá]mbia|actual[ií]za|ren[oó]mbra|mod[ií]fica)(?:lo|la|los|las|rlo|rla|rlos|rlas)\b|marc(?:a|ar|ála|alo)\s.*(complet|hech|done|termin)|pon(?:er|la|lo)?\s.*(complet|hech|done|termin|in.progress|on.hold|not.started)|m[aá]rcal[ao]|(complet(?:a|ar|ada|ado|é)|termin[aé]|hecha|hecho|\bdone)(\s+\S+){0,3}\s*(tarea|meta|objetivo|goal|task)|(tarea|meta|objetivo|goal|task)(\s+\S+){0,8}\s*(?:c[aá]mbia|actual[ií]za|ren[oó]mbra|mod[ií]fica)\S*)/i,
    group: "commit_write",
  },
  {
    pattern:
      /\b(gr[aá]fic|chart|rss|feed|noticias|investigar?|exa_search|genera.*imagen|image.*genera|gemini|hugging\s?face|hf_generate|hf_spaces|text.to.(?:speech|image|video|music)|genera.*(?:audio|video|voz|m[uú]sica)|(?:audio|video|voz|m[uú]sica).*genera|TTS\b|crea.*(?:audio|video|imagen|m[uú]sica|canci[oó]n)|genera.*(?:speech|music|song)|jingle|soundtrack|busca.*spaces?)/i,
    group: "specialty",
  },
  {
    pattern:
      /\b(research|investigaci[oó]n|anali[zs][ae]\w*(?:\s+\S+){0,2}\s+(?:documento|archivo|paper|PDF)|study\s*guide|gu[ií]a\s*de\s*estudio|podcast|audio\s*overview|notebook\s*lm|flashcards?|tarjetas?\s*de\s*estudio|quiz|cuestionario|briefing\s+d|resum(?:e|en)(?:\s+\S+){0,2}\s+(?:documento|archivo|PDF)|sube\w*(?:\s+\S+){0,2}\s+(?:documento|archivo|PDF)|upload\s+(?:\S+\s+)?document|gemini_(?:upload|research|audio)|deep\s+(?:dive|analysis|an[aá]lisis)|(?:qu[eé]|what)\s+(?:\S+\s+){0,3}documentos?)/i,
    group: "research",
  },
  {
    pattern:
      /\b(escrib[eiao]\w*\s.*(diario|journal)|anota\w*\s.*(diario|journal)|registra\w*\s.*(diario|journal)|agrega\w*\s.*(diario|journal)|pon\w*\s.*(diario|journal)|crea\w*\s.*(entrada|entry).*(diario|journal)|journal\s*entry|diario.*escrib|write.*journal)/i,
    group: "commit_journal",
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
      /\b(naveg|browse|sitio web|p[aá]gina web|click|login|formulario|scrape|render|javascript)\b/i,
    group: "browser",
  },
  {
    pattern:
      /\b(c[oó]digo|code|archivos?|files?|scripts?|deploy|edita(r)?\s+(el\s+)?(archivo|código|script)|grep|busca(r)?\s+en|estructura|directori|carpetas?|servers?|servidores?|git\b|npm\b|build\b|test\b|lint\b|bug\b|debug)/i,
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
  // Check if the CURRENT message triggers any scope groups on its own.
  // If not (pure conversational/personal message), don't inherit from prior turns —
  // this prevents the LLM from continuing a prior task when the user changed topics.
  const currentGroups = new Set<string>();
  for (const { pattern, group } of patterns) {
    if (pattern.test(currentMessage)) {
      currentGroups.add(group);
    }
  }

  const activeGroups = new Set<string>();
  if (currentGroups.size > 0) {
    // Current message has scope signals — also scan prior messages for context
    const contextText = `${currentMessage} ${recentUserMessages.join(" ")}`;
    for (const { pattern, group } of patterns) {
      if (pattern.test(contextText)) {
        activeGroups.add(group);
      }
    }
  } else if (
    recentUserMessages.length > 0 &&
    (currentMessage.trim().length < 50 ||
      /\b(ejecuta|procede|hazlo|int[eé]ntalo|contin[uú]a|adelante|dale|verifica\s*y\s*ejecuta|vuelve?\s*a\s*intentar|reint[eé]ntalo|s[ií]guele)\b/i.test(
        currentMessage,
      ))
  ) {
    // Follow-up message with no scope signals — either short (<50 chars) or
    // contains imperative verbs that delegate execution without introducing
    // a new topic. Inherit scope from recent messages to maintain context
    // continuity. Without this, the LLM loses access to tools it just
    // used and may hallucinate that capabilities don't exist.
    const priorText = recentUserMessages.join(" ");
    for (const { pattern, group } of patterns) {
      if (pattern.test(priorText)) {
        activeGroups.add(group);
      }
    }
  }
  // else: no scope signals and not a short follow-up → core tools only

  // Assemble scoped tool list — start with minimal core
  const tools = [...CORE_TOOLS, ...MISC_TOOLS];

  // COMMIT tools (read + write) only when productivity context is present
  if (activeGroups.has("commit_write") || activeGroups.has("commit_read")) {
    tools.push(...COMMIT_READ_TOOLS);
  }
  if (activeGroups.has("commit_write")) {
    tools.push(...COMMIT_WRITE_TOOLS);
  }
  if (activeGroups.has("specialty")) {
    tools.push(...SPECIALTY_TOOLS);
  }
  if (activeGroups.has("research")) {
    tools.push(...RESEARCH_TOOLS);
  }
  if (activeGroups.has("commit_journal")) {
    tools.push(...COMMIT_JOURNAL_TOOLS);
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
  // Two-phase isolation: same logic as scopeToolsForMessage.
  // Only inherit from prior messages if current has scope signals.
  const currentGroups = new Set<string>();
  for (const { pattern, group } of patterns) {
    if (pattern.test(currentMessage)) {
      currentGroups.add(group);
    }
  }

  if (currentGroups.size === 0) return currentGroups;

  const contextText = `${currentMessage} ${recentUserMessages.join(" ")}`;
  const active = new Set<string>();
  for (const { pattern, group } of patterns) {
    if (pattern.test(contextText)) {
      active.add(group);
    }
  }
  return active;
}
