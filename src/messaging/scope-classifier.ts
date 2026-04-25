/**
 * Semantic scope classifier (v6.4 CL1.1).
 *
 * Replaces regex-based scope group detection with an LLM classifier.
 * The LLM reads the user message + recent context and returns which
 * scope groups should activate. Regex patterns kept as fallback when
 * the LLM fails, times out, or returns unparseable output.
 *
 * This eliminates the entire class of "scope pattern regression" bugs —
 * the LLM understands intent, not keywords.
 */

const SCOPE_CLASSIFIER_TIMEOUT_MS = 3_000;

/** All valid scope group names the classifier can return. */
const VALID_GROUPS = new Set([
  "northstar_read",
  "northstar_write",
  "northstar_journal",
  "jarvis_write",
  "destructive",
  "google",
  "browser",
  "coding",
  "schedule",
  "wordpress",
  "crm",
  "intel",
  "video",
  "social",
  "meta",
  "specialty",
  "research",
  "seo",
  "ads",
  "chart",
  "teaching",
  "xpoz",
  "projects",
]);

const CLASSIFIER_SYSTEM_PROMPT = `You are a scope classifier for Jarvis, an AI agent. Given a user message, return which capability groups are needed.

GROUPS (return only the ones that apply):
- northstar_read: reading tasks, goals, objectives, visions, NorthStar, pendientes, sync with db.mycommit
- northstar_write: creating/updating/completing/deleting tasks, goals, objectives, visions. "marca como completada", "crea una tarea", "elimina la tarea X", "borra esa meta", "quita ese objetivo", "delete that goal". Any mutation of a NorthStar item — including deletion — is northstar_write, NOT destructive.
- northstar_journal: writing diary/journal entries
- jarvis_write: writing/updating notes, SOPs, directives, rules, facts, lessons, procedures into Jarvis's knowledge base (the KB / base de conocimiento / jarvis_file_*). "guarda esta nota en el KB", "agrega una SOP", "registra esta regla", "escribe un SOP". Read-only KB consultations do NOT activate this group.
- destructive: deleting, removing, cleaning up items
- google: email, gmail, calendar, agenda, drive, sheets, slides, docs, google workspace
- browser: navigating websites, scraping, login, React/SPA apps, playwright
- coding: code, deploy, git, github, commit, push, files, scripts, debug, build, test, npm
- schedule: recurring tasks, cron, reports, reminders, automation, programar, cada día/hora
- wordpress: blog posts, WordPress, livingjoyfully.art, redlightinsider.com, publish to blog. Also fires on bare "WP" shorthand ("en WP", "el WP"), article-anchored integer-referenced posts ("el articulo 546", "el post 123", "la entrada 7"), and ES update-verb forms including subjunctive and accented clitic stems ("actualiza/actualice el articulo", "edita/edítalo el post", "modifica/modifique la entrada", "cambia/cámbialo"). Does NOT fire on generic UI "páginas" (login, 404, dashboard) — those are frontend work, not WP
- crm: CRM, Azteca, customer management (only when explicitly mentioned)
- intel: intelligence, signals, market, earthquake, cyber, threats, bitcoin, treasury
- video: video creation, clips, TikTok, YouTube, reels, screenshots, overlay, narration
- social: publish to Instagram/Facebook/TikTok/YouTube, social media posts, redes sociales
- meta: list tools, capabilities, diagnostics, herramientas disponibles
- specialty: charts, RSS, images, text humanization, dashboards, KPI, batch processing, research tools
- research: deep analysis, study guides, podcasts, PDF analysis, document research
- seo: SEO audits, keyword research, meta tags, schema markup (JSON-LD), rankings, SERP, PageSpeed, Core Web Vitals, content briefs, E-E-A-T, AI overviews / generative engine optimization (GEO), Open Graph, Twitter cards
- ads: paid-media / digital-marketing-buyer tasks. "audita la cuenta de Meta Ads", "audit my Google Ads", "genera 5 variantes de copy para TikTok", "extrae la identidad de marca de este sitio", "brand DNA", "qué ROAS tengo", "CPA está alto", "AIDA / PAS / BAB / FAB copy frameworks", "creatividades", "campaña publicitaria". ONLY fires on paid ads — organic social publishing is 'social', SEO is 'seo'.
- chart: financial chart rendering + vision pattern recognition. "gráfico de SPY", "renderiza un chart de AAPL con SMA50", "¿qué patrón ves en el chart?", "head and shoulders", "triángulo ascendente", "bull flag", "canal de tendencia", "candlestick". NOT generic bar/line charts (that is chart_generate in specialty). NOT diagrams (diagram_generate, v7.12) or infographics (infographic_generate, v7.14)
- teaching: pedagogical sequences — learning plans, adaptive quizzes, spaced-repetition review, Socratic explain-back. "teach me React hooks", "enséñame kubernetes", "explícame bond duration desde cero", "quiero aprender Go", "quiz me on SOLID principles", "review today", "what's due to review", "explain back". NOT a one-off explanation ("¿qué es X?" stays as a normal reply). NOT code review ("review the PR") and NOT ML model training ("teach the model").
- xpoz: Xpoz Reddit Intelligence Pipeline tasks — running the pipeline on a seed to cluster Reddit discussion into topics, reading the last digest, or pulling run history. "Lanza Xpoz pipeline", "corre el xpoz con la semilla X", "dame el digest de xpoz", "historial de Xpoz", "xpoz pipeline manager", "run the reddit scraper on r/wallstreetbets", "top Reddit signals", "última corrida de Xpoz". Brand anchor is 'xpoz' (case-insensitive). Also fires on 'reddit' + intel-verb compounds (reddit scraper/signals/pipeline/digest/topics/monitor) and bare 'subreddit(s)' or 'r/<slug>' mentions. NOT any 'pipeline' by itself (ML/CI/data pipelines are 'coding'). Tools: xpoz_trigger_run, xpoz_get_topics, xpoz_get_digest, xpoz_get_history.
- projects: project entity operations — reactivating, activating, archiving, pausing, completing, creating, or updating a project; setting project status; adding/updating project credentials, URLs, or config; reading project details. "reactiva el proyecto X", "archiva proyecto Y", "actualiza el status del proyecto Z a active", "crea un proyecto nuevo", "guarda credenciales del proyecto W", "muestra detalles del proyecto V". Projects are entities with their own lifecycle and credentials, DISTINCT from NorthStar goals/tasks/objectives. A project MAY link to a NorthStar goal via commit_goal_id, but project status changes are 'projects', NOT 'northstar_write'. Tools: project_get, project_update (project_list is always available).

RULES:
- Return ONLY groups needed. Empty array [] for greetings/small talk.
- A message can activate multiple groups (e.g., "envía un email con el reporte de tareas" → google + northstar_read).
- "publica en el blog" → wordpress (NOT social). "publica en Instagram" → social.
- "livingjoyfully" without .art/.com → NOT wordpress (it's a project name).
- VPS/server status questions need NO special group (vps_status is always available).
- Short follow-ups ("dale", "procede", "sí") → return [].

RESPOND with JSON array only. No explanation. Examples:
["northstar_read","google"]
["coding"]
[]`;

/**
 * Classify scope groups using LLM. Returns null on failure (caller uses regex fallback).
 */
export async function classifyScopeGroups(
  message: string,
  recentContext?: string,
): Promise<Set<string> | null> {
  try {
    const { infer } = await import("../inference/adapter.js");
    const { withTimeout } = await import("../lib/with-timeout.js");

    const userContent = recentContext
      ? `Recent context:\n${recentContext}\n\nUser message:\n${message}`
      : `User message:\n${message}`;

    const result = await withTimeout(
      infer({
        messages: [
          { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        max_tokens: 80,
      }),
      SCOPE_CLASSIFIER_TIMEOUT_MS,
      "scope classifier",
    );

    const raw = (result.content ?? "").trim();
    return parseScopeGroups(raw);
  } catch {
    return null; // Fallback to regex
  }
}

/**
 * Parse the LLM's scope group response.
 * Handles JSON arrays, markdown code fences, and comma-separated lists.
 */
export function parseScopeGroups(raw: string): Set<string> | null {
  // Try JSON array parse
  try {
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as string[];
      if (Array.isArray(parsed)) {
        const groups = new Set<string>();
        for (const g of parsed) {
          const normalized = String(g).trim().toLowerCase();
          if (VALID_GROUPS.has(normalized)) {
            groups.add(normalized);
          }
        }
        return groups;
      }
    }
  } catch {
    // Try fallback formats
  }

  // Try comma-separated: "northstar_read, google"
  if (raw.includes(",") || VALID_GROUPS.has(raw.trim().toLowerCase())) {
    const groups = new Set<string>();
    for (const part of raw.split(/[,\n]+/)) {
      const cleaned = part
        .trim()
        .toLowerCase()
        .replace(/["\[\]]/g, "");
      if (VALID_GROUPS.has(cleaned)) {
        groups.add(cleaned);
      }
    }
    if (groups.size > 0) return groups;
  }

  return null; // Unparseable — fallback to regex
}
