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
  "gdocs_read_full",
  "gdocs_write",
  "gdocs_replace",
  "gslides_read",
  "gslides_create",
  "gtasks_create",
  // v7.6: gws CLI dispatch tool for Workspace services without a dedicated
  // handler (Chat, Tasks, People, Forms, Meet, Classroom, Admin Reports,
  // Apps Script, Keep, Workspace Events, Model Armor). Deferred — schema
  // loads on first call to preserve prompt budget.
  "google_workspace_cli",
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
 *  or deferred (name+description only, full schema on first call).
 *  2026-04-14: jarvis_file write tools moved to JARVIS_WRITE_TOOLS (see below).
 *  Leaving them always-on let memory-recalled SOPs (e.g. "log the delivered
 *  poem to a registry") drive silent tool calls on trivial chat requests. */
export const MISC_TOOLS = [
  // jarvis_file_read + jarvis_file_list already in CORE_TOOLS
  // jarvis_file_{write,update,delete,move} now gated via JARVIS_WRITE_TOOLS
  "jarvis_file_search", // Read-only search — safe to keep always-on
  "list_schedules", // Read-only, lightweight
  "project_list", // Read-only, lightweight
  "video_status", // Always available — follow-ups about video status don't re-trigger video scope
  "vps_status", // Always available — "how's the server?" doesn't need coding scope
  "northstar_sync", // Always available — "sync con db.mycommit" shouldn't need NorthStar keywords
  // Lightpanda browser — only goto + markdown (the 90% use case)
  "browser__goto",
  "browser__markdown",
];

/** Jarvis knowledge-base write tools — scope-gated.
 *
 *  Moved out of MISC_TOOLS on 2026-04-14 after task 2378 ("Me regalas un
 *  poema de Rumi para dormir?") silently called jarvis_file_read +
 *  jarvis_file_update instead of answering. Root cause: memory enrichment
 *  recalled a self-written SOP ("Poemas de Rumi: registro obligatorio en
 *  cada uso futuro") that instructed the model to log every poem to a
 *  registry. With writes in always-on scope, the model faithfully followed
 *  the SOP on a bedtime chat message and never produced a user-visible
 *  reply. Read access is still always-on — the model can still consult the
 *  SOP. Writes now require one of:
 *    - explicit write verb + file-ish object (jarvis_write scope pattern)
 *    - northstar_write / northstar_journal (NorthStar lives in jarvis_files)
 *    - coding (code/project work implies knowledge-base writes)
 */
export const JARVIS_WRITE_TOOLS = [
  "jarvis_file_write",
  "jarvis_file_update",
  "jarvis_file_delete",
  "jarvis_file_move",
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

/** Utility tools — weather, currency, geocoding. Scope-gated to save tokens. */
export const UTILITY_TOOLS = [
  "weather_forecast",
  "currency_convert",
  "geocode_address",
];

/** SEO/GEO tools — scope-gated: only when SEO/rankings/schema/meta keywords detected. */
export const SEO_TOOLS = [
  "seo_page_audit",
  "seo_keyword_research",
  "seo_meta_generate",
  "seo_schema_generate",
  "seo_content_brief",
];

/** F1+F2+F3+F4+F5 finance tools — scope-gated: activate on market/ticker/watchlist verbs, $SYMBOL pattern, indicator/signal/macro vocabulary. */
export const FINANCE_TOOLS = [
  "market_quote",
  "market_history",
  "market_watchlist_add",
  "market_watchlist_remove",
  "market_watchlist_list",
  "market_budget_stats",
  "market_indicators",
  "market_scan",
  "macro_regime",
  "market_signals",
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
    group: "northstar_journal", // Wires up JARVIS_WRITE_TOOLS (see tool assembly below)
  },
  {
    // jarvis_write: explicit write intent on a knowledge-base object.
    // Deliberately narrow — bare "guarda X" without a file-ish object must
    // NOT fire, or every casual note-taking request would pull write tools.
    // Fires on: (a) write verb + file-ish noun, (b) direct tool name mention,
    // (c) knowledge-base phrase with action word (EN/ES),
    // (d) v7.7.2: plain "KB" / "base de conocimiento" with a write verb.
    pattern:
      /\b(?:guarda|anota|registra|agrega|actualiza|crea|escribe)\w*(?:\s+(?:una?|el|la|los|las|un|mi|tu|este|esta|nuev[ao]))?(?:\s+\S+){0,2}\s+(?:archivo|nota|SOP|directiva|regla|fact|lesson|pattern|procedimiento|preferencia|conocimiento|jarvis[_\s]file)|jarvis_file_(?:write|update|delete|move)|knowledge\s*base\s+(?:write|update|save|append|edit)|mi\s+knowledge\s*base|\b(?:guarda|anota|registra|agrega|actualiza|crea|escribe|ap[úu]nta)\w*(?:\s+\S+){0,3}\s+(?:en|a|al)\s+(?:la\s+|el\s+|mi\s+|tu\s+)?(?:KB|base\s+de\s+conocimiento)\b|\ben\s+(?:la\s+|el\s+|mi\s+|tu\s+)?(?:KB|base\s+de\s+conocimiento)\s+(?:guarda|anota|registra|agrega|actualiza|escribe)/i,
    group: "jarvis_write",
  },
  {
    pattern:
      /\b(elimina(r|la|las|lo|los)?|borra(r|la|las|lo|los)?|delete|quita(r)?|remove)\b/i,
    group: "destructive", // Intent detection only — destructive tools (file_delete, etc.) live in their domain groups (CODING, GOOGLE)
  },
  {
    pattern:
      /\b(emails?|correos?|mails?|gmail|calendar|agenda|eventos?|citas?|reuni[oó]n|drive|g?docs?|g?sheets?|document[oa]?s?|hojas?|slides?|present|google|spreadsheet|google\s*chat|google\s*tasks?|google\s*forms?|google\s*meet|google\s*keep|google\s*people|google\s*classroom|apps\s*script|workspace\s*events?|google\s*admin|admin\s*reports?|contactos?\s*google)/i,
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
      /\b(schedules?|delete_schedule|list_schedules|schedule_task|reportes?|programa(r|dos?|ción)?|acci(o|ó)n(es)?\s+programad|cron|diarios?|semanal|automat\w*|recurrent|cada\s+\d+\s*(min|hora|h\b)|cada\s+(media\s+hora|hora)|repite\s+cada|repet[ií]r?\s+cada|peri[oó]dica(?:mente)?|recordatorio|reminder|av[ií]same\s+(cada|en\s+\d))/i,
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
    pattern:
      /\b(clima|weather|temperatura|temperature|lluvia|rain|pron[oó]stico|forecast|moneda|currency|convert|tipo\s+de\s+cambio|d[oó]lar|exchange\s+rate|coordenadas|coordinates|direcci[oó]n.*geocod|geocod|ubicaci[oó]n\s+de)\b/i,
    group: "utility",
  },
  {
    // v7.3 SEO/GEO scope — activates on explicit SEO terminology.
    pattern:
      /\b(seo|posicionamiento|palabras?\s+clave|keyword\s*research|meta\s*(?:tag|descri)|title\s+tag|schema\s*markup|schema\.org|json[-\s]?ld|rankings?|serp|pagespeed|core\s+web\s+vitals|lighthouse|sitemap|canonical|e-?e-?a-?t|content\s+brief|ai\s+overview|generative\s+engine|geo\s+(?:keywords?|signals?)|rich\s+results?|structured\s+data|open\s+graph|og\s+tags?|twitter\s+card)\b/i,
    group: "seo",
  },
  {
    // v7.0 F1 finance — $SYMBOL pattern (e.g. "$SPY", "$AAPL cotiza?")
    pattern: /\$[A-Z]{1,5}\b/,
    group: "finance",
  },
  {
    // v7.0 F1 finance — market verbs / noun activation (ES + EN)
    pattern:
      /\b(mercado|market|acci[oó]n|acciones|stock|ticker|bolsa|NYSE|NASDAQ|cotiza(?:ci[oó]n)?|precio\s+de|cu[aá]nto\s+(?:vale|cuesta)\s+(?:el|la)?|c[oó]mo\s+est[aá]\s+(?:el|la|mi)?)\b/i,
    group: "finance",
  },
  {
    // v7.0 F1 finance — watchlist CRUD verbs (operator Decision 6 requirement)
    pattern:
      /\b(agrega|añade|anade|quita|elimina|muestra|lista|trackea|add|remove|show|list|track)\b[^\n]{0,40}\b(watchlist|watch\s*list|ticker|symbol|s[ií]mbolo|acci[oó]n)\b/i,
    group: "finance",
  },
  {
    // v7.0 F2+F4 finance — technical-indicator vocabulary (ES + EN)
    // Audit W1: activates on "RSI", "MACD", "oversold", "scan watchlist for X",
    // "bollinger", "moving average", "indicators" without requiring market verbs.
    pattern:
      /\b(RSI|MACD|SMA|EMA|bollinger|vwap|atr|williams\s*%?r?|indicadores?|indicators?|oversold|overbought|sobrevendid\w*|sobrecomprad\w*|sobrecompra|sobreventa|momentum|moving\s+average|promedio\s+m[oó]vil|cruce\s+(?:de\s+)?medias?|golden\s+cross|death\s+cross|scan(?:ear)?|screener?|escanea\w*)\b/i,
    group: "finance",
  },
  {
    // v7.0 F5 macro — regime, yield curve, fed funds, inflation, unemployment,
    // VIX, CPI, GDP, M2, jobless claims, interest rates. Audit I1 vocabulary.
    pattern:
      /\b(macro|r[eé]gimen|regime|yield\s+curve|curva\s+(?:de\s+)?rendimiento|fed\s+funds?|fed\s+rate|tasas?\s+(?:de\s+)?inter[eé]s|interest\s+rates?|inflation|inflaci[oó]n|unemployment|desempleo|jobless\s+claims?|recession|recesi[oó]n|VIX|M2|CPI|GDP|PIB|expansion|tightening|recovery)\b/i,
    group: "finance",
  },
  {
    // v7.0 F3 signals — crossover, breakout, divergence, trigger, confluence,
    // reversal, gap. Includes plural forms (signals, crossovers, breakouts).
    // Audit I1 vocabulary additions. Narrowed 'fire' to finance context to
    // avoid false positives on general English.
    pattern:
      /\b(signals?|se[ñn]al(?:es)?|crossovers?|cruce|breakouts?|fuga|divergence|divergencia|confluence|confluencia|reversal|reversi[oó]n|gap\s+(?:up|down|alcista|bajista)|triggers?|detect(?:ar|ing|ed|s)?)\b/i,
    group: "finance",
  },
  {
    // Meta: user asks about tools, capabilities, or diagnostics → load ALL groups
    // so the LLM can give an accurate inventory instead of reporting tools as missing.
    pattern:
      /\b(auto.?diagn[oó]stic\w*|diagn[oó]stic\w*|nivel operativo|herramientas?\s+(?:disponibles?|activas?|funcional)|lista\w*\s+(?:todas?\s+)?(?:las?\s+)?(?:tools?|herramientas?)|tools?\s+(?:available|status|check)|capacidades|capabilities|funcionalidad(?:es)?)\b/i,
    group: "meta",
  },
  // NOTE: Auto-improvement (v6.4.7-v6.4.21) attempted a broad imperative fallback
  // pattern here. Removed — it matched common words ("lista", "esto", "tarea")
  // causing false positive scope activation. The referential/imperative logic in
  // scopeToolsForMessage() and detectActiveGroups() handles follow-ups correctly.
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
    // Covers ALL Google Workspace URL patterns: Docs, Sheets, Slides, Drive, Gmail, Calendar.
    if (
      /docs\.google\.com\/(document|spreadsheets|presentation)|drive\.google\.com|mail\.google\.com|calendar\.google\.com/i.test(
        currentMessage,
      )
    ) {
      activeGroups.add("google");
    }
    // Context-aware Google injection: classifier may miss Google intent when the
    // message is about content ("limpiar", "integrar") not tools. If prior
    // conversation mentions Google Workspace, inherit the google scope group.
    if (
      !activeGroups.has("google") &&
      recentUserMessages.some((m) =>
        /gdocs?|gsheets?|google\s*(doc|sheet|drive|calendar)|spreadsheet|document[oa]?\s+de\s+google/i.test(
          m,
        ),
      )
    ) {
      activeGroups.add("google");
    }
    // v7.3: SEO keyword injection. Classifier may tag as browser/research when
    // the message mentions "audit", "meta tags", "schema" without recognizing
    // the SEO domain. Force-add seo group when strong SEO signals present.
    if (
      !activeGroups.has("seo") &&
      /\b(seo|posicionamiento|meta\s*(?:tag|descri)|title\s+tag|schema\s*markup|schema\.org|json[-\s]?ld|serp|pagespeed|core\s+web\s+vitals|lighthouse|ai\s+overview|generative\s+engine|content\s+brief|e-?e-?a-?t|keyword\s+research|rich\s+results?)\b/i.test(
        currentMessage,
      )
    ) {
      activeGroups.add("seo");
    }
    // General scope inheritance safety net: always scan prior user messages
    // with the full pattern set and merge any matches into the classifier's
    // output. The classifier regularly under-classifies in two modes:
    //   (a) intent-only output (destructive/journal/meta alone) on short
    //       confirmation follow-ups — "Confirmado. Elimina las 6." losing
    //       the `schedule` group
    //   (b) partial-domain output — one real group returned but another
    //       implicit group missed — "Revisa documentos... agrega a la tesis"
    //       returning only `research` while the user's tesis lives in a
    //       Google Doc, so `google` should co-activate
    // The slice(-4) window on recentUserMessages bounds accumulation risk,
    // and we only MERGE — never replace — the classifier's groups. Existing
    // google/seo injections above still run first for redundancy.
    if (recentUserMessages.length > 0) {
      const priorText = recentUserMessages.join(" ");
      for (const { pattern, group } of patterns) {
        if (pattern.test(priorText)) {
          activeGroups.add(group);
        }
      }
    }
  } else {
    activeGroups = new Set<string>();

    // 1. Check if the CURRENT message triggers any scope groups on its own.
    const currentGroups = new Set<string>();
    for (const { pattern, group } of patterns) {
      if (pattern.test(currentMessage)) {
        currentGroups.add(group);
      }
    }
    for (const group of currentGroups) {
      activeGroups.add(group);
    }

    // 2. Determine if we should inherit scope from prior messages.
    // Three conditions allow inheritance:
    //   a) Current message has its own scope signals (merge with prior)
    //   b) Short message (< 80 chars) — likely a follow-up, not a topic change
    //   c) Referential/imperative phrase — explicitly refers to prior context
    const REFERENTIAL_PATTERN =
      /\b(ejecuta|procede|hazlo|int[eé]ntalo|int[eé]gra(?:lo|la)?|actual[ií]za(?:lo|la)?|agr[eé]ga(?:lo|la)?|s[uú]be(?:lo|la)?|contin[uú]a|adelante|dale|verifica\s*y\s*ejecuta|vuelve?\s*a\s*intentar|reint[eé]ntalo|s[ií]guele|el\s+primer[oa]\s+que|eso\s+que\s+(?:te|me|le)|lo\s+(?:que|de|del)\s+(?:te|me|le)\s+(?:ped|dij|mand|envi|compart)|ese\s+(?:que|mismo)\s+(?:te|me|le)|tu\s+(?:ya\s+)?(?:lo|la)\s+(?:tienes|hiciste)|t[uú]\s+(?:ya\s+)?(?:lo|la)\s+(?:tienes|hiciste))\b/i;

    const trimmed = currentMessage.trim();
    const isShort = trimmed.length < 80;
    const hasReferentialPhrase = REFERENTIAL_PATTERN.test(currentMessage);
    const hasOwnScope = currentGroups.size > 0;
    // Short conversational messages (greetings, thanks, acknowledgments) should
    // NOT inherit — they're topic closers, not follow-ups. Only inherit if the
    // short message contains an actionable word or referential phrase.
    const CONVERSATIONAL =
      /^(ok|bueno|gracias|thanks|sí|si|no|vale|listo|perfecto|claro|entiendo|de acuerdo|genial|excelente|ya|bien|cool|nice)([.,!?\s]+(ok|bueno|gracias|thanks|sí|si|no|vale|listo|perfecto|claro|entiendo|genial|excelente|ya|bien|cool|nice))*[.,!?\s]*$/i;
    const isConversational = isShort && CONVERSATIONAL.test(trimmed);
    const isShortFollowUp = isShort && !isConversational;
    const shouldInherit =
      recentUserMessages.length > 0 &&
      (hasOwnScope || isShortFollowUp || hasReferentialPhrase);

    if (shouldInherit) {
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
    activeGroups.add("jarvis_write");
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
    activeGroups.add("social");
    activeGroups.add("utility");
    activeGroups.add("seo");
  }

  if (
    activeGroups.has("northstar_read") ||
    activeGroups.has("northstar_write")
  ) {
    tools.push("northstar_sync");
  }
  // JARVIS_WRITE_TOOLS — gated to prevent silent drift from memory-recalled
  // SOPs that instruct the model to log/register/save on trivial chat turns.
  // Any of these four groups implies legitimate write intent.
  if (
    activeGroups.has("jarvis_write") ||
    activeGroups.has("northstar_write") ||
    activeGroups.has("northstar_journal") ||
    activeGroups.has("coding")
  ) {
    tools.push(...JARVIS_WRITE_TOOLS);
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
  if (activeGroups.has("utility")) {
    tools.push(...UTILITY_TOOLS);
  }
  if (activeGroups.has("seo")) {
    tools.push(...SEO_TOOLS);
  }
  if (activeGroups.has("finance")) {
    tools.push(...FINANCE_TOOLS);
  }
  if (options.hasMemory) {
    tools.push("memory_search", "memory_store", "memory_reflect");
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
  // Mirror scopeToolsForMessage's inheritance logic:
  // Inherit from prior messages only when current has scope signals,
  // is a short non-conversational follow-up, or contains referential phrases.
  const currentGroups = new Set<string>();
  for (const { pattern, group } of patterns) {
    if (pattern.test(currentMessage)) {
      currentGroups.add(group);
    }
  }

  const active = new Set(currentGroups);

  if (recentUserMessages.length > 0) {
    const REFERENTIAL =
      /\b(ejecuta|procede|hazlo|int[eé]ntalo|int[eé]gra(?:lo|la)?|actual[ií]za(?:lo|la)?|agr[eé]ga(?:lo|la)?|s[uú]be(?:lo|la)?|contin[uú]a|adelante|dale|verifica\s*y\s*ejecuta|vuelve?\s*a\s*intentar|reint[eé]ntalo|s[ií]guele|el\s+primer[oa]\s+que|eso\s+que\s+(?:te|me|le)|lo\s+(?:que|de|del)\s+(?:te|me|le)\s+(?:ped|dij|mand|envi|compart)|ese\s+(?:que|mismo)\s+(?:te|me|le)|tu\s+(?:ya\s+)?(?:lo|la)\s+(?:tienes|hiciste))\b/i;
    const CONVERSATIONAL =
      /^(ok|bueno|gracias|thanks|sí|si|no|vale|listo|perfecto|claro|entiendo|de acuerdo|genial|excelente|ya|bien|cool|nice)([.,!?\s]+(ok|bueno|gracias|thanks|sí|si|no|vale|listo|perfecto|claro|entiendo|genial|excelente|ya|bien|cool|nice))*[.,!?\s]*$/i;
    const trimmed = currentMessage.trim();
    const isShort = trimmed.length < 80;
    const isConversational = isShort && CONVERSATIONAL.test(trimmed);
    const shouldInherit =
      currentGroups.size > 0 ||
      (isShort && !isConversational) ||
      REFERENTIAL.test(currentMessage);

    if (shouldInherit) {
      const priorText = recentUserMessages.join(" ");
      for (const { pattern, group } of patterns) {
        if (pattern.test(priorText)) {
          active.add(group);
        }
      }
    }
  }

  return active;
}
