/**
 * Tool scoping — pure functions for dynamic tool selection.
 *
 * Extracted from router.ts to enable testing and sandbox evaluation
 * in the tuning system without side effects.
 */

import type { ScopePattern } from "../tuning/types.js";
import { normalizeForMatching } from "./normalize.js";

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
  "gdrive_download",
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
  // v7.14: infographic_generate — editorial data-storytelling (KPI grids,
  // comparison tables, timelines, ranking pyramids) via AntV Infographic.
  // Writes SVG to /tmp; classified as write-capable.
  "infographic_generate",
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
  "video_transition_preview",
  "video_compose_manifest",
  "video_job_cancel",
  "video_job_cleanup",
  "video_storyboard",
  "video_brand_apply",
  "video_html_compose",
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

/** Utility tools — weather, currency, geocoding, file conversion. Scope-gated to save tokens. */
export const UTILITY_TOOLS = [
  "weather_forecast",
  "currency_convert",
  "geocode_address",
  // v7.10: file_convert — dispatches to FLOSS CLI tools (calibre,
  // libreoffice, pandoc, imagemagick, ffmpeg). Scope activates on
  // conversion verbs + format nouns.
  "file_convert",
];

/**
 * v7.3 Phase 4a — Digital Marketing Buyer tools.
 * Scope-gated on ads/campaign/creative/brand-DNA vocabulary (EN+ES).
 * Reference: `reference_claude_ads.md`; adoption tracked in V7-ROADMAP.md.
 */
export const ADS_TOOLS = ["ads_audit", "ads_brand_dna", "ads_creative_gen"];

/** SEO/GEO tools — scope-gated: only when SEO/rankings/schema/meta keywords detected. */
export const SEO_TOOLS = [
  "seo_page_audit",
  "seo_keyword_research",
  "seo_meta_generate",
  "seo_schema_generate",
  "seo_content_brief",
  // v7.3 Phase 5 — GEO depth
  "seo_robots_audit",
  "seo_llms_txt_generate",
  // v7.3 Phase 2 — SEO telemetry
  "seo_telemetry",
  // v7.3 Phase 3 — AI Overview monitoring
  "ai_overview_track",
];

/** F1+F2+F3+F4+F5+F6+F6.5 finance tools — scope-gated on market/ticker/watchlist/indicator/signal/macro/prediction/whale/sentiment vocabulary. */
export const FINANCE_TOOLS = [
  "market_quote",
  "market_history",
  "market_watchlist_add",
  "market_watchlist_remove",
  "market_watchlist_list",
  "market_watchlist_reseed",
  "market_budget_stats",
  "market_indicators",
  "market_scan",
  "macro_regime",
  "market_signals",
  "prediction_markets",
  "whale_trades",
  "sentiment_snapshot",
];

/** v7.13 KB ingestion tools — scope-gated on ingest/parse/extract + PDF/tables vocab. */
export const KB_INGEST_TOOLS = ["kb_ingest_pdf_structured", "kb_batch_insert"];

/** F7 alpha combination tools — scope-gated on alpha/combination/megaalpha/weights vocab. */
export const ALPHA_TOOLS = ["alpha_run", "alpha_latest", "alpha_explain"];

/** F7.5 strategy backtester tools — scope-gated on backtest/CPCV/PBO/overfit vocab. */
export const BACKTEST_TOOLS = [
  "backtest_run",
  "backtest_latest",
  "backtest_explain",
];

/** F8 paper-trading tools — scope-gated on paper/rebalance/portfolio/fills vocab. */
export const PAPER_TOOLS = [
  "paper_rebalance",
  "paper_portfolio",
  "paper_history",
];

/** F9 market-ritual helpers — scope-gated on market-calendar / alert-budget vocab. */
export const MARKET_RITUAL_TOOLS = ["market_calendar", "alert_budget_status"];

/** F8.1a prediction-market alpha tools — scope-gated on pm_alpha / polymarket alpha vocab. */
export const PM_ALPHA_TOOLS = ["pm_alpha_run", "pm_alpha_latest"];

/** F8.1b PM paper trading tools — scope-gated on pm_paper / polymarket rebalance vocab. */
export const PM_PAPER_TOOLS = [
  "pm_paper_rebalance",
  "pm_paper_portfolio",
  "pm_paper_history",
];

/**
 * v7.12 diagram_generate — scope-gated on diagram/flowchart/architecture
 * vocabulary. Dispatches to graphviz `dot` or inline LLM SVG+HTML.
 */
export const DIAGRAM_TOOLS = ["diagram_generate"];

/**
 * v7.1 chart rendering + vision pattern recognition. Scope-gated on chart/
 * pattern vocabulary. market_chart_render produces a PNG of OHLC + overlays;
 * market_chart_patterns classifies a PNG (or auto-renders first) into a named
 * formation and writes the result to `chart_patterns` for post-F7 RRF fusion.
 */
export const CHART_TOOLS = ["market_chart_render", "market_chart_patterns"];

/**
 * v7.11 teaching module — learning plans, adaptive quizzes, explain-back,
 * spaced-repetition learner model. Scope-gated on teach-me / quiz-me /
 * review-today vocabulary (EN + ES).
 */
export const TEACHING_TOOLS = [
  "learning_plan_create",
  "learning_plan_advance",
  "learning_plan_quiz",
  "learning_plan_explain_back",
  "learning_plan_summarize",
  "learning_plan_status",
  "learner_model_status",
];

/**
 * v7.2 graphify-code knowledge-graph tools (MCP-sourced, namespaced with `__`).
 * Scope-gated on graph/knowledge-graph vocabulary. The server (graphify-code)
 * loads a prebuilt AST graph of src/ at boot; these tools are read-only
 * NetworkX queries and safe to expose once the graph.json exists.
 */
export const GRAPH_TOOLS = [
  "graphify-code__query_graph",
  "graphify-code__get_node",
  "graphify-code__get_neighbors",
  "graphify-code__get_community",
  "graphify-code__god_nodes",
  "graphify-code__graph_stats",
  "graphify-code__shortest_path",
];

/**
 * Xpoz Reddit Intelligence Pipeline tools (MCP-sourced, namespaced with `__`).
 * Scope-gated on xpoz brand vocabulary + reddit-intel co-anchors. The server
 * (xpoz) runs as an HTTP pipeline on :8086 wrapped in an MCP stdio bridge;
 * trigger_run posts a new ingestion, get_* tools read prior runs.
 * Pre-dates the 2026-04-22 stabilization freeze (shipped as reddit scraper);
 * inclusion here is a freeze-compliant MCP bridge, not an autonomous-build add.
 */
export const XPOZ_TOOLS = [
  "xpoz__xpoz_trigger_run",
  "xpoz__xpoz_get_topics",
  "xpoz__xpoz_get_digest",
  "xpoz__xpoz_get_history",
];

// ---------------------------------------------------------------------------
// Default scope patterns
// ---------------------------------------------------------------------------

/**
 * Pure-greeting/acknowledgment messages that should NOT inherit scope from
 * prior turns. Topic closers, not follow-ups. Used by both the regex-fallback
 * inheritance branch (scopeToolsForMessage) and the router's empty-classifier
 * inheritance branch (decideActiveGroups). Hoisted to file scope 2026-04-26
 * so both call sites apply the same filter (was previously inline-only).
 */
export const CONVERSATIONAL_PATTERN =
  /^(ok|bueno|gracias|thanks|sí|si|no|vale|listo|perfecto|claro|entiendo|de acuerdo|genial|excelente|ya|bien|cool|nice)([.,!?\s]+(ok|bueno|gracias|thanks|sí|si|no|vale|listo|perfecto|claro|entiendo|genial|excelente|ya|bien|cool|nice))*[.,!?\s]*$/i;

/** Keyword patterns that activate tool groups. Scans current + recent messages. */
export const DEFAULT_SCOPE_PATTERNS: ScopePattern[] = [
  {
    pattern:
      /\b(tareas?|tasks?|metas?|goals?|objetivos?|objectives?|visi[oó]n|pendientes?|productiv|priorid|sprint|diario|journal|briefing|resumen del d[ií]a|northstar|north\s*star|sync\w*\s+(?:\S+\s+)*(?:commit|mycommit|db\.mycommit)|db\.mycommit|sincroniza(?:r|ci[oó]n)?(?:\s+\S+){0,3}\s+(?:commit|northstar|mycommit))/i,
    group: "northstar_read",
  },
  // Projects scope — entities distinct from NorthStar goals. Lifecycle ops
  // (reactivate/archive/pause/complete/activate), status changes, and
  // credential/URL/config updates. Two patterns handle verb-noun and
  // noun-verb orders. Verb alternations use exact forms with `\b` to avoid
  // matching adverbs like "activamente"/"completamente"/"infografía".
  {
    pattern:
      /\b(?:reactiva|reactivar|activa|activar|archiva|archivar|pausa|pausar|completa|completar|actualiza|actualizar|updates?|updated|updating|creas?|crear|nuev[oa]s?|status|estado|credentials?|credenciales?|info|detalles|muestra|mu[eé]stra(?:me|lo|la|nos)?|show|describe|describir|descr[ií]beme)\b(?:\s+\S+){0,5}\s*\b(?:proyectos?|projects?)\b/i,
    group: "projects",
  },
  {
    pattern:
      /\b(?:proyectos?|projects?)\b(?:\s+\S+){0,8}\s*\b(?:reactiva|reactivar|activa|activar|archiva|archivar|pausa|pausar|completa|completar|actualiza|actualizar|updates?|updated|updating|status|estado|credentials?|credenciales?)\b/i,
    group: "projects",
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
    // Delete verb + NorthStar noun: "elimina la tarea X", "borra esa meta",
    // "quita el objetivo Y", "delete task Z", "remove goal A".
    // jarvis_file_delete still gates on isPreciousPath, so activation only
    // exposes the tool — confirmation is still required before any write.
    // Unanchored clitic deletes ("elimínala", "bórralo") are handled by the
    // destructive + NorthStar co-occurrence rule in scopeToolsForMessage
    // (fires on referential inheritance when a NorthStar noun appeared in a
    // prior turn), not by a standalone regex here — that was too loose.
    pattern:
      /\b(?:elim[ií]na(?:r|la|lo|las|los)?|b[oó]rra(?:r|la|lo|las|los)?|quita(?:r)?|delete|remove)\w*(?:\s+\S+){0,4}\s*(?:tarea|meta|objetivo|visi[oó]n|goal|task|objective|vision)/i,
    group: "northstar_write",
  },
  {
    pattern:
      /\b(chart_generate|(?:bar|line|pie|doughnut|radar|scatter)\s+chart|gr[aá]fica\s+(?:de\s+)?(?:barras|pastel|l[ií]nea|circular|dona|radar|dispersi[oó]n)|rss|feed|noticias|investigar?|exa_search|genera.*imagen|image.*genera|gemini|hugging\s?face|hf_generate|hf_spaces|text.to.(?:speech|image|video|music)|genera.*(?:audio|video|voz|m[uú]sica)|(?:audio|video|voz|m[uú]sica).*genera|TTS\b|crea.*(?:audio|video|imagen|m[uú]sica|canci[oó]n)|genera.*(?:speech|music|song)|jingle|soundtrack|busca.*spaces?|humaniz|limpia.*\btexto\b|revisa\s+mi\s+texto|reescrib|dashboard|visualiz|KPI|m[eé]tric|infographics?|infograf[ií]as?|summary\s+card|comparison\s+(?:card|table)|ranking\s+(?:card|pyramid)|SWOT|cuadro\s+resumen|tarjeta\s+(?:resumen|KPI)|timeline\s+card|briefing\s+visual)/i,
    group: "specialty",
  },
  {
    // Document/deck/PDF analysis activation. Regex carries memory:
    //  - `\.pdf\b` and `\.pptx?\b` need a non-word edge BEFORE the dot too;
    //    use `(?:^|[\s"'`(])` so "the .pptx file" matches (qa W3, scope-regex memory).
    //  - The describe/analiza arm intentionally does NOT include bare `imagen|image`
    //    (qa W2) — "describe la imagen del logo" is image-generation chat, not
    //    document analysis. Restricted to slide/diapositiva/presentaci anchors.
    pattern:
      /\b(research|investigaci[oó]n|anali[zs][ae]\w*(?:\s+\S+){0,2}\s+(?:documento|archivo|paper|PDF|presentaci[oó]n(?:es)?|slides?|deck)|study\s*guide|gu[ií]a\s*de\s*estudio|podcast|audio\s*overview|notebook\s*lm|flashcards?|tarjetas?\s*de\s*estudio|quiz|cuestionario|briefing\s+d|resum(?:e|en)(?:\s+\S+){0,2}\s+(?:documento|archivo|PDF|presentaci[oó]n(?:es)?|slides?|deck)|sube\w*(?:\s+\S+){0,2}\s+(?:documento|archivo|PDF|presentaci[oó]n(?:es)?|slides?|deck)|upload\s+(?:\S+\s+)?(?:document|presentation|slides?|deck)|gemini_(?:upload|research|audio)|deep\s+(?:dive|analysis|an[aá]lisis)|(?:qu[eé]|what)\s+(?:\S+\s+){0,3}documentos?|(?:lee|abre|open|read)\w*(?:\s+\S+){0,2}\s+(?:PDF|\.pdf|presentaci[oó]n(?:es)?|slides?|deck)|(?:^|[\s"'`(])\.pdf\b|(?:^|[\s"'`(])\.pptx?\b|(?:captura\w*|capture)\s+(?:cada\s+|each\s+|every\s+|all\s+|las\s+|todas?\s+las\s+)?(?:slides?|diapositivas?|p[aá]ginas?\s+del?\s+(?:PDF|deck|presentaci))|cada\s+(?:slide|diapositiva|p[aá]gina\s+del?\s+(?:PDF|deck))|(?:describe|descrip|analiza|analyze)\s+(?:la|the|cada|each|every|all)?\s*(?:slide|diapositiva|presentaci))/i,
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
    // Destructive intent detection — accented ES clitics (elim[ií]na/b[oó]rra/
    // qu[ií]ta) must match so "elimínala" / "bórralo" count as delete intent.
    // Without the accent-tolerant char-class, the classifier's destructive
    // activation misses stressed forms and the co-occurrence rule in
    // scopeToolsForMessage never fires → jarvis_file_delete stays offscope.
    pattern:
      /\b(elim[ií]na(r|la|las|lo|los)?|b[oó]rra(r|la|las|lo|los)?|delete|qu[ií]ta(r|la|las|lo|los)?|remove)\b/i,
    group: "destructive", // Intent detection only — destructive tools (file_delete, etc.) live in their domain groups (CODING, GOOGLE)
  },
  {
    // Closing `\b` (added 2026-04-26) prevents bare alts like `present` from
    // matching word prefixes ("presentación", "presentar"). Same fix shape as
    // the `react\b` close on the coding regex shipped earlier today. The deeper
    // class of FP — generic exact-word matches on `agenda`, `drive`,
    // `document[oa]?s?`, `hojas?`, `slides?` — is captured as a separate
    // post-freeze item; closing `\b` alone does not address them.
    pattern:
      /\b(emails?|correos?|mails?|gmail|calendars?|calendarios?|agenda|eventos?|citas?|reuni[oó]n|drive|g?docs?|g?sheets?|document[oa]?s?|hojas?|slides?|google|spreadsheet|google\s*chat|google\s*tasks?|google\s*forms?|google\s*meet|google\s*keep|google\s*people|google\s*classroom|apps\s*script|workspace\s*events?|google\s*admin|admin\s*reports?|contactos?\s*google)\b/i,
    group: "google",
  },
  {
    pattern:
      /\b(naveg|browse|sitio web|p[aá]gina web|click|login|formulario|scrape|render|javascript|playwright|chromium|react|next\.?js|SPA|iniciar sesi[oó]n|log\s?in|sign\s?in|entra a|abre la app)\b/i,
    group: "browser",
  },
  {
    // Bug fix 2026-05-05 (DENUE pharmacy-scoring incident): coding regex previously
    // missed three classes of legitimate coding intent → 6 consecutive max_turns
    // failures while the model thrashed looking for shell_exec:
    //   1. DB-execution vocabulary — sql/psql/query/database/supabase/postgres/
    //      docker exec/kubectl/tsx/npx — never present in original regex.
    //   2. Literal user-explicit tool-name mentions — operator typed "shell_exec"
    //      and "Usa tus herramientas de coding como shell_exec"; neither matched.
    //      English "coding" was also missing (only c[oó]digo|code).
    //   3. Run-verb + execution-noun — "ejecuta el query / corre el script /
    //      run the migration / launch the scoring".
    // The literal-tool-name arm is the safety net for fix B (user-explicit
    // tool intent). Word boundaries on every literal prevent FPs on
    // assistant-paraphrased content.
    // See feedback_scope_regex_patterns.md (consolidated regex notes).
    pattern:
      /\b(c[oó]digo|code|archivos?|files?|scripts?|deploy|edita(r)?\s+(el\s+)?(archivo|código|script)|grep|busca(r)?\s+en|estructura|directori|carpetas?|servers?|servidores?|git\b|github|commit|push(ea)?|npm\b|build\b|test\b|lint\b|bug\b|debug|typescript|javascript|python|react\b|node\.?js|funci[oó]n|rutina|programa(r|ción)?|repositori|repo\b|refactor|implementa|escrib[eiao]\w*\s+(?:\S+\s+){0,2}(?:c[oó]digo|script|rutina|funci[oó]n|programa|clase|m[oó]dulo)|jarvis_dev|mejora\s+tu|fix\s+your|arregla\s+tu|agrega\s+(?:un\s+)?(?:adapter|adaptador|tool|herramienta)|crea\s+(?:un\s+)?branch|abre\s+(?:un\s+)?pr|sql\b|psql\b|querie?s?\b|database\b|supabase\b|postgres\b|docker\s+exec\b|kubectl\b|tsx\b|npx\b|shell_exec\b|file_write\b|file_edit\b|file_delete\b|jarvis_test_run\b|jarvis_diagnose\b|coding\b(?=\s+(?:tool|scope|context|herramienta|mode))|herramientas?\s+de\s+coding\b|(?:ejecuta|corre|c[oó]rre|run|launch|lanza)\w*\s+(?:\S+\s+){0,3}(?:query|queries|consulta|consultas|script|scripts|sql|c[oó]digo|comando|migration|migrations?|stored\s+proc(?:edure)?)|scoring\b)/i,
    group: "coding",
  },
  {
    pattern:
      /\b(schedules?|delete_schedule|list_schedules|schedule_task|reportes?|programa(r|dos?|ción)?|acci(o|ó)n(es)?\s+programad|cron|diarios?|semanal|automat\w*|recurrent|cada\s+\d+\s*(min|hora|h\b)|cada\s+(media\s+hora|hora)|repite\s+cada|repet[ií]r?\s+cada|peri[oó]dica(?:mente)?|recordatorio|reminder|av[ií]same\s+(cada|en\s+\d))/i,
    group: "schedule",
  },
  {
    // WordPress scope — covers the bilingual vocabulary operators use in
    // practice. Bug fix 2026-04-20: regex previously required `wp[-_]` with
    // a separator and missed bare `WP` (ES shorthand "en WP", "el WP"),
    // integer-referenced posts (`el articulo 546`), and ES update-verb +
    // WP-noun forms (`actualiza el articulo`, `edítalo`). Scope miss
    // caused `WORDPRESS_TOOLS` to be dropped from the prompt, pushing the
    // LLM toward `shell_exec`/`curl` via the `coding` scope.
    //
    // Design choices after round-1 audit:
    // - Bare `wp\b` catches operator shorthand ("en WP,") — the outer `\b(`
    //   already provides the leading boundary so no inner `\b` needed.
    // - Integer-ref posts require a preceding article/possessive (`el|la|
    //   los|las|mi|tu|este|esta`) to avoid firing on dev chatter like
    //   "post 12 on issue" or "commit 42".
    // - Update-verb alternation accepts ES subjunctive (`actualice|edite|
    //   modifique|cambie`) and accented clitic stems (`act[uú]al[ií]za`
    //   for `actualízalo`, `ed[ií]ta` for `edítalo`, etc.).
    // - `p[aá]gina` deliberately EXCLUDED from the update-verb noun list —
    //   it's the default ES word for any UI screen and over-fires on
    //   generic frontend work ("actualiza la pagina de login").
    pattern:
      /\b(wordpress|blogs?\s+(?:post|entry|article|entrada)|wp[-_]|wp\b|(?:el|la|los|las|mi|tu|este|esta)\s+(?:art[ií]culo|post|entrada)s?\s+\d{1,6}\b|(?:actual[ií]za|actualice|ed[ií]ta|edite|modif[ií]ca|modifique|c[aá]mbia|cambie)(?:r|lo|la|las|los)?\s+(?:(?:el|la|los|las|un|una|mi|tu|este|esta)\s+)?(?:post|art[ií]culo|entrada|p[aá]ginas?\s+(?:del?\s+)?(?:blog|sitio|wordpress|wp\b))|publi(?:ca|car|que)\s+(?:en\s+)?(?:el\s+)?(?:blog|sitio|wordpress)|drafts?\s+(?:del?\s+)?blog|borrador\s+(?:del?\s+)?blog|featured\s*image|hero\s*image|plugin(?:s)?\s+(?:de\s+)?wp|theme\s+(?:de\s+)?wp|sitio\s+web|header|footer|tracker|tracking|GA4|analytics|widget|snippet|(?:livingjoyfully|redlightinsider)\.(?:art|com)|genera.*imagen.*blog|sube.*imagen.*(?:blog|wp|sitio)|media.*upload.*(?:blog|wp))/i,
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
    // v7.4 S1 tighten: bare `video`/`render`/`mp4` caused FPs on dev chatter
    // ("the video tag", "render a React component", "extract mp4 from pdf").
    // Round-1 audit M4: `overlay`/`screenshot` bare words and bare platform
    // names (TikTok/YouTube) were still over-broad — now require a co-occurring
    // video/clip/take-a/de qualifier, or the domain-specific phrasing.
    // v7.4.3 additions: html-composition DSL arms — require `html` to co-occur
    // with compose/mp4/video in anchored phrases to avoid dev-chatter FPs
    // ("html template", "html email", "html for a landing page").
    pattern:
      /\b(?:v[ií]deos?(?!\s*(?:tag|element|elemento|html))|pel[ií]culas?|clips?|storyboard|guion\s+de\s+v[ií]deo|mp4(?!\s+(?:to|a|file|from|de\s+un|del))|webm|(?:you-?tube|tik-?tok|reels|shorts)\s+(?:v[ií]deo|clip|reel|short|contenido|content|strategy|estrategia|storyboard)|(?:reels?|shorts?)\s+(?:de|para|of|for)\s+(?:instagram|facebook|youtube|tiktok|marca|brand|campa[ñn]a)|(?:un|una|a|an|el|la|hacer|haz|make)\s+reels?\b|instagram\s+video|graba(?:r|ci[oó]n)?|hazme\s+un\s+v[ií]deo|overlay\s+(?:v[ií]deo|scene|escena|text|imagen|mode|mod[oa])|(?:con|with|usando|using|using\s+an|en\s+modo)\s+overlay|fondo\s+de\s+v[ií]deo|background\s+video|narraci[oó]n|voz\s+(?:para|del)\s+v[ií]deo|transici[oó]n\s+de\s+v[ií]deo|transitions?\s+preview|composici[oó]n\s+de\s+v[ií]deo|render\s+(?:el\s+|un\s+|la\s+)?v[ií]deo|v[ií]deo\s+render|html\s+(?:a|to|como|as)\s+(?:mp4|v[ií]deo|video)|compos[ae]r?\s+(?:un\s+|una\s+|el\s+|la\s+|a\s+|an\s+|the\s+)?(?:v[ií]deo|video|mp4)\s+(?:from|desde)\s+(?:un\s+|el\s+|la\s+|the\s+|an?\s+)?html|(?:v[ií]deo|video)\s+desde\s+(?:el\s+|un\s+|the\s+|a\s+)?html|render\s+(?:this\s+|that\s+|the\s+|el\s+|la\s+|este\s+|esta\s+)?html\s+(?:as\s+|como\s+)?(?:mp4|v[ií]deo|video)|html[-_\s]composition\s+(?:mp4|file|job|render|v[ií]deo(?!\s*(?:tag|element|elemento)))|video_html_compose|(?:t[óo]mame\s+un\s+)?screenshot\s+(?:de|of|del|la|el|web|p[aá]gina|url|this)|take\s+a\s+screenshot|captura\s+(?:de\s+pantalla)?)\b/i,
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
    // v7.10 file_convert — activates on ES "convertir/convierte/transforma"
    // (the base "convert" pattern already covers EN), explicit tool-name
    // shortcut, frame-extraction phrasing, and strong file-format anchors
    // that alone imply a conversion task. Narrowly scoped: bare "pdf" or
    // "docx" alone does NOT fire (would false-positive on "send me a PDF"
    // asks); the regex requires the format to be preceded by a conversion
    // verb OR appear as a file extension (leading dot).
    pattern:
      /\b(convertir|convierte|conviérte(?:lo|la)|(?:transforma(?:lo|la)|transformar?)\s+(?:(?:(?:el|la|lo|un|una|este|esta|mi|tu)\s+)?\S+\s+)?(?:a|al|en|hacia)\b|transform(?:s|ed|ing|ation)?\s+(?:(?:the|a|my|this|your)\s+)?\S+\s+(?:to|into)\b|extraer?\s+(?:un\s+)?(?:frame|imagen|cuadro)|extract\s+(?:a\s+)?frame|file[_\s-]?convert|ebook[-\s]?convert|pandoc|libreoffice|imagemagick|ffmpeg\s+frame)\b|\.(?:epub|mobi|heic|heif|avif|jxl|odt|rtf|pages|pptx|docx|adoc|rst)\b/i,
    group: "utility",
  },
  {
    // v7.3 SEO/GEO scope — activates on explicit SEO terminology.
    pattern:
      /\b(seo|posicionamiento|palabras?\s+clave|keyword\s*research|meta\s*(?:tag|descri)|title\s+tag|schema\s*markup|schema\.org|json[-\s]?ld|rankings?|serp|pagespeed|core\s+web\s+vitals|lighthouse|sitemap|canonical|e-?e-?a-?t|content\s+brief|ai\s+overview|generative\s+engine|geo\s+(?:keywords?|signals?|depth)|rich\s+results?|structured\s+data|open\s+graph|og\s+tags?|twitter\s+card|llms\.txt|ai[-\s]?bots?|robots\.txt|readability|flesch|citation\s+density|stat(?:istic)?\s+density|search\s+console|gsc\b|impressions|clicks|ctr\b|panel\s+(?:ia|ai)|resumen\s+(?:ia|ai)|sge\b|aio\b)/i,
    group: "seo",
  },
  {
    // v7.3 Phase 4a — Digital Marketing Buyer. Activates on ads vocabulary
    // (EN + ES). Designed to coexist with `seo` scope: overlap (e.g. both
    // fire on "CTR") is harmless — deferred tools load from both sets.
    //
    // Design notes:
    // - Platform-qualified `ads` (meta/google/... ads) is the strongest anchor.
    //   Bare `ads?\b` fires only with an ads-specific noun ("ads account",
    //   "ads creative") so dev chatter ("add a field", "ads up") doesn't leak.
    // - ROAS / CPA / CPM are scored as word-bounded tokens. `/i` lowercases
    //   them but word boundaries protect "roas" from matching "across".
    // - `PAS` is intentionally excluded from the regex — 3-letter caps collide
    //   with French / unrelated acronyms. AIDA / BAB / FAB have negligible
    //   collision risk; the LLM classifier picks up PAS via framework-name
    //   context anyway.
    // - ES: `anuncios?` (noun) is the primary anchor; `campa[nñ]a` alone
    //   would match "campaña electoral" so it's only matched with a
    //   publicitary qualifier.
    //
    // Round-1 audit M1 fix: framework acronyms AIDA/BAB/FAB need TRAILING
    // `\b` inside the alternation. The outer `\b(?:...)` only anchors the
    // START of the whole group; a branch like `AIDA` with `/i` would match
    // inside "aidalicious" / "fabric" / "baby". Each acronym now carries
    // its own trailing word boundary.
    //
    // Round-2 audit C2 fix: SAME class as M1 applied to ROAS, brand noun
    // phrases, and `advertising`. `ROAS` without `\b` matches inside
    // `roast`/`roasted`/`roasting` (more common than the AIDA/BAB/FAB
    // collisions). Every capitalized-English-word branch here now carries
    // its own trailing `\b`.
    pattern:
      /\b(?:(?:meta|google|facebook|instagram|linkedin|tiktok|youtube|microsoft|bing|apple\s+search)\s+ads?\b|ads?\s+(?:account|campaign|creative|spend|audit|buyer|manager|platform|strategy|performance|agency|inventory|mix)\b|advertising\b|ROAS\b|CPA\b|CPM\b|brand\s+(?:dna|voice|profile)\b|AIDA\b|BAB\b|FAB\b|Star[-\s]Story[-\s]Solution|ads_(?:audit|brand_dna|creative_gen)|anuncios?\b|publicidad\b|publicitari[ao]s?\b|creatividad(?:es)?\b|identidad\s+de\s+marca|perfil\s+de\s+marca|voz\s+de\s+marca|campa[nñ]a\s+publicitaria|campa[nñ]as?\s+de\s+(?:anuncios?|marketing|publicidad|google|meta|facebook|instagram|tiktok|linkedin)|audita(?:r)?\s+(?:(?:mi|la|esa|esta)\s+)?(?:campa[nñ]a|cuenta\s+(?:de\s+)?anuncios?|publicidad|anuncios?))/i,
    group: "ads",
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
      /\b(agrega|añade|anade|quita|elimina|muestra|lista|trackea|add|remove|show|list|track|re-?seed|resembrar|re-?fetch|refresh|refrescar|re-?cargar|volver\s+a\s+cargar|volver\s+a\s+bajar)\b[^\n]{0,40}\b(watchlist|watch\s*list|ticker|symbol|s[ií]mbolo|acci[oó]n|historial)\b/i,
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
    // v7.0 F6 prediction markets — Polymarket/Kalshi nouns + betting verbs +
    // "probability/probabilidad". Per-audit W3 note: bare "probability" fires
    // on weather / everyday speech (same tradeoff as "expansion" in F5). We
    // accept that cost because a deferred tool sitting idle is cheaper than
    // the LLM missing a finance intent.
    pattern:
      /\b(polymarket|kalshi|prediction\s+markets?|mercado(?:s)?\s+de\s+predicci[oó]n|betting|apuesta(?:s)?|odds|probabilit(?:y|ies)|probabilidad(?:es)?)\b/i,
    group: "finance",
  },
  {
    // v7.0 F6 whales — whale activity, smart money, insiders
    pattern:
      /\b(whales?|ballenas?|smart\s+money|dinero\s+inteligente|insider(?:s)?|privilegiad\w*|EDGAR|flujo\s+de\s+ballenas?)\b/i,
    group: "finance",
  },
  {
    // v7.0 F6.5 sentiment — fear/greed, funding rates, liquidations, panic.
    // Audit W3: negative lookahead `(?!al|ales)` excludes "sentimental" /
    // "sentimentales" so casual Spanish/English doesn't activate finance.
    pattern:
      /\b(fear\s*(?:&|and)?\s*greed|miedo\s+y\s+codicia|sentiment(?!al)|sentimiento(?!s?\s+(?:persona|rom[aá]ntic))|funding\s+rates?|tasa(?:s)?\s+de\s+financiaci[oó]n|liquidation(?:s)?|liquidaci[oó]n(?:es)?|panic|p[aá]nico)\b/i,
    group: "finance",
  },
  {
    // v7.13 KB ingestion — activation requires a strong file signal to avoid
    // false positives on generic "extract data from the document" phrasing.
    // Audit C2: doc-noun narrowed to file-extensions (.pdf, .txt, .md) or
    // finance document keywords (10-K, earnings, filing, research paper).
    // Plus direct tool-verb shortcut `kb_ingest`/`kb_batch`.
    pattern:
      /\b(ingest|ingerir|ingesta|parse|parsear|extract|extraer|import|importar)\b[^\n]{0,40}\b(pdf|\.pdf|10-?k|earnings\s+(?:call|report|transcript)?|filing|research\s+paper|academic\s+paper)\b|\bkb[_\s]?(?:ingest|batch)\b/i,
    group: "kb_ingest",
  },
  {
    // v7.0 F7 alpha combination — activation on alpha/combination/megaalpha
    // vocabulary. Requires a strong signal-weights context so `alpha version`
    // / `alpha release` don't activate. ES + EN coverage.
    pattern:
      /\b(alpha[_\s-]?(?:run|latest|explain|combination|engine)|mega[_\s-]?alpha|megaalpha|signal[_\s-]?weights?|combin(?:e|ar|aci[oó]n)\s+(?:signals?|se[nñ]ales?)|pondera(?:ci[oó]n|r)\s+(?:signals?|se[nñ]ales?)|pesos?\s+de\s+se[nñ]ales?)\b/i,
    group: "alpha",
  },
  {
    // v7.0 F7.5 strategy backtester — activation on backtest/overfit/CPCV/PBO/DSR/
    // walk-forward vocab + Spanish equivalents. Tight anchors to avoid false
    // positives on generic "walk" or "test" words. Audit I2 round 1: `pbo`
    // alone could collide with "Pension Benefit Obligation" accounting text;
    // require it to co-occur with Sharpe/overfit/backtest/CPCV context.
    pattern:
      /\b(backtest(?:s|ing|ed|er)?|back[\s-]test(?:s|ing|ed|er)?|cpcv|deflat(?:ed|ion)?\s+sharpe|dsr|walk[_\s-]?forward|overfit(?:ting)?|sobre[_\s-]?ajust\w*|respald\w*\s+(?:la\s+)?(?:estrategia|strategy)|historial\s+de\s+backtests?|ship[_\s-]?block\w*)\b|\bpbo\b(?=[\s\S]{0,200}\b(?:sharpe|overfit|backtest|cpcv|dsr)\b)/i,
    group: "backtest",
  },
  {
    // v7.0 F8 paper trading — activation on paper/rebalance/portfolio/fills +
    // Spanish equivalents. Anchored so generic "paper" (document) doesn't
    // collide: require paper-trading context (paper_trade / paper trade /
    // paper-trade / papertrade). Audit W5 round 1: expanded `fills\s+recient\w*`
    // + `últimos fills` + `mis fills`; dropped bare `rebalance` verb (was
    // false-positive on "rebalance the disk"); require rebalance-of-PORTFOLIO
    // or cartera/posiciones context.
    pattern:
      /\b(paper[_\s-]?(?:trade|trading|rebalanc\w*|portfolio|history|fills?)|papertrade|paper\s+trade\w*|rebalanc(?:e|ear|eo|ed|ing)\s+(?:(?:la|el|del|de\s+la|the|my|your|this|a)\s+)?(?:cartera|portafolio|portfolio|posiciones|positions|paper)|portafolio|portfolio\s+actual|(?:ultimos|[úu]ltimos|mis|last|recent)\s+fills?|fills?\s+(?:recient\w*|recent\w*)|rotar\s+posiciones|ejecuta\s+(?:el\s+)?paper|ship[_\s-]?gate|override[_\s-]?ship)\b|\bpaper[_\s-]?equity\b/i,
    group: "paper",
  },
  {
    // v7.0 F9 market-ritual helpers — market calendar + alert budget vocab.
    // Anchored so generic "calendar" / "budget" don't collide with NorthStar /
    // AV-budget contexts; require market/NYSE/trading-day/holiday/alert-budget.
    pattern:
      /\b(market[_\s-]?calendar|nyse(?:\s+(?:calendar|holiday|open|closed?))?|trading[_\s-]?day|half[_\s-]?day|early[_\s-]?close|(?:market\w*|mercado\w*)\s+(?:abre|cierra|abierto|cerrado|feriado|holiday)|feriado\s+(?:nyse|de\s+mercado)|alert[_\s-]budget(?:[_\s-]?(?:status|remaining|consumed|exhausted|left|agotado))?|budget\s+(?:de\s+alertas?|del?\s+ritual|agotado))\b/i,
    group: "market_ritual",
  },
  {
    // v7.0 F8.1a PM alpha — prediction-market alpha combination. Anchors on
    // pm_alpha tool names + polymarket alpha phrasings + Spanish equivalents.
    // Generic "alpha" is avoided here (that's F7 equity scope); require
    // prediction-market context (polymarket / pm_alpha / mercados predicción).
    pattern:
      /\b(pm[_\s-]?alpha(?:[_\s-]?(?:run|latest|weights?))?|polymarket[_\s-]?alpha|prediction[_\s-]?market[_\s-]?(?:alpha|weights?|signals?)|mercados?\s+(?:de\s+)?predicci[oó]n\s+(?:alpha|pesos?|signals?)|alpha\s+(?:de\s+)?(?:polymarket|mercados?\s+(?:de\s+)?predicci[oó]n)|pondera(?:r|ci[oó]n)\s+(?:polymarket|mercados?\s+(?:de\s+)?predicci[oó]n))\b/i,
    group: "pm_alpha",
  },
  {
    // v7.0 F8.1b PM paper trading — rebalance + portfolio + history for the
    // Polymarket paper account. Scope activates on pm_paper tool names,
    // polymarket-rebalance phrasings, pm-positions/fills, and Spanish
    // equivalents. Distinct from F8 `paper` scope (equity) — generic "paper"
    // alone does NOT activate; must co-occur with pm / polymarket.
    pattern:
      /\b(pm[_\s-]?paper(?:[_\s-]?(?:rebalanc\w*|portfolio|history|fills?))?|polymarket[_\s-]?paper|paper[_\s-]?(?:polymarket|pm)|(?:rebalanc(?:e|ear|eo|ed|ing)|rotar)\s+(?:posiciones?\s+)?(?:polymarket|pm|prediction[_\s-]?market)|(?:posiciones|portafolio|portfolio|fills?|historial)\s+(?:de\s+)?(?:polymarket|pm)|polymarket\s+(?:rebalanc\w*|positions|portfolio|portafolio|posiciones|fills?|historial|history)|pm\s+(?:rebalanc\w*|portfolio|portafolio|posiciones|positions|fills?|historial|history)|prediction[_\s-]?market\s+(?:rebalanc\w*|positions|portfolio|portafolio|posiciones|fills?|historial|history))\b/i,
    group: "pm_paper",
  },
  {
    // v7.12 diagram_generate — activates on diagram/flowchart/architecture
    // vocabulary. Bilingual EN/ES. Negative lookahead on `diagram` not
    // needed (rare false-positive surface). Tool-name shortcuts for
    // `diagram_generate`, graphviz/dot invocation requests.
    pattern:
      /\b(diagrama?(?:\s+de\s+(?:secuencia|arquitectura|clases?|estados?|flujo|datos|er))?|diagram(?:s)?(?:\s+(?:of|for|showing))?|flowchart|flujograma|flujo\s+(?:de|del)|sequence\s+diagram|architecture\s+diagram|class\s+diagram|state\s+diagram|er\s+diagram|diagrama[_\s-]?generate|diagram[_\s-]?generate|graphviz|\bdigraph\s+\w|dot\s+graph|render\s+(?:a|the)\s+diagram|mermaid|d2\s+diagram|plantuml)\b/i,
    group: "diagram",
  },
  {
    // v7.2 knowledge graph — graphify-code MCP tools. Activates on
    // graph/knowledge-graph vocabulary. Negative lookahead on `graph` blocks
    // common English collisions: "graphic", "graphics", "grapheme", "graphene",
    // "graphene", "paragraph" (leading `para` excluded via word boundary but
    // also explicit exclusion). ES: "grafo" (not "grafica"/"grafico" which mean
    // "chart"). Also fires on explicit tool names and graphify CLI keywords.
    pattern:
      /\b(graphify|knowledge[_\s-]?graph|concept[_\s-]?map|god[_\s-]?nodes?|shortest[_\s-]?path|community\s+detection|neighbors?\s+of|call[_\s-]?graph|dependency\s+graph|grafo\s+(?:de|del|codigo|c[oó]digo|conocimiento)|mapa\s+conceptual|grafo\s+conceptual|query[_\s-]?graph|graph[_\s-]?stats?|get[_\s-]?neighbors?|get[_\s-]?community|get[_\s-]?node)\b/i,
    group: "graph",
  },
  {
    // Xpoz Reddit Intelligence Pipeline. Primary anchor is the brand token
    // `xpoz` (uniquely user-owned, zero English collisions). Secondary anchors:
    // namespaced tool shortcuts (`xpoz__...`), reddit-intel compounds, bare
    // `subreddit(s)`, and r/slug mentions. Bilingual-safe — Spanish phrasing
    // `Lanza Xpoz`, `corre el xpoz` still hit via the brand token.
    pattern:
      /\b(xpoz|xpoz__[a-z_]+|reddit\s+(?:intel(?:ligence)?|scraper|signal|pipeline|feed|digest|topics?|monitor)|subreddits?|r\/[A-Za-z0-9_]{2,21})\b/i,
    group: "xpoz",
  },
  {
    // v7.1 chart rendering + vision pattern recognition. Bilingual EN/ES.
    // Fires on:
    //  - Tool-name shortcuts: market_chart_render, market_chart_patterns
    //  - Financial chart vocabulary paired with a symbol / interval / pattern
    //    word (so bare "chart" without a finance anchor does NOT fire —
    //    generic chart_generate stays separate, as do diagram/infographic)
    //  - Named pattern keywords: head-and-shoulders, triangle, wedge, flag,
    //    channel, cup and handle, double top/bottom
    // `patterns` / `patrones` are intentionally broad — when an operator asks
    // about patterns on a financial symbol, WP/other scopes won't collide.
    pattern:
      /\b(market[_\s-]?chart[_\s-]?(?:render|patterns?)|candlestick|velas\s+japonesas|head[_\s-]and[_\s-]shoulders|hombro[_\s-]cabeza[_\s-]hombro|cabeza\s+y\s+hombros|double\s+(?:top|bottom)|doble\s+(?:techo|suelo|piso)|(?:ascending|descending|symmetrical)\s+triangle|tri[aá]ngulo\s+(?:ascendente|descendente|sim[eé]trico)|(?:rising|falling)\s+wedge|cu[nñ]a\s+(?:ascendente|descendente|alcista|bajista)|bull\s+flag|bear\s+flag|bandera\s+(?:alcista|bajista)|cup\s+and\s+handle|taza\s+(?:con|y)\s+asa|trend\s+channel|canal\s+de\s+tendencia|chart\s+pattern|patr[oó]n\s+(?:gr[aá]fic\w+|t[eé]cnic\w+|de\s+precio)|patrones?\s+(?:en|del?)\s+(?:el\s+)?(?:gr[aá]fic\w+|chart))\b/i,
    group: "chart",
  },
  {
    // v7.1 chart — ticker-anchored variant. Case-sensitive: "chart of SPY"
    // fires but "chart of these" doesn't, because the ticker arm requires
    // an uppercase 1-5-letter symbol (optionally $-prefixed). Negative
    // lookahead blocks common English 2-3-letter caps that are NOT tickers
    // (IT, US, EU, UK, ALL, NEW, WHO, CEO, CFO, CTO, COO, ETC, AKA, FAQ,
    // GDP, GPS, HR, PR, THE, ANY) — round-1 audit M2.
    pattern:
      /\b(?:chart|gr[aá]fico)\s+(?:of|for|de|para)\s+\$?(?!(?:IT|US|EU|UK|ALL|NEW|WHO|CEO|CFO|CTO|COO|ETC|AKA|FAQ|GDP|GPS|HR|PR|THE|ANY|ONE|YOU|ME)\b)[A-Z]{1,5}\b/,
    group: "chart",
  },
  {
    // v7.11 teaching module — direct learn/teach triggers. "me" anchor avoids
    // "teach the model to X" or "review the PR" false positives. ES forms
    // cover enséñame / enseñame (both accented variants), explícame + "desde
    // cero"/"paso a paso" (qualifier keeps it scoped to pedagogical intent).
    pattern:
      /\b(teach\s+me|ens[eé][nñ][aá]?[mln][aeo](?:lo|la|los|las|melo|mela|noslos)?|expl[ií]came\s+(?!(?:este|esta|el|la|ese|esa|un|una)\s+(?:bug|error|c[oó]digo|code|endpoint|funci[oó]n|function|problema|issue|pr\b|commit|controller|container|pod|deploy|deployment|pipeline|workflow|script|build|servicio|service|stack|dockerfile|makefile|repo|branch|tag|release|merge|migraci[oó]n|migration|query|endpoint|api|test|suite|rollout|release)\b)(?:\S+\s+){0,6}?(?:desde\s+cero|paso\s+a\s+paso)|quiero\s+aprender|want\s+to\s+learn|walk\s+me\s+through|tutor\s+me\s+on)\b/i,
    group: "teaching",
  },
  {
    // v7.11 teaching — session-level verbs: quiz me, review today, explain
    // back. All arms require a learning anchor (today, this week, repasar,
    // spaced-repetition nouns) to avoid dev-chat false positives ("review
    // the PR", "plan the sprint", "what's due for the task").
    pattern:
      /\b(quiz\s+me|qu[ií]zz?\s*me|t[oó]mame\s+(?:un\s+)?quiz|qu[ií]z[aá]me|what'?s\s+due\s+(?:today|this\s+week|for\s+review|to\s+review)|(?:what\s+)?(?:concepts?|topics?|conceptos?|temas?)\s+(?:do\s+I|tengo\s+que|debo)\s+(?:need\s+to\s+)?(?:review|repasar)|explain\s+back|expl[ií]came\s+de\s+vuelta|mi\s+(?:learning\s+plan|plan\s+de\s+aprendizaje|learner\s+model)|my\s+(?:learning\s+plan|learner\s+model)|(?:concepts?|conceptos?)\s+due\s+for\s+review|mastery\s+(?:report|status|score)|repasar\s+(?:mis\s+)?(?:conceptos|temas))\b/i,
    group: "teaching",
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
  // Defense-in-depth NFC normalization: every scope regex containing accented
  // character classes (art[ií]culo, c[aá]mbia, etc.) requires NFC input to match
  // decomposed Unicode from mobile clients. Idempotent — if caller already
  // normalized (router.ts main flow), this is a no-op. Guards direct callers
  // like router.ts background-agent path (taskText) where normalization was
  // missed. See feedback_nfd_unicode_scope_regex.md.
  currentMessage = normalizeForMatching(currentMessage);
  recentUserMessages = recentUserMessages.map((m) => normalizeForMatching(m));

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
    // NorthStar noun injection — classifier may emit `destructive` alone for
    // "limpia las tareas viejas" (reads "limpia" as cleanup, misses the
    // NorthStar noun). Without `northstar_read`, the destructive + NorthStar
    // co-occurrence rule below won't fire and jarvis_file_delete stays
    // offscope. Mirror the SEO/Google injection pattern to close this gap.
    if (
      !activeGroups.has("northstar_read") &&
      !activeGroups.has("northstar_write") &&
      !activeGroups.has("northstar_journal") &&
      /\b(tareas?|tasks?|metas?|goals?|objetivos?|objectives?|visi[oó]n|vision|pendientes?|northstar|north\s*star)\b/i.test(
        currentMessage,
      )
    ) {
      activeGroups.add("northstar_read");
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
    const isConversational = isShort && CONVERSATIONAL_PATTERN.test(trimmed);
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

  // Destructive intent in a NorthStar context → NorthStar write intent.
  // The classifier routes bare delete verbs ("elimina la tarea X") to
  // `destructive`, which by itself does NOT wire `JARVIS_WRITE_TOOLS`.
  // Without this rule, the user-visible bug is "Jarvis says it can't delete
  // NorthStar entries". Co-occurrence with any NorthStar group gates the
  // activation so we don't leak write tools into non-NorthStar deletes
  // (e.g. "borra esta imagen").
  if (
    activeGroups.has("destructive") &&
    (activeGroups.has("northstar_read") ||
      activeGroups.has("northstar_write") ||
      activeGroups.has("northstar_journal"))
  ) {
    activeGroups.add("northstar_write");
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
    activeGroups.add("ads");
    activeGroups.add("projects");
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
  if (activeGroups.has("projects")) {
    // Project entity operations — distinct from NorthStar goal mutations.
    // project_list is in MISC_TOOLS (always available); only get/update need
    // explicit scope activation since they are deferred.
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
  if (activeGroups.has("ads")) {
    tools.push(...ADS_TOOLS);
  }
  if (activeGroups.has("finance")) {
    tools.push(...FINANCE_TOOLS);
  }
  if (activeGroups.has("kb_ingest")) {
    tools.push(...KB_INGEST_TOOLS);
  }
  if (activeGroups.has("alpha")) {
    tools.push(...ALPHA_TOOLS);
  }
  if (activeGroups.has("backtest")) {
    tools.push(...BACKTEST_TOOLS);
  }
  if (activeGroups.has("paper")) {
    tools.push(...PAPER_TOOLS);
  }
  if (activeGroups.has("market_ritual")) {
    tools.push(...MARKET_RITUAL_TOOLS);
  }
  if (activeGroups.has("pm_alpha")) {
    tools.push(...PM_ALPHA_TOOLS);
  }
  if (activeGroups.has("pm_paper")) {
    tools.push(...PM_PAPER_TOOLS);
  }
  if (activeGroups.has("graph")) {
    tools.push(...GRAPH_TOOLS);
  }
  if (activeGroups.has("xpoz")) {
    tools.push(...XPOZ_TOOLS);
  }
  if (activeGroups.has("diagram")) {
    tools.push(...DIAGRAM_TOOLS);
  }
  if (activeGroups.has("chart")) {
    tools.push(...CHART_TOOLS);
  }
  if (activeGroups.has("teaching")) {
    tools.push(...TEACHING_TOOLS);
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
  // Defense-in-depth NFC normalization (see scopeToolsForMessage). Idempotent.
  currentMessage = normalizeForMatching(currentMessage);
  recentUserMessages = recentUserMessages.map((m) => normalizeForMatching(m));

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
