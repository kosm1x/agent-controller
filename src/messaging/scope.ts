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
  "file_read", // Always available — reads .txt, .docx, downloaded attachments
  "list_dir", // Always available — browse VPS filesystem when user says "local"
  "task_history", // Always available — LLM can query its own past executions
  "jarvis_file_read", // NorthStar visions/goals live here
  "jarvis_file_list", // List files in Jarvis file system
];

/** Scheduling tools — only when reports/automation discussed. */
export const SCHEDULE_TOOLS = ["schedule_task", "delete_schedule"];

/** Google Workspace tools (added when GOOGLE_CLIENT_ID is set). */
export const GOOGLE_TOOLS = [
  "gmail_send",
  "gmail_search",
  "gmail_read",
  "gdrive_list",
  "gdrive_create",
  "gdrive_share",
  "gdrive_delete",
  "gdrive_move",
  "gdrive_upload",
  "calendar_list",
  "calendar_create",
  "calendar_update",
  "gsheets_read",
  "gsheets_write",
  "gdocs_read",
  "gdocs_write",
  "gdocs_replace",
  "gslides_read",
  "gslides_create",
  "gtasks_create",
];

/** Coding/file tools — only when code/files are the topic. */
export const CODING_TOOLS = [
  "shell_exec",
  "file_write",
  "file_edit",
  "file_delete",
  "grep",
  "glob",
  "list_dir",
  "git_status",
  "git_diff",
  "git_commit",
  "git_push",
  "gh_repo_create",
  "gh_create_pr",
  "jarvis_dev",
  "code_search",
  "jarvis_diagnose",
  "jarvis_test_run",
  "vps_deploy",
  "vps_backup",
  "vps_logs",
  "jarvis_propose_directive",
  "jarvis_apply_proposal",
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

/** CRM tools — only when sales/pipeline context detected. */
export const CRM_TOOLS_SCOPE = ["crm_query"];

/** Other utility tools — always included (keep minimal for token budget).
 *  v6.3.1: Trimmed from 30→10 tools. Niche tools moved to scope-gated groups
 *  or deferred (name+description only, full schema on first call). */
export const MISC_TOOLS = [
  // jarvis_file_read + jarvis_file_list already in CORE_TOOLS
  "jarvis_file_write", // Core write — needed for most tasks
  "jarvis_file_update", // Core update — append/metadata changes
  "jarvis_file_delete", // Deferred — schema on demand
  "jarvis_file_move", // Deferred — schema on demand
  "jarvis_file_search", // Deferred — schema on demand
  "list_schedules", // Read-only, lightweight
  "project_list", // Read-only, lightweight
  "video_status", // Always available — follow-ups about video status don't re-trigger video scope
  "vps_status", // Always available — "how's the server?" doesn't need coding scope
  "northstar_sync", // Always available — "sync con db.mycommit" shouldn't need NorthStar keywords
  // Lightpanda browser — only goto + markdown (the 90% use case)
  "browser__goto",
  "browser__markdown",
];

/** Lightpanda browser tools — scope-gated: only when browse/navegar/web keywords detected. */
export const BROWSER_EXTRA_TOOLS = [
  "browser__links",
  "browser__click",
  "browser__fill",
  "browser__scroll",
  "browser__evaluate",
  "browser__interactiveElements",
  "browser__semantic_tree",
  "browser__structuredData",
];

/** Specialty tools — keyword-gated to save tokens. */
export const SPECIALTY_TOOLS = [
  "chart_generate",
  "rss_read",
  "gemini_image",
  "hf_generate",
  "hf_spaces",
  "batch_decompose",
];

/** Gemini research tools — document analysis, Q&A, podcast generation.
 *  Scope-gated: only when research/analysis/study keywords detected. */
export const RESEARCH_TOOLS = [
  "gemini_upload",
  "gemini_research",
  "gemini_audio_overview",
  "knowledge_map",
  "knowledge_map_expand",
];

/** Playwright (Chromium) tools — scope-gated to avoid inflating token budget for all tasks.
 *  Lightpanda tools stay in MISC_TOOLS (always available, lightweight). */
export const BROWSER_TOOLS = [
  "playwright__browser_navigate",
  "playwright__browser_click",
  "playwright__browser_fill_form",
  "playwright__browser_snapshot",
  "playwright__browser_take_screenshot",
  "playwright__browser_press_key",
  "playwright__browser_select_option",
  "playwright__browser_tabs",
  "playwright__browser_wait_for",
  "playwright__browser_evaluate",
  "playwright__browser_type",
  "playwright__browser_close",
];

/** Video production tools — scope-gated: only when video/clip keywords detected. */
export const VIDEO_TOOLS = [
  "video_create",
  "video_status",
  "video_script",
  "video_tts",
  "video_image",
  "video_list_profiles",
  "video_list_voices",
  "video_background_download",
  "screenshot_element",
];

/** Social publishing tools — scope-gated: only when social/publish keywords detected. */
export const SOCIAL_TOOLS = [
  "social_publish",
  "social_accounts_list",
  "social_publish_status",
];

/** Intelligence Depot tools — scope-gated: only when signal/alert/intel keywords detected. */
export const INTEL_TOOLS = [
  "intel_query",
  "intel_status",
  "intel_alert_history",
  "intel_baseline",
];

// ---------------------------------------------------------------------------
// Default scope patterns
// ---------------------------------------------------------------------------

/** Keyword patterns that activate tool groups. Scans current + recent messages. */
export const DEFAULT_SCOPE_PATTERNS: ScopePattern[] = [
  {
    pattern:
      /\b(tareas?|tasks?|metas?|goals?|objetivos?|objectives?|visi[oó]n|pendientes?|productiv|priorid|sprint|diario|journal|briefing|resumen del d[ií]a|proyectos?|projects?|northstar|north\s*star|sync\w*\s+(?:\S+\s+)*(?:commit|mycommit|db\.mycommit)|db\.mycommit|sincroniza(?:r|ci[oó]n)?(?:\s+\S+){0,3}\s+(?:commit|northstar|mycommit))/i,
    group: "northstar_read",
  },
  // northstar_write — split into small patterns to avoid catastrophic regex backtracking.
  // Multiple entries with the same group are OR'd (any match activates the group).
  {
    // Create: "crea una tarea", "haz una tarea", "trackea", "quiero lograr"
    pattern:
      /\b(crea(r|me|te)?\s+(una?\s+)?(tarea|meta|objetivo|goal|task)|trackea|pon esto|agrega.*pendiente|haz una tarea|quiero lograr|me propongo)/i,
    group: "northstar_write",
  },
  {
    // Verb-first: "actualiza la tarea", "cambia el status", "renombra el objetivo"
    pattern:
      /\b(?:actual[ií]za|c[aá]mbia|ren[oó]mbra|mod[ií]fica|sincroniza|update|change|rename|modify)\S*(\s+\S+){0,3}\s*(tarea|meta|objetivo|goal|task|status|estado|nombre|name|title|repo)/i,
    group: "northstar_write",
  },
  {
    // Clitic pronouns: "cámbialo", "actualízalo", "renómbralo"
    pattern:
      /\b(?:c[aá]mbia|actual[ií]za|ren[oó]mbra|mod[ií]fica|change|update|rename|modify)(?:lo|la|los|las|rlo|rla|rlos|rlas)\b/i,
    group: "northstar_write",
  },
  {
    // Completion: "marca como completada", "pon como done", "márcalo"
    pattern:
      /\b(marc(?:a|ar|ála|alo)\s.*(complet|hech|done|termin)|pon(?:er|la|lo)?\s.*(complet|hech|done|termin|in.progress|on.hold|not.started)|m[aá]rcal[ao])/i,
    group: "northstar_write",
  },
  {
    // Completion + noun: "completé la tarea", "terminé el objetivo", "done esta task"
    pattern:
      /\b(complet(?:a|ar|ada|ado|é)|termin[aé]|hecha|hecho|\bdone)(\s+\S+){0,3}\s*(tarea|meta|objetivo|goal|task)/i,
    group: "northstar_write",
  },
  {
    // Noun-before-verb: "el objetivo... cámbialo", "la tarea... actualízala"
    pattern:
      /\b(tarea|meta|objetivo|goal|task)(\s+\S+){0,8}\s*(?:c[aá]mbia|actual[ií]za|ren[oó]mbra|mod[ií]fica|change|update|rename|modify)\S*/i,
    group: "northstar_write",
  },
  {
    pattern:
      /\b(gr[aá]fic|chart|rss|feed|noticias|investigar?|exa_search|genera.*imagen|image.*genera|gemini|hugging\s?face|hf_generate|hf_spaces|text.to.(?:speech|image|video|music)|genera.*(?:audio|video|voz|m[uú]sica)|(?:audio|video|voz|m[uú]sica).*genera|TTS\b|crea.*(?:audio|video|imagen|m[uú]sica|canci[oó]n)|genera.*(?:speech|music|song)|jingle|soundtrack|busca.*spaces?|humaniz|limpia.*\btexto\b|revisa\s+mi\s+texto|reescrib|dashboard|visualiz|KPI|m[eé]tric)/i,
    group: "specialty",
  },
  {
    pattern:
      /\b(research|investigaci[oó]n|anali[zs][ae]\w*(?:\s+\S+){0,2}\s+(?:documento|archivo|paper|PDF)|study\s*guide|gu[ií]a\s*de\s*estudio|podcast|audio\s*overview|notebook\s*lm|flashcards?|tarjetas?\s*de\s*estudio|quiz|cuestionario|briefing\s+d|resum(?:e|en)(?:\s+\S+){0,2}\s+(?:documento|archivo|PDF)|sube\w*(?:\s+\S+){0,2}\s+(?:documento|archivo|PDF)|upload\s+(?:\S+\s+)?document|gemini_(?:upload|research|audio)|deep\s+(?:dive|analysis|an[aá]lisis)|(?:qu[eé]|what)\s+(?:\S+\s+){0,3}documentos?|(?:lee|abre|open|read)\w*(?:\s+\S+){0,2}\s+(?:PDF|\.pdf)|\.pdf\b)/i,
    group: "research",
  },
  {
    pattern:
      /\b(escrib[eiao]\w*\s.*(diario|journal)|anota\w*\s.*(diario|journal)|registra\w*\s.*(diario|journal)|agrega\w*\s.*(diario|journal)|pon\w*\s.*(diario|journal)|crea\w*\s.*(entrada|entry).*(diario|journal)|journal\s*entry|diario.*escrib|write.*journal)/i,
    group: "northstar_journal",
  },
  {
    pattern:
      /\b(elimina(r|la|las|lo|los)?|borra(r|la|las|lo|los)?|delete|quita(r)?|remove)\b/i,
    group: "destructive",
  },
  {
    pattern:
      /\b(emails?|correos?|mails?|gmail|calendar|agenda|eventos?|citas?|reuni[oó]n|drive|document|hojas?|sheets?|slides?|present|google)/i,
    group: "google",
  },
  {
    pattern:
      /\b(naveg|browse|sitio web|p[aá]gina web|click|login|formulario|scrape|render|javascript|playwright|chromium|react|next\.?js|SPA|iniciar sesi[oó]n|log\s?in|sign\s?in|entra a|abre la app)\b/i,
    group: "browser",
  },
  {
    pattern:
      /\b(c[oó]digo|code|archivos?|files?|scripts?|deploy|edita(r)?\s+(el\s+)?(archivo|código|script)|grep|busca(r)?\s+en|estructura|directori|carpetas?|servers?|servidores?|git\b|github|commit|push(ea)?|npm\b|build\b|test\b|lint\b|bug\b|debug|typescript|javascript|python|react|node\.?js|funci[oó]n|rutina|programa(r|ción)?|repositori|repo\b|refactor|implementa|escrib[eiao]\w*\s+(?:\S+\s+){0,2}(?:c[oó]digo|script|rutina|funci[oó]n|programa|clase|m[oó]dulo)|jarvis_dev|mejora\s+tu|fix\s+your|arregla\s+tu|agrega\s+(?:un\s+)?(?:adapter|adaptador|tool|herramienta)|crea\s+(?:un\s+)?branch|abre\s+(?:un\s+)?pr)/i,
    group: "coding",
  },
  {
    pattern:
      /\b(schedules?|reportes?|programa(r|dos?|ción)?|cron|diarios?|semanal|automat\w*|recurrent|cada\s+\d+\s*(min|hora|h\b)|cada\s+(media\s+hora|hora)|repite\s+cada|repet[ií]r?\s+cada|peri[oó]dica(?:mente)?|recordatorio|reminder|av[ií]same\s+(cada|en\s+\d))/i,
    group: "schedule",
  },
  {
    pattern:
      /\b(wordpress|blogs?\s+(?:post|entry|article|entrada)|wp[-_]|publi(?:ca|car|que)\s+(?:en\s+)?(?:el\s+)?(?:blog|sitio|wordpress)|drafts?\s+(?:del?\s+)?blog|borrador\s+(?:del?\s+)?blog|featured\s*image|hero\s*image|plugin(?:s)?\s+(?:de\s+)?wp|theme\s+(?:de\s+)?wp|sitio\s+web|header|footer|tracker|tracking|GA4|analytics|widget|snippet|(?:livingjoyfully|redlightinsider)\.(?:art|com)|genera.*imagen.*blog|sube.*imagen.*(?:blog|wp|sitio)|media.*upload.*(?:blog|wp))/i,
    group: "wordpress",
  },
  {
    // CRM scope requires explicit mention of "CRM" or "Azteca" — prevents
    // false activation on generic sales words like "ventas" or "clientes".
    pattern: /\b(?:del?\s+)?(?:CRM|crm|azteca)\b/i,
    group: "crm",
  },
  {
    pattern:
      /\b(intel(?:ligencia|ligence)?|se[ñn]ales?|signals?|alertas?\s+del?\s+depot|depot|mercado|market|earthquake|terremoto|cyber|threat|anomal[iy]|baseline|z.?score|bitcoin|cripto|treasury|yield)/i,
    group: "intel",
  },
  {
    pattern:
      /\b(video|pel[ií]cula|clip|render|mp4|youtube|tiktok|reels|graba(r|ci[oó]n)?|hazme un video|overlay|fondo|background\s*video|narraci[oó]n|voz\s*(para|del)\s*video|screenshot|captura\s*(de\s*pantalla)?)\b/i,
    group: "video",
  },
  {
    pattern:
      /\b((?:publica(?:r|ci[oó]n)?|publique)\s+(?:\S+\s+){0,3}(?:en\s+)?(?:redes|instagram|facebook|tiktok|youtube)|publish\s+(?:to|on)\s|postea(?:r|lo)?|instagram|facebook(?!\s*auth)|redes\s*sociales|social\s*media|contenido\s+para\s+(?:redes|social)|programar?\s+(?:un\s+)?post|schedule\s+post)\b/i,
    group: "social",
  },
  {
    // Meta: user asks about tools, capabilities, or diagnostics → load ALL groups
    // so the LLM can give an accurate inventory instead of reporting tools as missing.
    pattern:
      /\b(auto.?diagn[oó]stic\w*|diagn[oó]stic\w*|nivel operativo|herramientas?\s+(?:disponibles?|activas?|funcional)|lista\w*\s+(?:todas?\s+)?(?:las?\s+)?(?:tools?|herramientas?)|tools?\s+(?:available|status|check)|capacidades|capabilities|funcionalidad(?:es)?)\b/i,
    group: "meta",
  },
];

// ---------------------------------------------------------------------------
// Pure scoping function
// ---------------------------------------------------------------------------

export interface ScopeOptions {
  hasGoogle: boolean;
  hasWordpress: boolean;
  hasMemory: boolean;
  hasCrm: boolean;
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
  /** Pre-classified groups from semantic classifier (v6.4 CL1.1). Bypasses regex. */
  preClassifiedGroups?: Set<string>,
): string[] {
  // v6.4 CL1.1: If semantic classifier provided groups, use them directly.
  // This bypasses the regex matching entirely — the LLM already understood intent.
  // Regex is only used when the classifier is unavailable (timeout, parse failure).
  let activeGroups: Set<string>;
  // Empty set = classifier said "no groups needed" (greetings). Null/undefined = fallback.
  if (preClassifiedGroups !== undefined && preClassifiedGroups !== null) {
    activeGroups = preClassifiedGroups;
    // URL-based scope injection — semantic classifier misses these because it
    // sees "URL" → "browser" instead of recognizing Google Workspace domains.
    if (
      /docs\.google\.com\/(document|spreadsheets|presentation)/i.test(
        currentMessage,
      )
    ) {
      activeGroups.add("google");
    }
  } else {
    activeGroups = new Set<string>();
    // Check if the CURRENT message triggers any scope groups on its own.
    // If not (pure conversational/personal message), don't inherit from prior turns —
    // this prevents the LLM from continuing a prior task when the user changed topics.
    const currentGroups = new Set<string>();
    for (const { pattern, group } of patterns) {
      if (pattern.test(currentMessage)) {
        currentGroups.add(group);
      }
    }
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
      (currentMessage.trim().length < 80 ||
        /\b(ejecuta|procede|hazlo|int[eé]ntalo|contin[uú]a|adelante|dale|verifica\s*y\s*ejecuta|vuelve?\s*a\s*intentar|reint[eé]ntalo|s[ií]guele|el\s+primer[oa]\s+que|eso\s+que\s+(?:te|me|le)|lo\s+(?:que|de|del)\s+(?:te|me|le)\s+(?:ped|dij|mand|envi|compart)|ese\s+(?:que|mismo)\s+(?:te|me|le)|tu\s+(?:ya\s+)?(?:lo|la)\s+(?:tienes|hiciste)|t[uú]\s+(?:ya\s+)?(?:lo|la)\s+(?:tienes|hiciste))\b/i.test(
          currentMessage,
        ))
    ) {
      // Follow-up message with no scope signals
      const priorText = recentUserMessages.join(" ");
      for (const { pattern, group } of patterns) {
        if (pattern.test(priorText)) {
          activeGroups.add(group);
        }
      }
    }
    // else: no scope signals and not a short follow-up → core tools only
  }

  // Assemble scoped tool list — start with minimal core
  const tools = [...CORE_TOOLS, ...MISC_TOOLS];

  // Meta: user asked about capabilities/diagnostics → load ALL groups
  // so the LLM sees every tool and can give an accurate inventory.
  if (activeGroups.has("meta")) {
    activeGroups.add("northstar_read");
    activeGroups.add("northstar_write");
    activeGroups.add("northstar_journal");
    activeGroups.add("destructive");
    activeGroups.add("specialty");
    activeGroups.add("research");
    activeGroups.add("intel");
    activeGroups.add("video");
    activeGroups.add("schedule");
    activeGroups.add("google");
    activeGroups.add("browser");
    activeGroups.add("coding");
    activeGroups.add("wordpress");
    activeGroups.add("crm");
  }

  if (
    activeGroups.has("northstar_read") ||
    activeGroups.has("northstar_write")
  ) {
    tools.push("northstar_sync");
  }
  if (activeGroups.has("specialty")) {
    tools.push(...SPECIALTY_TOOLS);
    // Niche tools activated by specialty context
    tools.push(
      "humanize_text",
      "dashboard_generate",
      "dashboard_list",
      "http_fetch",
      "pdf_read",
    );
  }
  if (activeGroups.has("research")) {
    tools.push(...RESEARCH_TOOLS);
    tools.push("pdf_read", "http_fetch");
  }
  if (activeGroups.has("intel")) {
    tools.push(...INTEL_TOOLS);
  }
  if (activeGroups.has("video")) {
    tools.push(...VIDEO_TOOLS);
  }
  if (activeGroups.has("social")) {
    tools.push(...SOCIAL_TOOLS);
  }
  if (activeGroups.has("schedule")) {
    tools.push(...SCHEDULE_TOOLS);
  }
  if (activeGroups.has("google") && options.hasGoogle) {
    tools.push(...GOOGLE_TOOLS);
  }
  if (activeGroups.has("browser")) {
    tools.push(...BROWSER_TOOLS, ...BROWSER_EXTRA_TOOLS);
  }
  if (activeGroups.has("coding")) {
    tools.push(...CODING_TOOLS);
    // Projects need write access in coding context
    tools.push("project_get", "project_update");
  }
  if (activeGroups.has("crm") && options.hasCrm) {
    tools.push(...CRM_TOOLS_SCOPE);
  }
  if (activeGroups.has("wordpress") && options.hasWordpress) {
    tools.push(...WORDPRESS_TOOLS);
    tools.push("humanize_text"); // Writing quality for blog posts
  }
  if (options.hasMemory) {
    tools.push("memory_search", "memory_store");
  }

  // Deduplicate: multiple scope groups can push the same tool
  return [...new Set(tools)];
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
