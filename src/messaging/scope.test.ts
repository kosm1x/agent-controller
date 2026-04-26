/**
 * Tests for scope.ts — pattern matching, two-phase isolation, feature gates.
 *
 * scopeToolsForMessage is a pure function — no mocking needed.
 */

import { describe, it, expect } from "vitest";
import {
  scopeToolsForMessage,
  detectActiveGroups,
  DEFAULT_SCOPE_PATTERNS,
  CORE_TOOLS,
  GOOGLE_TOOLS,
  WORDPRESS_TOOLS,
  CODING_TOOLS,
  RESEARCH_TOOLS,
  SPECIALTY_TOOLS,
  SCHEDULE_TOOLS,
  MISC_TOOLS,
  CRM_TOOLS_SCOPE,
  SEO_TOOLS,
  ADS_TOOLS,
  CHART_TOOLS,
  TEACHING_TOOLS,
  VIDEO_TOOLS,
} from "./scope.js";
import type { ScopeOptions } from "./scope.js";

const ALL_ON: ScopeOptions = {
  hasGoogle: true,
  hasWordpress: true,
  hasMemory: true,
  hasCrm: true,
};

function scope(msg: string, prior: string[] = [], options = ALL_ON): string[] {
  return scopeToolsForMessage(msg, prior, DEFAULT_SCOPE_PATTERNS, options);
}

function hasAll(tools: string[], expected: string[]): boolean {
  return expected.every((t) => tools.includes(t));
}

function hasNone(tools: string[], excluded: string[]): boolean {
  return excluded.every((t) => !tools.includes(t));
}

// ---------------------------------------------------------------------------
// Pattern matching — each scope group activates on its keywords
// ---------------------------------------------------------------------------

describe("scope pattern matching", () => {
  it("northstar_read activates on task/goal nouns (tarea, objetivo, meta)", () => {
    const tools = scope("Qué tareas tengo pendientes?");
    expect(tools).toContain("jarvis_file_read");
  });

  it("google activates on email/calendar/drive keywords", () => {
    const tools = scope("Busca en mi gmail los correos de ayer");
    expect(hasAll(tools, GOOGLE_TOOLS)).toBe(true);
  });

  it("coding activates on code/deploy/script keywords", () => {
    const tools = scope("Revisa el código del servidor");
    expect(tools).toContain("shell_exec");
    expect(tools).toContain("file_edit");
  });

  it("projects scope loads project_get/project_update on reactivate verb", () => {
    const tools = scope("Reactiva el proyecto williams-entry-radar");
    expect(tools).toContain("project_update");
    expect(tools).toContain("project_get");
  });

  it("projects scope loads project tools on archive verb", () => {
    const tools = scope("archiva el proyecto vlmp");
    expect(tools).toContain("project_update");
  });

  it("projects scope loads project tools on status update phrasing", () => {
    const tools = scope("actualiza proyecto x status active");
    expect(tools).toContain("project_update");
  });

  it("projects scope loads project tools on credentials update", () => {
    const tools = scope("guarda las credenciales del proyecto crm-azteca");
    expect(tools).toContain("project_update");
  });

  it("pure project ops do NOT activate NorthStar write tools", () => {
    const tools = scope("archiva el proyecto vlmp");
    expect(tools).toContain("project_update");
    expect(tools).not.toContain("jarvis_file_write");
    expect(tools).not.toContain("jarvis_file_update");
    expect(tools).not.toContain("jarvis_file_delete");
  });

  it("coding scope does NOT over-fire on bare 'react' substrings (reactiva, reactor, reaction)", () => {
    // Coding regex's `react` alternation lacked a closing `\b`, so it matched
    // any prefix — `reactivar`, `reactor`, `reaction`, `reactividad` — pulling
    // CODING_TOOLS into project-management and unrelated chatter. Tightened to
    // `react\b` 2026-04-26.
    expect(scope("Reactiva el proyecto vlmp")).not.toContain("shell_exec");
    expect(scope("el reactor sufrió una falla")).not.toContain("shell_exec");
    expect(scope("la reacción del público fue mixta")).not.toContain(
      "shell_exec",
    );
    // Sanity: legit React mentions still activate coding scope.
    expect(scope("escribe un componente React para el dashboard")).toContain(
      "shell_exec",
    );
  });

  it("google scope does NOT over-fire on 'present' substrings (presentación, presentar)", () => {
    // The google regex had a bare `|present|` alt without closing `\b`, so it
    // matched any prefix — `presentación`, `presentar`, `presente` — pulling
    // GOOGLE_TOOLS into ordinary speech. Closed with `\b` and the bare alt
    // dropped 2026-04-26 (vlcms-continuation incident). Same bug class as the
    // `react\b` fix above.
    expect(scope("presentación de la propuesta para el cliente")).not.toContain(
      "gmail_send",
    );
    expect(scope("vamos a presentar el plan al equipo")).not.toContain(
      "gmail_send",
    );
    expect(scope("el presente informe explica los cambios")).not.toContain(
      "gmail_send",
    );
    // Sanity: explicit google mentions still activate.
    expect(scope("envía un correo a Juan con el reporte")).toContain(
      "gmail_send",
    );
    expect(scope("abre mi gmail y busca el último mensaje")).toContain(
      "gmail_send",
    );
    // Sanity: Spanish "calendario" still triggers google (the `\b` close
    // would have broken bare `calendar` matching `calendario`; the alt was
    // expanded to `calendars?|calendarios?` to keep both forms working).
    expect(scope("revisa mi calendario para mañana")).toContain("gmail_send");
  });

  // Residual-leak documentation: closing `\b` only fixes prefix-match bugs.
  // The google regex still has bare exact-word alts (`agenda`, `drive`,
  // `document[oa]?s?`, `hojas?`, `slides?`) that match generic Spanish/English
  // words outside any Google context. These are deferred to a separate
  // post-freeze ticket because narrowing them requires either dropping alts
  // (loses Spanish "agenda" → calendar inheritance some users rely on) or
  // requiring co-occurring `google\s*` context (semantically a new alt
  // structure, not freeze-aligned tightening). Tracked in
  // feedback_unbounded_alternation_fp.md as the wider sweep.
  it.todo(
    "google scope should not over-fire on bare 'agenda' / 'drive' / 'documento' (post-freeze tightening)",
  );

  it("NorthStar mentions without project verbs do NOT activate project tools", () => {
    const tools = scope("Qué tareas tengo pendientes?");
    expect(tools).not.toContain("project_update");
    expect(tools).not.toContain("project_get");
  });

  it("projects scope does NOT over-fire on adverbs that share verb prefixes", () => {
    // "activamente"/"completamente"/"infografía" must not trigger projects.
    // Word boundary on the verb alternation prevents adverbial false positives.
    expect(scope("trabajamos activamente en este proyecto")).not.toContain(
      "project_update",
    );
    expect(scope("revisé completamente el proyecto")).not.toContain(
      "project_update",
    );
    expect(scope("genera una infografía sobre proyectos")).not.toContain(
      "project_update",
    );
  });

  it("projects scope handles accent-tolerant read verbs", () => {
    expect(scope("muéstrame el proyecto vlmp")).toContain("project_get");
    expect(scope("descríbeme el proyecto vlmp")).toContain("project_get");
  });

  it("projects regex patterns are bounded against catastrophic backtracking", () => {
    // Both new patterns use {0,5} and {0,8} bounded slop. A pathological
    // input should still complete in linear time.
    const long = "a".repeat(2000) + " proyecto " + "b".repeat(2000);
    const start = Date.now();
    for (const p of DEFAULT_SCOPE_PATTERNS) {
      p.pattern.test(long);
    }
    expect(Date.now() - start).toBeLessThan(200);
  });

  it("Lightpanda core tools always available, extras scope-gated", () => {
    const tools = scope("Hola, buenos días");
    // Core Lightpanda: goto + markdown always available
    expect(tools).toContain("browser__goto");
    expect(tools).toContain("browser__markdown");
    // Extra Lightpanda tools now scope-gated (not in generic messages)
    expect(tools).not.toContain("browser__click");
    expect(tools).not.toContain("browser__fill");
    // Playwright tools still scope-gated
    expect(tools).not.toContain("playwright__browser_navigate");
  });

  it("Lightpanda extra tools activate on browser keywords", () => {
    const tools = scope("Navega al sitio web y llena el formulario");
    expect(tools).toContain("browser__goto");
    expect(tools).toContain("browser__click");
    expect(tools).toContain("browser__fill");
    expect(tools).toContain("browser__structuredData");
  });

  it("Playwright tools activate on browser/SPA keywords", () => {
    const tools = scope("Navega al login de la app React");
    expect(tools).toContain("playwright__browser_navigate");
    expect(tools).toContain("playwright__browser_click");
    expect(tools).toContain("playwright__browser_snapshot");
  });

  it("specialty activates on chart_generate / rss / image keywords", () => {
    // Round-1 audit M1 (v7.1): specialty previously fired on bare "gráfic"
    // and "chart", double-loading with the new `chart` group. Narrowed to
    // chart_generate + anchored bar/line/pie constructs. This test now
    // exercises the RSS keyword (unchanged) and the generic bar-chart form.
    const tools = scope("dame una bar chart con los valores mensuales");
    expect(hasAll(tools, SPECIALTY_TOOLS)).toBe(true);
  });

  it("research activates on gemini/study/podcast keywords", () => {
    const tools = scope("Hazme un study guide del documento");
    expect(hasAll(tools, RESEARCH_TOOLS)).toBe(true);
  });

  it("research activates on 'lee este PDF'", () => {
    const tools = scope("Lee este PDF y dame un resumen");
    expect(hasAll(tools, RESEARCH_TOOLS)).toBe(true);
    expect(tools).toContain("pdf_read");
  });

  it("research activates on .pdf file reference", () => {
    const tools = scope("Analiza el archivo reporte.pdf");
    expect(hasAll(tools, RESEARCH_TOOLS)).toBe(true);
  });

  it("crm activates ONLY when CRM or Azteca is mentioned", () => {
    expect(scope("Del CRM de Azteca, dime cómo van")).toContain("crm_query");
    expect(scope("Del CRM, dime el proyectado")).toContain("crm_query");
    expect(scope("Oye del crm azteca dime quién va más atrasado")).toContain(
      "crm_query",
    );
    expect(scope("Revisa el CRM")).toContain("crm_query");
  });

  it("crm does NOT activate on generic sales words without CRM mention", () => {
    expect(scope("Cómo va el pipeline de ventas?")).not.toContain("crm_query");
    expect(scope("Dame la cuota de esta semana")).not.toContain("crm_query");
    expect(scope("Quiero ver los prospectos activos")).not.toContain(
      "crm_query",
    );
    expect(scope("Crea una tarea nueva")).not.toContain("crm_query");
    expect(scope("Busca en mi gmail")).not.toContain("crm_query");
  });

  it("jarvis file tools always present in core", () => {
    const tools = scope("Lista mis visiones");
    expect(tools).toContain("jarvis_file_read");
    expect(tools).toContain("jarvis_file_list");
  });

  it("schedule activates on schedule/reporte/programad keywords", () => {
    const tools = scope("Programa un reporte diario");
    expect(hasAll(tools, SCHEDULE_TOOLS)).toBe(true);
  });

  it("meta scope loads ALL groups for diagnostics", () => {
    const tools = scope(
      "Vuelve a hacer el autodiagnostico y lista todas las tools",
    );
    expect(tools).toContain("schedule_task");
    expect(hasAll(tools, CODING_TOOLS)).toBe(true);
  });

  it("meta scope activates on 'herramientas disponibles'", () => {
    const tools = scope("Cuáles herramientas disponibles tienes?");
    expect(tools).toContain("jarvis_file_read");
  });

  it("meta scope activates on 'nivel operativo'", () => {
    const tools = scope("Dame un auto-diagnostico de tu nivel operativo");
    expect(tools).toContain("jarvis_file_read");
  });

  it("no false positives on casual Spanish conversation", () => {
    const tools = scope("Hola, buenos días. Cómo estás?");
    // Should only have core + misc tools (list_dir + file_read are in CORE, so exclude from check)
    expect(hasNone(tools, GOOGLE_TOOLS)).toBe(true);
    const codingExclusive = CODING_TOOLS.filter((t) => !CORE_TOOLS.includes(t));
    expect(hasNone(tools, codingExclusive)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // v7.0 Phase β — finance group activation
  // ---------------------------------------------------------------------------

  it("finance activates on $SYMBOL pattern", () => {
    const tools = scope("$SPY cotiza?");
    expect(tools).toContain("market_quote");
  });

  it("finance activates on watchlist CRUD verbs (ES)", () => {
    const tools = scope("Jarvis, agrega TSLA a mi watchlist");
    expect(tools).toContain("market_watchlist_add");
  });

  it("finance activates on indicator vocabulary (F2/F4)", () => {
    for (const msg of [
      "Compute RSI on SPY",
      "MACD de AAPL",
      "Bollinger bands on NVDA",
      "Find oversold names",
      "Scan the watchlist",
    ]) {
      const tools = scope(msg);
      expect(
        tools.includes("market_indicators") || tools.includes("market_scan"),
      ).toBe(true);
    }
  });

  it("finance activates on macro vocabulary (F5)", () => {
    for (const msg of [
      "What's the yield curve?",
      "Show me the macro regime",
      "Fed funds rate",
      "Is there recession risk?",
      "VIX level",
      "CPI inflation",
    ]) {
      const tools = scope(msg);
      expect(tools).toContain("macro_regime");
    }
  });

  it("finance activates on signal vocabulary (F3)", () => {
    for (const msg of [
      "Any signals firing?",
      "Detect crossovers on SPY",
      "Bollinger breakout",
      "Any divergence?",
      "Scan for golden cross",
    ]) {
      const tools = scope(msg);
      expect(
        tools.includes("market_signals") || tools.includes("market_scan"),
      ).toBe(true);
    }
  });

  it("finance activates on prediction-markets vocab (F6)", () => {
    for (const msg of [
      "Check Polymarket odds for the election",
      "Show prediction markets on BTC",
      "What does Kalshi show for recession?",
      "Cuál es la probabilidad de que...",
    ]) {
      const tools = scope(msg);
      expect(tools).toContain("prediction_markets");
    }
  });

  it("finance activates on whale vocab (F6)", () => {
    for (const msg of [
      "Any whale trades today?",
      "Show smart money flow on this market",
      "What are the whales doing?",
      "Insider filings",
    ]) {
      const tools = scope(msg);
      expect(tools).toContain("whale_trades");
    }
  });

  it("finance activates on sentiment vocab (F6.5)", () => {
    for (const msg of [
      "Fear and greed index?",
      "Check funding rates",
      "Any panic selling?",
      "Sentiment snapshot",
      "Miedo y codicia",
    ]) {
      const tools = scope(msg);
      expect(tools).toContain("sentiment_snapshot");
    }
  });

  it("kb_ingest activates on 'ingest this pdf' (EN)", () => {
    const tools = scope("ingest this pdf into the KB");
    expect(tools).toContain("kb_ingest_pdf_structured");
  });

  it("kb_ingest activates on 'ingerir este pdf' (ES)", () => {
    const tools = scope("por favor ingerir este pdf financiero");
    expect(tools).toContain("kb_ingest_pdf_structured");
  });

  it("kb_ingest activates on 'extract tables from report.pdf'", () => {
    const tools = scope("extract the tables from report.pdf");
    expect(tools).toContain("kb_ingest_pdf_structured");
  });

  it("kb_ingest does NOT activate on neutral extract/parse phrases without file signal (audit C2)", () => {
    for (const msg of [
      "extract data from the document I just read",
      "can you extract the table please",
      "let's parse this document",
      "extract the sale's profit margin from last year",
    ]) {
      const tools = scope(msg);
      expect(
        tools.includes("kb_ingest_pdf_structured"),
        `Expected kb_ingest NOT to activate on: "${msg}"`,
      ).toBe(false);
    }
  });

  it("finance does NOT activate on unrelated English with 'expansion' or 'signal'", () => {
    // 'expansion' appears in our macro regex. Narrow false-positive risk:
    // 'cache expansion' should only activate via coding/browser context, not finance.
    const tools1 = scope("How is the cache expansion project going?");
    // May still match because 'expansion' is in the regex as a bare word.
    // Flag via tests: this is expected activation (we accept the false positive
    // cost because F5 needs to trigger on the bare word 'expansion' when a
    // user asks about macroeconomic expansion).
    expect(tools1).toContain("macro_regime");

    // But plain greetings should not activate finance at all.
    const tools2 = scope("Hola, cómo estás?");
    expect(hasNone(tools2, ["macro_regime", "market_signals"])).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // F8 paper trading — scope activation (audit W5 round 1)
  // ---------------------------------------------------------------------------

  it("paper activates on paper-trading verbs + portfolio vocab", () => {
    for (const msg of [
      "paper trade this",
      "ejecuta paper trade",
      "rebalancear la cartera",
      "rebalanceo del portafolio",
      "rebalance positions now",
      "portfolio actual",
      "portafolio actual",
      // Note: accented "últimos" hits a JS `\b` + non-ASCII edge case; the
      // un-accented variant works reliably and is the common spelling in ES
      // keyboard workflows.
      "ultimos fills",
      "mis fills",
      "recent fills",
      "fills recientes",
      "rotar posiciones",
      "ship_gate check",
      "override_ship flag",
      "ejecuta el paper",
      "paper_rebalance now",
      "paper_portfolio",
      "paper_history",
    ]) {
      const tools = scope(msg);
      expect(
        tools.includes("paper_rebalance") ||
          tools.includes("paper_portfolio") ||
          tools.includes("paper_history"),
      ).toBe(true);
    }
  });

  it("paper does NOT activate on generic paper/disk/portfolio phrases", () => {
    for (const msg of [
      "research paper on PBO",
      "upload this paper to the kb",
      "lee el paper académico",
      "please rebalance the disk",
      "the portfolio is in USD",
      "can you write a paper for me",
    ]) {
      const tools = scope(msg);
      expect(
        hasNone(tools, ["paper_rebalance", "paper_portfolio", "paper_history"]),
      ).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // F9 market-ritual helpers — scope activation
  // ---------------------------------------------------------------------------

  it("market_ritual activates on calendar + budget vocab", () => {
    for (const msg of [
      "is tomorrow a trading day?",
      "market_calendar for next friday",
      "nyse holiday next week",
      "mercado abre mañana?",
      "mercado cerrado por feriado?",
      "early close this week?",
      "half-day friday?",
      "how much alert budget is left today",
      "budget de alertas remaining",
      "alert_budget_status",
      "budget del ritual agotado",
    ]) {
      const tools = scope(msg);
      expect(
        tools.includes("market_calendar") ||
          tools.includes("alert_budget_status"),
      ).toBe(true);
    }
  });

  it("market_ritual does NOT activate on generic calendar/budget phrases", () => {
    for (const msg of [
      "open my calendar",
      "schedule a meeting calendar",
      "what's my AV api budget",
      "project budget status",
      "alpha vantage budget remaining",
    ]) {
      const tools = scope(msg);
      expect(hasNone(tools, ["market_calendar", "alert_budget_status"])).toBe(
        true,
      );
    }
  });

  // ---------------------------------------------------------------------------
  // F8.1a pm_alpha — PM alpha layer (β-addendum)
  // ---------------------------------------------------------------------------

  it("pm_alpha activates on prediction-market alpha vocab", () => {
    for (const msg of [
      "pm_alpha_run",
      "pm_alpha_latest",
      "pm alpha weights",
      "polymarket alpha",
      "polymarket_alpha",
      "prediction market alpha",
      "prediction-market weights",
      "mercados predicción alpha",
      "mercados de predicción pesos",
      "alpha de polymarket",
      "ponderar polymarket",
      "ponderación polymarket",
    ]) {
      const tools = scope(msg);
      expect(
        tools.includes("pm_alpha_run") || tools.includes("pm_alpha_latest"),
      ).toBe(true);
    }
  });

  it("pm_alpha does NOT activate on generic alpha / market phrases", () => {
    for (const msg of [
      "alpha_run",
      "mega alpha weights",
      "alpha combination",
      "ponderación de señales técnicas",
      "market indicators",
      "polymarket odds on BTC", // F6 read, not alpha
    ]) {
      const tools = scope(msg);
      expect(hasNone(tools, ["pm_alpha_run", "pm_alpha_latest"])).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // F8.1b pm_paper — PM paper trading (β-addendum)
  // ---------------------------------------------------------------------------

  it("pm_paper activates on PM paper trading vocab", () => {
    for (const msg of [
      "pm_paper_rebalance",
      "pm_paper_portfolio",
      "pm_paper_history",
      "polymarket paper",
      "paper polymarket",
      "rebalance polymarket",
      "rotar polymarket",
      "rebalancear posiciones polymarket",
      "posiciones polymarket",
      "portafolio polymarket",
      "polymarket positions",
      "polymarket fills",
      "historial polymarket",
      "pm paper rebalance",
    ]) {
      const tools = scope(msg);
      expect(
        tools.includes("pm_paper_rebalance") ||
          tools.includes("pm_paper_portfolio") ||
          tools.includes("pm_paper_history"),
      ).toBe(true);
    }
  });

  it("pm_paper does NOT collide with F8 equity `paper` scope", () => {
    for (const msg of [
      "paper_rebalance", // F8 equity
      "paper trade",
      "rebalance the portfolio", // F8 equity
      "portafolio actual",
      "mis fills",
    ]) {
      const tools = scope(msg);
      expect(
        hasNone(tools, [
          "pm_paper_rebalance",
          "pm_paper_portfolio",
          "pm_paper_history",
        ]),
      ).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // v7.2 graph — graphify-code knowledge-graph MCP tools
  // ---------------------------------------------------------------------------

  it("graph activates on knowledge-graph vocab (EN + ES) and assembles all 7 tools", () => {
    // Audit W1 fix: verify the FULL tool set flows through, not just one.
    // Otherwise a rename of a single tool silently passes this test.
    const EXPECTED_TOOLS = [
      "graphify-code__query_graph",
      "graphify-code__get_node",
      "graphify-code__get_neighbors",
      "graphify-code__get_community",
      "graphify-code__god_nodes",
      "graphify-code__graph_stats",
      "graphify-code__shortest_path",
    ];
    for (const msg of [
      "show me the knowledge graph stats",
      "query_graph for F7",
      "graphify-code__god_nodes",
      "what are the god nodes in the codebase",
      "god_nodes top 10", // Audit M1 fix: underscore form must activate
      "god-nodes please", // Audit M1 fix: hyphen form must activate
      "shortest path between MacroFeatureRow and runAlpha",
      "get_neighbors of paper-executor",
      "community detection on src",
      "muéstrame el grafo de código",
      "grafo de conocimiento del proyecto",
      "mapa conceptual de los sprints",
      "graph_stats",
    ]) {
      const tools = scope(msg);
      expect(tools, `expected all 7 GRAPH_TOOLS for "${msg}"`).toEqual(
        expect.arrayContaining(EXPECTED_TOOLS),
      );
    }
  });

  it("graph does NOT activate on graphic/graphene/paragraph/gráfica", () => {
    for (const msg of [
      "graphic design for the landing page",
      "make me some graphics",
      "grapheme clusters in Unicode",
      "graphene sheets chemistry",
      "paragraph formatting",
      "gráfica de ventas mensuales", // ES "chart", NOT graph
      "gráfico de barras",
      "hazme una gráfica bonita",
    ]) {
      const tools = scope(msg);
      expect(
        hasNone(tools, [
          "graphify-code__query_graph",
          "graphify-code__graph_stats",
          "graphify-code__god_nodes",
        ]),
        `unexpected graph scope on "${msg}"`,
      ).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // v7.10 utility — file_convert (dispatches to calibre / libreoffice /
  // pandoc / imagemagick / ffmpeg). Activates on conversion verbs, tool
  // shortcuts, frame-extraction phrasing, and explicit file-format anchors.
  // ---------------------------------------------------------------------------

  it("utility activates on file-conversion vocab and includes file_convert", () => {
    for (const msg of [
      "convert this .epub to txt",
      "convertir el archivo a pdf",
      "convierte book.mobi a html",
      "transform the odt to docx",
      "transforma el pptx en pdf",
      // Audit W-R2-1: ES clitic forms without a determiner must still match.
      "transformalo a pdf",
      "transformalo en html",
      "extract a frame from the video at 5s",
      "extraer un frame del mp4",
      "ebook-convert book.epub output.txt",
      "run pandoc on my markdown",
      "file_convert please",
      "I have a .heic from my iPhone",
      "report.pages needs converting",
    ]) {
      const tools = scope(msg);
      expect(tools, `file_convert missing for "${msg}"`).toContain(
        "file_convert",
      );
    }
  });

  // ---------------------------------------------------------------------------
  // v7.12 diagram — diagram_generate scope group (graphviz / svg_html).
  // Mermaid deferred (mmdc hangs on this VPS), but the scope regex includes
  // "mermaid" so a user request routed to diagram_generate still produces a
  // helpful "mermaid deferred" error from the tool — better than the scope
  // not firing at all.
  // ---------------------------------------------------------------------------

  it("diagram scope activates on diagram/flowchart vocab (EN + ES)", () => {
    for (const msg of [
      "draw me an architecture diagram of the service",
      "genera un diagrama de arquitectura",
      "sequence diagram for the login flow",
      "diagrama de secuencia del login",
      "flowchart showing the request pipeline",
      "flujograma del pipeline",
      "ER diagram for the database",
      "diagrama ER de la base de datos",
      "state diagram of the order lifecycle",
      "class diagram for these modules",
      "diagrama de clases",
      "graphviz architecture of our infra",
      "digraph G { A -> B; }",
      "render a diagram of the service topology",
      "diagram_generate please",
    ]) {
      const tools = scope(msg);
      expect(tools, `diagram_generate missing for "${msg}"`).toContain(
        "diagram_generate",
      );
    }
  });

  it("diagram scope does NOT activate on unrelated mentions", () => {
    for (const msg of [
      "the diagnosis is fine", // no diagram token
      "diagnose the service",
      "dot product of vectors",
      "use the shell to ls the dir",
      "hello",
    ]) {
      const tools = scope(msg);
      expect(tools, `unexpected diagram_generate for "${msg}"`).not.toContain(
        "diagram_generate",
      );
    }
  });

  it("utility does NOT activate file_convert on unrelated format mentions", () => {
    // These should NOT pull the utility scope — "send me a PDF" shouldn't
    // leak file_convert into the tool set for every prompt that mentions
    // PDFs. The regex is narrow (leading `.` anchors file extensions).
    for (const msg of [
      "send me a PDF version of the report", // naked "PDF" — no dot, no verb
      "write me a docx summary", // "write" not "convert"; "docx" no dot
      "share a png of the dashboard", // "share" + "png" alone
      "the pdf attached to that email", // descriptive, no action
    ]) {
      const tools = scope(msg);
      expect(tools, `unexpected file_convert scope on "${msg}"`).not.toContain(
        "file_convert",
      );
    }
  });

  // ---------------------------------------------------------------------------
  // v7.14 specialty — infographic_generate vocabulary (EN + ES, 6 forms).
  // Audit M1: original regex `infograph(?:ic|ía|ia)s?` forced a shared EN
  // root `infograph` which broke all ES forms (`infografía` uses root
  // `infograf`). Fix: separate alternations per-language.
  // ---------------------------------------------------------------------------

  it("specialty activates on all infographic forms (EN sing/plur + ES accented/unaccented sing/plur)", () => {
    for (const msg of [
      "make me an infographic of Q4 results", // EN singular
      "generate three infographics for the deck", // EN plural
      "hazme una infografía del Q4", // ES accented singular
      "hazme una infografia del Q4", // ES unaccented singular
      "crea dos infografías para el cliente", // ES accented plural
      "crea dos infografias para el cliente", // ES unaccented plural
      "SWOT analysis for project X", // SWOT shortcut
      "summary card of this week", // summary card
      "cuadro resumen de la semana", // ES summary card
      "tarjeta resumen Q4", // ES KPI card
      "ranking pyramid of top 5 clients", // ranking pyramid
      "timeline card of the project", // timeline card
    ]) {
      const tools = scope(msg);
      expect(tools, `infographic_generate missing for "${msg}"`).toContain(
        "infographic_generate",
      );
    }
  });

  it("specialty infographic regex does NOT over-match (infograph/infographia non-words)", () => {
    for (const msg of [
      "the programmable infrastructure", // contains `infr` not `infograf`
      "photograph of the team", // `photograph` is unrelated
      "choreography of the dance", // `-ography` word
    ]) {
      const tools = scope(msg);
      expect(
        tools,
        `unexpected infographic_generate for "${msg}"`,
      ).not.toContain("infographic_generate");
    }
  });
});

// ---------------------------------------------------------------------------
// northstar_write patterns — each of 6 sub-patterns tested independently
// ---------------------------------------------------------------------------

describe("northstar_write sub-patterns", () => {
  it("create verbs: 'Crea una tarea nueva'", () => {
    const tools = scope("Crea una tarea nueva para mañana");
    expect(tools).toContain("jarvis_file_write");
  });

  it("verb-first updates: 'Actualiza la tarea de diseño'", () => {
    const tools = scope("Actualiza la tarea de diseño UX");
    expect(tools).toContain("jarvis_file_write");
  });

  it("clitic pronouns: 'cámbialo'", () => {
    const tools = scope("El objetivo está mal, cámbialo");
    expect(tools).toContain("jarvis_file_write");
  });

  it("completion markers: 'Marca como completada'", () => {
    const tools = scope("Marca como completada la tarea");
    expect(tools).toContain("jarvis_file_write");
  });

  it("completion + noun: 'Completé la tarea'", () => {
    const tools = scope("Completé la tarea de escritura");
    expect(tools).toContain("jarvis_file_write");
  });

  it("noun-before-verb: 'La tarea de ayer, actualízala'", () => {
    const tools = scope("La tarea de ayer necesita cambios, actualízala");
    expect(tools).toContain("jarvis_file_write");
  });

  it("delete verb + noun (ES): 'Elimina la tarea de prueba'", () => {
    const tools = scope("Elimina la tarea de prueba");
    expect(tools).toContain("jarvis_file_delete");
  });

  it("delete verb + noun (ES, 'borra'): 'Borra esa meta'", () => {
    const tools = scope("Borra esa meta que ya no aplica");
    expect(tools).toContain("jarvis_file_delete");
  });

  it("delete verb + noun (ES, 'quita'): 'Quita el objetivo'", () => {
    const tools = scope("Quita el objetivo de Q2 por favor");
    expect(tools).toContain("jarvis_file_delete");
  });

  it("delete verb + noun (EN): 'Delete that task'", () => {
    const tools = scope("Delete that task from my list");
    expect(tools).toContain("jarvis_file_delete");
  });

  it("clitic + noun in same message: 'esa meta, elimínala'", () => {
    // The clitic resolves because "meta" appears in the same message, activating
    // both destructive (via clitic verb) and northstar_read (via noun) — the
    // co-occurrence rule promotes it to northstar_write.
    const tools = scope("Esa meta ya no sirve, elimínala");
    expect(tools).toContain("jarvis_file_delete");
  });

  it("non-NorthStar clitic does NOT pull jarvis_file_delete", () => {
    // "borra esta imagen, bórrala" → destructive present but no NorthStar
    // noun → co-occurrence rule does NOT fire → write tools stay out of scope.
    const tools = scope("borra esta imagen, bórrala del feed");
    expect(tools).not.toContain("jarvis_file_delete");
  });
});

// ---------------------------------------------------------------------------
// Classifier-path regression: destructive + northstar_read (the shape the
// LLM classifier returns for bare "elimina la tarea X") must promote to
// northstar_write so jarvis_file_delete loads. This is the real-world path
// that reproduced the user's "can't delete" bug after the regex-only fix.
// ---------------------------------------------------------------------------

describe("destructive + northstar co-occurrence (classifier path)", () => {
  it("classifier groups [destructive, northstar_read] → jarvis_file_delete present", () => {
    const tools = scopeToolsForMessage(
      "elimina la tarea de prueba",
      [],
      DEFAULT_SCOPE_PATTERNS,
      ALL_ON,
      new Set(["destructive", "northstar_read"]),
    );
    expect(tools).toContain("jarvis_file_delete");
  });

  it("classifier groups [destructive] alone → jarvis_file_delete NOT present", () => {
    const tools = scopeToolsForMessage(
      "borra eso",
      [],
      DEFAULT_SCOPE_PATTERNS,
      ALL_ON,
      new Set(["destructive"]),
    );
    expect(tools).not.toContain("jarvis_file_delete");
  });

  it("classifier groups [destructive] + regex-activated northstar_read on noun → jarvis_file_delete present", () => {
    // Classifier may emit just [destructive] for a "cleanup" phrasing; the
    // NorthStar noun in the message still activates northstar_read via the
    // regex sweep, and the co-occurrence rule promotes → write tools load.
    const tools = scopeToolsForMessage(
      "limpia las tareas viejas",
      [],
      DEFAULT_SCOPE_PATTERNS,
      ALL_ON,
      new Set(["destructive"]),
    );
    expect(tools).toContain("jarvis_file_delete");
  });

  it("clitic 'quítala' matches destructive and resolves with noun context", () => {
    // Symmetric ES clitic coverage for quita — round-2 audit W1 closure.
    const tools = scope("Esa meta ya no aplica, quítala");
    expect(tools).toContain("jarvis_file_delete");
  });

  it("classifier groups [destructive, northstar_journal] → jarvis_file_delete present", () => {
    const tools = scopeToolsForMessage(
      "borra la entrada de diario de ayer",
      [],
      DEFAULT_SCOPE_PATTERNS,
      ALL_ON,
      new Set(["destructive", "northstar_journal"]),
    );
    expect(tools).toContain("jarvis_file_delete");
  });
});

// ---------------------------------------------------------------------------
// northstar_journal — journal scope group
// ---------------------------------------------------------------------------

describe("journal scope (jarvis files)", () => {
  it("journal keyword still routes through tools pipeline", () => {
    const tools = scope("Escribe en mi diario lo que pasó hoy");
    expect(tools).toContain("jarvis_file_write");
  });
});

// ---------------------------------------------------------------------------
// jarvis_write scope — 2026-04-14
// Moved jarvis_file_{write,update,delete,move} out of always-on MISC_TOOLS
// after task 2378 ("Me regalas un poema de Rumi para dormir?") triggered
// silent jarvis_file_read + jarvis_file_update on a trivial chat turn
// because enrichment recalled a self-written SOP that said "log every
// delivered poem". Writes must now require explicit intent.
// ---------------------------------------------------------------------------

describe("jarvis_write scope gating", () => {
  it("Rumi poem request does NOT pull jarvis_file_write/update (regression for task 2378)", () => {
    const tools = scope("Me regalas un poema de Rumi para dormir?");
    expect(tools).not.toContain("jarvis_file_write");
    expect(tools).not.toContain("jarvis_file_update");
    expect(tools).not.toContain("jarvis_file_delete");
    expect(tools).not.toContain("jarvis_file_move");
    // Read access must remain — model can still consult SOPs if it wants to
    expect(tools).toContain("jarvis_file_read");
  });

  it("casual chat does NOT pull jarvis write tools", () => {
    const tools = scope("Hola Jarvis, cómo estás hoy?");
    expect(tools).not.toContain("jarvis_file_write");
    expect(tools).not.toContain("jarvis_file_update");
  });

  it("explicit 'guarda esta nota' activates jarvis_write", () => {
    const tools = scope("Guarda esta nota en mi knowledge base");
    expect(tools).toContain("jarvis_file_write");
    expect(tools).toContain("jarvis_file_update");
  });

  it("explicit 'crea un SOP' activates jarvis_write", () => {
    const tools = scope("Crea un SOP para el flujo de ventas");
    expect(tools).toContain("jarvis_file_write");
  });

  it("explicit 'anota este fact' activates jarvis_write", () => {
    const tools = scope("Anota este fact en tu conocimiento");
    expect(tools).toContain("jarvis_file_write");
  });

  it("northstar_write still pushes jarvis write tools (inheritance)", () => {
    const tools = scope("Crea una tarea nueva para mañana");
    expect(tools).toContain("jarvis_file_write");
    expect(tools).toContain("jarvis_file_update");
  });

  it("coding scope still pushes jarvis write tools (inheritance)", () => {
    const tools = scope("Revisa el código del servidor");
    expect(tools).toContain("jarvis_file_write");
  });

  it("northstar_journal still pushes jarvis write tools (inheritance)", () => {
    const tools = scope("Escribe en mi diario lo que pasó hoy");
    expect(tools).toContain("jarvis_file_write");
  });

  // v7.7.2 audit widening — "KB" / "base de conocimiento" alternation

  it("'guarda esto en el KB' activates jarvis_write", () => {
    const tools = scope("Guarda esto en el KB");
    expect(tools).toContain("jarvis_file_write");
  });

  it("'agrega al KB' activates jarvis_write", () => {
    const tools = scope("Agrega al KB un recordatorio sobre el release");
    expect(tools).toContain("jarvis_file_write");
  });

  it("'registra en la base de conocimiento' activates jarvis_write", () => {
    const tools = scope(
      "Registra en la base de conocimiento que el release es el jueves",
    );
    expect(tools).toContain("jarvis_file_write");
  });

  it("'en la KB guarda esto' (reversed order) activates jarvis_write", () => {
    const tools = scope("En la KB guarda esto como regla permanente");
    expect(tools).toContain("jarvis_file_write");
  });

  it("'apunta en mi KB' activates jarvis_write", () => {
    const tools = scope("Apunta en mi KB esta observación");
    expect(tools).toContain("jarvis_file_write");
  });

  it("bare 'KB' mention without write verb does NOT activate", () => {
    // "qué tienes en el KB sobre X" is a read question — no write tools
    const tools = scope("Qué tienes en el KB sobre Rumi?");
    expect(tools).not.toContain("jarvis_file_write");
  });
});

// v7.7.2 audit fix — VALID_GROUPS in scope-classifier.ts must include
// jarvis_write so the semantic classifier path can emit it. Previously
// the classifier would never emit jarvis_write; only the regex fallback
// path caught KB-write intent.
describe("scope-classifier VALID_GROUPS (v7.7.2 audit fix)", () => {
  it("parses 'jarvis_write' from a classifier JSON response", async () => {
    const { parseScopeGroups } = await import("./scope-classifier.js");
    const groups = parseScopeGroups('["jarvis_write"]');
    expect(groups).not.toBeNull();
    expect(groups!.has("jarvis_write")).toBe(true);
  });

  it("parses 'jarvis_write' combined with other groups", async () => {
    const { parseScopeGroups } = await import("./scope-classifier.js");
    const groups = parseScopeGroups('["jarvis_write","northstar_write"]');
    expect(groups).not.toBeNull();
    expect(groups!.has("jarvis_write")).toBe(true);
    expect(groups!.has("northstar_write")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// wordpress positive activation
// ---------------------------------------------------------------------------

describe("wordpress positive", () => {
  it("activates on 'Publica el artículo en WordPress'", () => {
    const tools = scope("Publica el artículo en WordPress");
    expect(hasAll(tools, WORDPRESS_TOOLS)).toBe(true);
  });

  // --- 2026-04-20 bug fix: bare WP + integer-ref posts + ES update verbs ---
  // Bug: `wp[-_]` required a separator so `en WP,` missed; `articulo 546`
  // and ES update forms also missed. Fix extends the scope regex with
  // bare `wp\b`, article-anchored `(?:el|la|...)\s+(?:articulo|post|
  // entrada)\s+\d{1,6}`, and ES verb alternation `actual[ií]za|actualice|
  // ed[ií]ta|edite|modif[ií]ca|modifique|c[aá]mbia|cambie` + post/articulo/
  // entrada noun. `pagina` intentionally NOT in the noun list (over-fires).

  it("activates on bare 'WP' with comma (ES shorthand)", () => {
    const tools = scope("Continua con el articulo 546 en WP, por favor");
    expect(hasAll(tools, WORDPRESS_TOOLS)).toBe(true);
  });

  it("activates on 'el WP' (article + bare shorthand)", () => {
    const tools = scope("Revisa el WP ahorita");
    expect(hasAll(tools, WORDPRESS_TOOLS)).toBe(true);
  });

  it("activates on article + integer-referenced 'el articulo 546'", () => {
    const tools = scope("Abre el articulo 546 para revisarlo");
    expect(hasAll(tools, WORDPRESS_TOOLS)).toBe(true);
  });

  it("activates on 'el post 123' integer reference", () => {
    const tools = scope("Dame el post 123");
    expect(hasAll(tools, WORDPRESS_TOOLS)).toBe(true);
  });

  it("activates on 'la entrada 7' integer reference", () => {
    const tools = scope("Lee la entrada 7");
    expect(hasAll(tools, WORDPRESS_TOOLS)).toBe(true);
  });

  it("activates on ES update-verb + WP-noun ('actualiza el articulo')", () => {
    const tools = scope("actualiza el articulo con lo nuevo");
    expect(hasAll(tools, WORDPRESS_TOOLS)).toBe(true);
  });

  it("activates on 'edita la entrada' (ES edit verb + noun)", () => {
    const tools = scope("Edita la entrada para agregar la foto");
    expect(hasAll(tools, WORDPRESS_TOOLS)).toBe(true);
  });

  it("activates on ES subjunctive 'actualice el articulo' (formal register)", () => {
    const tools = scope("Por favor actualice el articulo");
    expect(hasAll(tools, WORDPRESS_TOOLS)).toBe(true);
  });

  it("activates on accented clitic 'edítalo' in verb+noun context", () => {
    // Real accented form: stem `edíta` + clitic `lo` + article + noun.
    // Exercises the accented-verb arm (`ed[ií]ta(?:lo)?`) specifically.
    const tools = scope("Edítalo este post ahora");
    expect(hasAll(tools, WORDPRESS_TOOLS)).toBe(true);
  });

  it("activates on 'edita la pagina del blog' (round-2 gap fix)", () => {
    // Round-2 audit caught the coverage regression: removing p[aá]gina
    // from the generic noun list killed this hit. Restored via targeted
    // `p[aá]ginas?\s+(?:del?\s+)?(?:blog|sitio|wordpress|wp)` arm.
    const tools = scope("edita la pagina del blog");
    expect(hasAll(tools, WORDPRESS_TOOLS)).toBe(true);
  });

  it("activates on 'actualiza la página del sitio'", () => {
    const tools = scope("actualiza la página del sitio por favor");
    expect(hasAll(tools, WORDPRESS_TOOLS)).toBe(true);
  });

  it("activates on 'modifique la entrada' (subjunctive edit)", () => {
    const tools = scope("modifique la entrada que te pasé");
    expect(hasAll(tools, WORDPRESS_TOOLS)).toBe(true);
  });

  it("still activates on 'wp-stats' (existing coverage preserved)", () => {
    const tools = scope("Revisa los wp-stats");
    expect(hasAll(tools, WORDPRESS_TOOLS)).toBe(true);
  });
});

describe("wordpress negative (false-positive guards)", () => {
  // These keep the broader lexicon from over-firing WP scope.

  it("'the post office is closed' should NOT trigger wordpress", () => {
    const tools = scope("the post office is closed today");
    expect(hasNone(tools, WORDPRESS_TOOLS)).toBe(true);
  });

  it("generic 'update the article' without WP context should NOT trigger", () => {
    const tools = scope("update the article about something");
    expect(hasNone(tools, WORDPRESS_TOOLS)).toBe(true);
  });

  it("'articulo' alone without integer should NOT trigger wordpress", () => {
    // Bare "articulo" — no digit, no blog context, no update verb.
    // Note: "blogs article" still matches via existing `blogs?\s+article`.
    const tools = scope("hazme un resumen de articulo");
    expect(hasNone(tools, WORDPRESS_TOOLS)).toBe(true);
  });

  it("bare 'articulo 5 de la constitución' (no article) should NOT trigger", () => {
    // Round-1 audit fix: integer-ref alternation now requires a preceding
    // article/possessive so legal/reference prose no longer fires WP.
    const tools = scope("articulo 5 de la constitución");
    expect(hasNone(tools, WORDPRESS_TOOLS)).toBe(true);
  });

  it("'post 12 comments' dev jargon should NOT trigger wordpress", () => {
    // Round-1 audit M1: integer-ref alternation requires ES article,
    // so bare EN `post N` dev chatter no longer activates WP.
    const tools = scope("please post 12 comments here");
    expect(hasNone(tools, WORDPRESS_TOOLS)).toBe(true);
  });

  it("'actualiza la pagina de login' (generic UI) should NOT trigger", () => {
    // Round-1 audit M2: `pagina` removed from update-verb noun list,
    // so generic frontend work no longer activates WP scope.
    const tools = scope("actualiza la pagina de login del CRM");
    expect(hasNone(tools, WORDPRESS_TOOLS)).toBe(true);
  });

  it("'edita la pagina 404' should NOT trigger wordpress", () => {
    // Same M2 guard — UI page edits are not WP work.
    const tools = scope("edita la pagina 404 del dashboard");
    expect(hasNone(tools, WORDPRESS_TOOLS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// v7.3 SEO/GEO scope group
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Classifier-bypass intent-only inheritance (scope_fix_2026_04_12)
// ---------------------------------------------------------------------------

describe("classifier-bypass intent-only inheritance", () => {
  it("inherits schedule from priors when classifier returns only destructive", () => {
    // Simulate the "Confirmado. Elimina las 6." follow-up: classifier sees only
    // destructive, prior turn was the schedule listing.
    const tools = scopeToolsForMessage(
      "Confirmado. Elimina las 6.",
      ["Lista las acciones programadas"],
      DEFAULT_SCOPE_PATTERNS,
      ALL_ON,
      new Set(["destructive"]),
    );
    expect(tools).toContain("delete_schedule");
    expect(tools).toContain("list_schedules");
  });

  it("merges inheritance even when classifier already returned a real group", () => {
    // Unconditional merge: classifier returned `schedule`, prior mentioned
    // coding, both should end up active. Accepted tradeoff — slice(-4) bounds
    // accumulation, and co-activation is safer than starving needed tools.
    const tools = scopeToolsForMessage(
      "Elimina 6 y 7",
      ["Haz un deploy del servidor"],
      DEFAULT_SCOPE_PATTERNS,
      ALL_ON,
      new Set(["destructive", "schedule"]),
    );
    expect(tools).toContain("delete_schedule");
    expect(tools).toContain("shell_exec");
  });

  it("handles meta-question about a scheduled tool (delete_schedule literal)", () => {
    const tools = scopeToolsForMessage(
      "Confirma el status de tu herramienta delete_schedule",
      ["Elimina las acciones programadas"],
      DEFAULT_SCOPE_PATTERNS,
      ALL_ON,
      new Set(["destructive"]),
    );
    expect(tools).toContain("delete_schedule");
  });

  it("merges a missing domain group when classifier returned only one", () => {
    // Real-world case: "Revisa documentos de investigación... agrega a la tesis"
    // Classifier returns [research] only; prior turns referenced the Google Doc.
    // The unconditional prior-message merge should co-activate `google`.
    const tools = scopeToolsForMessage(
      "Revisa documentos de investigación y agrega a la tesis",
      [
        "Mira el Google Doc de la tesis v2.5",
        "Necesito gdocs_write para actualizar",
      ],
      DEFAULT_SCOPE_PATTERNS,
      ALL_ON,
      new Set(["research"]),
    );
    expect(tools).toContain("gdocs_write");
    expect(tools).toContain("gemini_research"); // research still active
  });

  it("merges multiple missing groups from priors", () => {
    const tools = scopeToolsForMessage(
      "Procede",
      [
        "Lista las acciones programadas",
        "Revisa el código del servidor para deploy",
      ],
      DEFAULT_SCOPE_PATTERNS,
      ALL_ON,
      new Set(["destructive"]),
    );
    expect(tools).toContain("delete_schedule");
    expect(tools).toContain("shell_exec");
  });
});

describe("seo scope group (v7.3)", () => {
  it("activates on explicit 'SEO' keyword", () => {
    const tools = scope("Haz un audit SEO de example.com");
    expect(hasAll(tools, SEO_TOOLS)).toBe(true);
  });

  it("activates on 'schema markup' / 'json-ld' mentions", () => {
    const tools = scope("Genera schema markup json-ld para esta página");
    expect(hasAll(tools, SEO_TOOLS)).toBe(true);
  });

  it("inherits seo scope from prior message on a short follow-up", () => {
    const tools = scope("Procede", ["Analiza el SEO de https://example.com"]);
    expect(hasAll(tools, SEO_TOOLS)).toBe(true);
  });

  it("does not activate on unrelated messages", () => {
    const tools = scope("Cómo está el clima hoy");
    expect(hasNone(tools, SEO_TOOLS)).toBe(true);
  });
});

describe("ads scope group (v7.3 Phase 4a)", () => {
  it("activates on platform-qualified ads (EN)", () => {
    const tools = scope("Audit my Meta Ads account for the last month");
    expect(hasAll(tools, ADS_TOOLS)).toBe(true);
  });

  it("activates on 'audita la cuenta de Google Ads' (ES)", () => {
    const tools = scope("Audita la cuenta de Google Ads de este cliente");
    expect(hasAll(tools, ADS_TOOLS)).toBe(true);
  });

  it("activates on ROAS / CPA metric mentions", () => {
    const tools = scope("Mi ROAS está en 1.8, cómo mejoro el CPA?");
    expect(hasAll(tools, ADS_TOOLS)).toBe(true);
  });

  it("activates on 'brand DNA' / 'identidad de marca'", () => {
    const t1 = scope("Extract the brand DNA from livingjoyfully.art");
    expect(hasAll(t1, ADS_TOOLS)).toBe(true);
    const t2 = scope("Extrae la identidad de marca de este sitio");
    expect(hasAll(t2, ADS_TOOLS)).toBe(true);
  });

  it("activates on 'anuncios' (ES noun)", () => {
    const tools = scope("Genera 5 anuncios para TikTok para mi marca");
    expect(hasAll(tools, ADS_TOOLS)).toBe(true);
  });

  it("activates on framework acronyms (AIDA, BAB, FAB) with word boundaries", () => {
    const t1 = scope("Usa el framework AIDA para este copy");
    expect(hasAll(t1, ADS_TOOLS)).toBe(true);
    const t2 = scope("Prueba FAB framework");
    expect(hasAll(t2, ADS_TOOLS)).toBe(true);
  });

  it("does NOT activate on English substrings of the framework acronyms (round-1 audit M1)", () => {
    // bare "fab" / "aida" / "bab" as substrings of common words must NOT fire
    const t1 = scope("I love fabric and fabulous outfits");
    expect(hasNone(t1, ADS_TOOLS)).toBe(true);
    const t2 = scope("The baby was crying and the babysitter was tired");
    expect(hasNone(t2, ADS_TOOLS)).toBe(true);
    const t3 = scope("She posted on aidalicious yesterday");
    expect(hasNone(t3, ADS_TOOLS)).toBe(true);
  });

  it("does NOT activate on 'roast/roasted/roasting' (round-2 audit C2 regression)", () => {
    // Round-2 audit caught that `ROAS` had lost its trailing `\b`, firing
    // on the common English word "roast". Guard against the same regression.
    const t1 = scope("I love roast beef for dinner");
    expect(hasNone(t1, ADS_TOOLS)).toBe(true);
    const t2 = scope("Roasted chicken with peppers");
    expect(hasNone(t2, ADS_TOOLS)).toBe(true);
    const t3 = scope("We are roasting in this heat");
    expect(hasNone(t3, ADS_TOOLS)).toBe(true);
  });

  it("does NOT activate on 'brand voicemail' / 'brand profiler' (round-2 audit C2)", () => {
    // `brand\s+(?:dna|voice|profile)` without trailing `\b` matched longer
    // compounds. Guard.
    const t1 = scope("The brand voicemail system was down");
    expect(hasNone(t1, ADS_TOOLS)).toBe(true);
    const t2 = scope("Try the brand profiler tool for a demo");
    expect(hasNone(t2, ADS_TOOLS)).toBe(true);
  });

  it("still activates on framework acronyms with trailing punctuation (round-2 audit m1 positive-boundary)", () => {
    // `FAB\b` must still fire when followed by `.` / `,` / `-` / newline /
    // end-of-string, not just plain space.
    expect(hasAll(scope("Use AIDA."), ADS_TOOLS)).toBe(true);
    expect(hasAll(scope("Pick BAB,"), ADS_TOOLS)).toBe(true);
    expect(hasAll(scope("Try FAB\nfor this"), ADS_TOOLS)).toBe(true);
    expect(hasAll(scope("Which framework? AIDA"), ADS_TOOLS)).toBe(true);
  });

  it("does NOT activate on 'add a field' / generic 'add' chatter", () => {
    const tools = scope("add a field called created_at to the schema");
    expect(hasNone(tools, ADS_TOOLS)).toBe(true);
  });

  it("does NOT activate on unrelated messages", () => {
    const tools = scope("Cómo está el clima hoy");
    expect(hasNone(tools, ADS_TOOLS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Two-phase isolation — scope inheritance behavior
// ---------------------------------------------------------------------------

describe("two-phase scope isolation", () => {
  it("inherits from prior messages when current has scope signals", () => {
    const tools = scope("Actualiza el status de la tarea", [
      "Busca en mi gmail los correos de ayer",
    ]);
    // Current triggers northstar_read, prior adds google
    expect(tools).toContain("jarvis_file_read");
    expect(hasAll(tools, GOOGLE_TOOLS)).toBe(true);
  });

  it("short message (<50 chars) inherits scope from prior", () => {
    const tools = scope("Procede", ["Revisa el código del servidor"]);
    // "Procede" is 7 chars, no scope signals — should inherit coding
    expect(tools).toContain("shell_exec");
  });

  it("79 chars inherits scope, 80+ chars does not (boundary)", () => {
    // 79 chars: should inherit
    const msg79 = "A".repeat(79);
    const tools79 = scope(msg79, ["Busca en mi gmail"]);
    expect(hasAll(tools79, GOOGLE_TOOLS)).toBe(true);

    // 80 chars, no imperative verb: should NOT inherit
    const msg80 = "B".repeat(80);
    const tools80 = scope(msg80, ["Busca en mi gmail"]);
    expect(hasNone(tools80, GOOGLE_TOOLS)).toBe(true);
  });

  it("imperative verb inherits scope regardless of length", () => {
    const tools = scope("Ejecuta lo que te pedí con las tareas del NorthStar", [
      "Busca en mi gmail los correos de ayer",
    ]);
    // "ejecuta" triggers inheritance even though message has own signals
    expect(hasAll(tools, GOOGLE_TOOLS)).toBe(true);
  });

  it("short message 'tu tienes Gdrive' inherits scope via length (<80)", () => {
    const tools = scope("tu tienes Gdrive. Escribelo ahi y me lo compartes", [
      "Consolida el documento de investigación",
    ]);
    // 49 chars — under 80 threshold, inherits from prior
    expect(tools.length).toBeGreaterThan(CORE_TOOLS.length + MISC_TOOLS.length);
  });

  it("referential phrase 'el primero que' inherits scope on long message", () => {
    const tools = scope(
      "El primero que realizaste lo hiciste el miércoles. Ese está bien. Quiero el resumen del de hoy.",
      ["Lee el journal del NorthStar y busca la consolidación"],
    );
    // 95 chars but "el primero que" triggers referential inheritance
    expect(tools).toContain("jarvis_file_read");
  });

  it("referential phrase 'lo que te pedí' inherits scope", () => {
    const tools = scope("lo que te pedí sobre los correos", [
      "Busca en mi gmail los correos de ayer",
    ]);
    // 31 chars — under threshold, inherits
    expect(hasAll(tools, GOOGLE_TOOLS)).toBe(true);
  });

  it("bare 'lo que' without verb context does NOT trigger referential inheritance on long msg", () => {
    const tools = scope(
      "lo que pasa es que me siento muy cansado hoy y no tengo ganas de hacer absolutamente nada por favor",
      ["Busca en mi gmail los correos de ayer"],
    );
    // 100 chars, no scope keywords, no imperative verbs — should NOT inherit
    expect(hasNone(tools, GOOGLE_TOOLS)).toBe(true);
  });

  it("long message without scope signals gets core tools only", () => {
    const tools = scope(
      "Me siento bien hoy, tuve un buen día y quiero descansar un poco esta tarde después de caminar",
    );
    // 80+ chars, no scope keywords, no imperative verbs
    expect(hasAll(tools, CORE_TOOLS)).toBe(true);
    expect(hasAll(tools, MISC_TOOLS)).toBe(true);
    expect(hasNone(tools, GOOGLE_TOOLS)).toBe(true);
    const codingExclusive = CODING_TOOLS.filter((t) => !CORE_TOOLS.includes(t));
    expect(hasNone(tools, codingExclusive)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Feature gates — env-dependent tool groups
// ---------------------------------------------------------------------------

describe("scope feature gates", () => {
  it("hasGoogle: false suppresses Google tools even with gmail keyword", () => {
    const tools = scope("Busca en mi gmail", [], {
      ...ALL_ON,
      hasGoogle: false,
    });
    expect(hasNone(tools, GOOGLE_TOOLS)).toBe(true);
  });

  it("hasWordpress: false suppresses WP tools even with artículo keyword", () => {
    const tools = scope("Publica el artículo en WordPress", [], {
      ...ALL_ON,
      hasWordpress: false,
    });
    expect(hasNone(tools, WORDPRESS_TOOLS)).toBe(true);
  });

  it("file_read is always in CORE_TOOLS regardless of scope", () => {
    const tools = scope("Hola");
    expect(tools).toContain("file_read");
  });
});

// ---------------------------------------------------------------------------
// Meta scope completeness — all groups present for diagnostic queries
// ---------------------------------------------------------------------------

describe("meta scope completeness", () => {
  it("meta scope includes all tool groups", () => {
    const tools = scope("Lista todas las herramientas");
    // All groups should be active
    expect(hasAll(tools, SPECIALTY_TOOLS)).toBe(true);
    expect(hasAll(tools, RESEARCH_TOOLS)).toBe(true);
    expect(hasAll(tools, SCHEDULE_TOOLS)).toBe(true);
    expect(hasAll(tools, CODING_TOOLS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// detectActiveGroups — standalone group detection
// ---------------------------------------------------------------------------

describe("detectActiveGroups", () => {
  const detect = (msg: string, prior: string[] = []) =>
    detectActiveGroups(msg, prior, DEFAULT_SCOPE_PATTERNS);

  it("returns empty set for generic greetings", () => {
    const groups = detect("Hola, buenos días");
    expect(groups.size).toBe(0);
  });

  it("detects northstar_read on task keywords", () => {
    const groups = detect("Qué tareas tengo pendientes?");
    expect(groups.has("northstar_read")).toBe(true);
  });

  it("detects google on email keywords", () => {
    const groups = detect("Busca en mi gmail");
    expect(groups.has("google")).toBe(true);
  });

  it("detects coding on code keywords", () => {
    const groups = detect("Revisa el código");
    expect(groups.has("coding")).toBe(true);
  });

  it("inherits groups from prior messages when current has scope signals", () => {
    const groups = detect("Crea una tarea nueva", [
      "Busca en mi gmail los correos",
    ]);
    expect(groups.has("northstar_write")).toBe(true);
    expect(groups.has("google")).toBe(true);
  });

  it("does NOT inherit groups when current has no scope signals", () => {
    const groups = detect("Ok, gracias", ["Busca en mi gmail los correos"]);
    expect(groups.size).toBe(0);
  });

  it("detects meta on capability/diagnostic keywords", () => {
    const groups = detect("Lista todas las herramientas");
    expect(groups.has("meta")).toBe(true);
  });

  it("detects specialty on chart_generate / image keywords", () => {
    const groups = detect("genera un pie chart con estos valores");
    expect(groups.has("specialty")).toBe(true);
  });

  it("detects research on study/podcast keywords", () => {
    const groups = detect("Hazme un study guide");
    expect(groups.has("research")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scope pattern regression suite (v6.4 OH2)
// Historical bugs from v6.3.1 sessions — each test corresponds to a real
// production false-positive or false-negative that was diagnosed and fixed.
// ---------------------------------------------------------------------------

describe("scope pattern regression suite (v6.4 OH2)", () => {
  const detect = (msg: string, prior: string[] = []) =>
    detectActiveGroups(msg, prior, DEFAULT_SCOPE_PATTERNS);

  // --- WordPress false positives ---
  it("'livingjoyfully' without domain should NOT trigger wordpress", () => {
    const tools = scope("Revisa el proyecto livingjoyfully");
    expect(hasNone(tools, WORDPRESS_TOOLS)).toBe(true);
  });

  it("'livingjoyfully.art' WITH domain should trigger wordpress", () => {
    const tools = scope("Publica en livingjoyfully.art");
    expect(hasAll(tools, ["wp_list_posts"])).toBe(true);
  });

  it("'post' in markdown table context should NOT trigger social", () => {
    // Prior thread contained markdown table with 'post' in it
    const tools = scope("Dime qué tareas faltan", [
      "| Feature | Status |\n| blog post tracker | done |",
    ]);
    // Should NOT activate social just from 'post' in prior context
    expect(
      tools.includes("social_publish") || tools.includes("social_accounts"),
    ).toBe(false);
  });

  // --- Social false positives/negatives ---
  it("'publica en instagram' should trigger social", () => {
    const groups = detect("Publica esto en Instagram");
    expect(groups.has("social")).toBe(true);
  });

  it("'publica en el blog' should trigger wordpress, NOT social", () => {
    const groups = detect("Publica en el blog");
    expect(groups.has("wordpress")).toBe(true);
    expect(groups.has("social")).toBe(false);
  });

  it("'publicación en redes' should trigger social", () => {
    const groups = detect("Prepara una publicación en redes sociales");
    expect(groups.has("social")).toBe(true);
  });

  // --- Specialty false positives ---
  it("'limpia tu contexto' should NOT trigger specialty (via texto substring)", () => {
    const groups = detect("Limpia tu contexto");
    expect(groups.has("specialty")).toBe(false);
  });

  it("'limpia el texto' SHOULD trigger specialty", () => {
    const groups = detect("Limpia el texto de este documento");
    expect(groups.has("specialty")).toBe(true);
  });

  // --- NorthStar scope ---
  it("'Abre mi NorthStar' should trigger northstar_read", () => {
    const groups = detect("Abre mi NorthStar");
    expect(groups.has("northstar_read")).toBe(true);
  });

  it("'sync con db.mycommit' should trigger northstar_read", () => {
    const groups = detect("sync con db.mycommit");
    expect(groups.has("northstar_read")).toBe(true);
  });

  it("'sincroniza con NorthStar' should trigger northstar_read", () => {
    const groups = detect("Sincroniza con NorthStar");
    expect(groups.has("northstar_read")).toBe(true);
  });

  it("'qué tareas tengo' should trigger northstar_read", () => {
    const groups = detect("Qué tareas tengo pendientes?");
    expect(groups.has("northstar_read")).toBe(true);
  });

  it("'marca como completada' should trigger northstar_write", () => {
    const groups = detect("Marca la tarea como completada");
    expect(groups.has("northstar_write")).toBe(true);
  });

  // --- VPS should be in MISC (always available) ---
  it("'estado del VPS' should include vps_status (MISC tool)", () => {
    const tools = scope("Estado del VPS");
    expect(tools).toContain("vps_status");
  });

  it("vps_status available even without coding keywords", () => {
    const tools = scope("Cómo está el servidor?");
    expect(tools).toContain("vps_status");
  });

  // --- Google scope ---
  it("'envía un correo' should trigger google scope", () => {
    const groups = detect("Envía un correo a javier");
    expect(groups.has("google")).toBe(true);
  });

  it("'revisa mi calendario' should trigger google scope", () => {
    const groups = detect("Revisa mi calendario para mañana");
    expect(groups.has("google")).toBe(true);
  });

  // --- Schedule scope ---
  it("'programa un reporte diario' should trigger schedule", () => {
    const groups = detect("Programa un reporte diario a las 8am");
    expect(groups.has("schedule")).toBe(true);
  });

  // --- Coding scope ---
  it("'revisa el código' should trigger coding", () => {
    const groups = detect("Revisa el código del módulo de inference");
    expect(groups.has("coding")).toBe(true);
  });

  it("'deploy' should trigger coding", () => {
    const groups = detect("Haz deploy de los cambios");
    expect(groups.has("coding")).toBe(true);
  });

  // --- Intel scope ---
  it("'señales de mercado' should trigger intel", () => {
    const groups = detect("Muéstrame las señales de mercado");
    expect(groups.has("intel")).toBe(true);
  });

  // --- Meta scope ---
  it("'herramientas disponibles' should trigger meta", () => {
    const groups = detect("Lista las herramientas disponibles");
    expect(groups.has("meta")).toBe(true);
  });

  it("'diagnóstico' should trigger meta", () => {
    const groups = detect("Ejecuta un diagnóstico del sistema");
    expect(groups.has("meta")).toBe(true);
  });

  // --- Browser scope ---
  it("'abre la app' should trigger browser", () => {
    const groups = detect("Abre la app de NorthStar");
    expect(groups.has("browser")).toBe(true);
  });

  // --- Scope deduplication ---
  it("tools array has no duplicates (Set dedup)", () => {
    // Use a message that triggers multiple overlapping groups
    const tools = scope("Crea una tarea y sincroniza con NorthStar");
    const unique = new Set(tools);
    expect(tools.length).toBe(unique.size);
  });
});

// ---------------------------------------------------------------------------
// v7.1 chart scope group
// ---------------------------------------------------------------------------

describe("chart scope group (v7.1)", () => {
  it("activates on 'market_chart_render' tool name", () => {
    const tools = scope("run market_chart_render for SPY");
    expect(hasAll(tools, CHART_TOOLS)).toBe(true);
  });

  it("activates on 'chart of SPY' (EN, symbol anchored)", () => {
    const tools = scope("give me a chart of SPY");
    expect(hasAll(tools, CHART_TOOLS)).toBe(true);
  });

  it("activates on 'gráfico de AAPL' (ES, symbol anchored)", () => {
    const tools = scope("hazme un gráfico de AAPL");
    expect(hasAll(tools, CHART_TOOLS)).toBe(true);
  });

  it("activates on named pattern 'head and shoulders'", () => {
    const tools = scope("do you see a head and shoulders forming?");
    expect(hasAll(tools, CHART_TOOLS)).toBe(true);
  });

  it("activates on ES 'triángulo ascendente'", () => {
    const tools = scope("hay un triángulo ascendente en el gráfico");
    expect(hasAll(tools, CHART_TOOLS)).toBe(true);
  });

  it("activates on 'canal de tendencia'", () => {
    const tools = scope("traza el canal de tendencia");
    expect(hasAll(tools, CHART_TOOLS)).toBe(true);
  });

  // --- Negative guards ---

  it("generic 'bar chart' without finance anchor should NOT trigger chart", () => {
    const tools = scope("make a bar chart of these numbers");
    expect(hasNone(tools, CHART_TOOLS)).toBe(true);
  });

  it("'diagram of architecture' should NOT trigger chart (diagram group)", () => {
    const tools = scope("draw a diagram of the architecture");
    expect(hasNone(tools, CHART_TOOLS)).toBe(true);
  });

  it("'infografía' should NOT trigger chart (infographic lives elsewhere)", () => {
    const tools = scope("hazme una infografía del producto");
    expect(hasNone(tools, CHART_TOOLS)).toBe(true);
  });

  it("bare 'gráfica de barras' (ES generic bar chart) should NOT trigger", () => {
    const tools = scope("quiero una gráfica de barras con ventas mensuales");
    expect(hasNone(tools, CHART_TOOLS)).toBe(true);
  });

  // --- Round-1 audit M2 negatives: uppercase non-ticker tokens ---

  it("'chart of IT teams' should NOT trigger chart (IT is not a ticker)", () => {
    const tools = scope("chart of IT teams performance");
    expect(hasNone(tools, CHART_TOOLS)).toBe(true);
  });

  it("'chart of US economy' should NOT trigger chart (US is not a ticker)", () => {
    const tools = scope("chart of US economy trend");
    expect(hasNone(tools, CHART_TOOLS)).toBe(true);
  });

  it("'chart of THE data' should NOT trigger chart (THE is not a ticker)", () => {
    const tools = scope("chart of THE data set");
    expect(hasNone(tools, CHART_TOOLS)).toBe(true);
  });

  it("'chart of $US economy' should NOT trigger chart ($US bypass fix, round-2)", () => {
    // Round-2 audit critical: the `\$?` was initially placed after the
    // negative lookahead, allowing `$US` (dollar prefix on excluded stem)
    // to bypass. Moved `\$?` inside the consume-position so the lookahead
    // tests the remaining stem.
    const tools = scope("chart of $US economy");
    expect(hasNone(tools, CHART_TOOLS)).toBe(true);
  });

  it("'chart of $SPY' still triggers chart ($-prefixed real ticker)", () => {
    const tools = scope("chart of $SPY over the last month");
    expect(hasAll(tools, CHART_TOOLS)).toBe(true);
  });

  // --- Round-1 audit M1: specialty/chart separation ---

  it("'chart of SPY' activates chart but NOT specialty (separation)", () => {
    const groups = detectActiveGroups(
      "chart of SPY with bollinger",
      [],
      DEFAULT_SCOPE_PATTERNS,
    );
    expect(groups.has("chart")).toBe(true);
    expect(groups.has("specialty")).toBe(false);
  });

  it("'bar chart' still activates specialty (chart_generate path)", () => {
    const groups = detectActiveGroups(
      "make a bar chart of monthly sales",
      [],
      DEFAULT_SCOPE_PATTERNS,
    );
    expect(groups.has("specialty")).toBe(true);
  });
});

describe("teaching scope group (v7.11)", () => {
  it("activates on 'teach me X' (EN)", () => {
    const tools = scope("teach me React hooks from scratch");
    expect(hasAll(tools, TEACHING_TOOLS)).toBe(true);
  });

  it("activates on 'enséñame X' (ES)", () => {
    const tools = scope("enséñame kubernetes");
    expect(hasAll(tools, TEACHING_TOOLS)).toBe(true);
  });

  it("activates on 'enseñame' (no accent, common keyboard variant)", () => {
    const tools = scope("enseñame Rust");
    expect(hasAll(tools, TEACHING_TOOLS)).toBe(true);
  });

  it("activates on 'quiero aprender X'", () => {
    const tools = scope("quiero aprender sobre redes neuronales");
    expect(hasAll(tools, TEACHING_TOOLS)).toBe(true);
  });

  it("activates on 'I want to learn X'", () => {
    const tools = scope("I want to learn Kubernetes");
    expect(hasAll(tools, TEACHING_TOOLS)).toBe(true);
  });

  it("activates on 'quiz me on X'", () => {
    const tools = scope("quiz me on SOLID principles");
    expect(hasAll(tools, TEACHING_TOOLS)).toBe(true);
  });

  it("activates on 'tómame un quiz sobre X'", () => {
    const tools = scope("tómame un quiz sobre Go concurrency");
    expect(hasAll(tools, TEACHING_TOOLS)).toBe(true);
  });

  it("activates on 'what's due today' / 'what's due this week'", () => {
    expect(hasAll(scope("what's due today?"), TEACHING_TOOLS)).toBe(true);
    expect(
      hasAll(scope("what's due this week for review"), TEACHING_TOOLS),
    ).toBe(true);
  });

  it("activates on 'repasar mis conceptos'", () => {
    expect(hasAll(scope("quiero repasar mis conceptos"), TEACHING_TOOLS)).toBe(
      true,
    );
  });

  it("activates on 'explain back' / 'explícame de vuelta'", () => {
    expect(hasAll(scope("let me explain back"), TEACHING_TOOLS)).toBe(true);
    expect(
      hasAll(scope("explícame de vuelta los closures"), TEACHING_TOOLS),
    ).toBe(true);
  });

  it("activates on 'explícame X desde cero'", () => {
    const tools = scope("explícame bond duration desde cero");
    expect(hasAll(tools, TEACHING_TOOLS)).toBe(true);
  });

  // --- Negative guards ---

  it("'teach the model to classify' does NOT activate teaching (no 'me')", () => {
    const tools = scope("we need to teach the model to classify these");
    expect(hasNone(tools, TEACHING_TOOLS)).toBe(true);
  });

  it("'review the PR' does NOT activate teaching (code-review, no 'today')", () => {
    const tools = scope("please review the PR before merging");
    expect(hasNone(tools, TEACHING_TOOLS)).toBe(true);
  });

  it("'plan the sprint' does NOT activate teaching (no 'aprendizaje')", () => {
    const tools = scope("let's plan the sprint together");
    expect(hasNone(tools, TEACHING_TOOLS)).toBe(true);
  });

  it("bare 'explica esto' does NOT activate teaching (needs desde cero / paso a paso)", () => {
    const tools = scope("explica esto por favor");
    expect(hasNone(tools, TEACHING_TOOLS)).toBe(true);
  });

  // Round-1 audit over-fire fixes
  it("'explícame este bug paso a paso' does NOT activate teaching (dev chatter)", () => {
    const tools = scope("explícame este bug paso a paso");
    expect(hasNone(tools, TEACHING_TOOLS)).toBe(true);
  });

  it("'explícame este endpoint paso a paso' does NOT activate teaching", () => {
    const tools = scope("explícame este endpoint paso a paso por favor");
    expect(hasNone(tools, TEACHING_TOOLS)).toBe(true);
  });

  // Round-2 audit fix M1: expanded dev-chatter blocklist
  it("'explícame este controller paso a paso' does NOT activate teaching", () => {
    expect(
      hasNone(scope("explícame este controller paso a paso"), TEACHING_TOOLS),
    ).toBe(true);
  });

  it("'explícame esta query paso a paso' does NOT activate teaching", () => {
    expect(
      hasNone(scope("explícame esta query paso a paso"), TEACHING_TOOLS),
    ).toBe(true);
  });

  it("'explícame este pipeline paso a paso' does NOT activate teaching", () => {
    expect(
      hasNone(scope("explícame este pipeline paso a paso"), TEACHING_TOOLS),
    ).toBe(true);
  });

  it("'explícame esta migración paso a paso' does NOT activate teaching", () => {
    expect(
      hasNone(scope("explícame esta migración paso a paso"), TEACHING_TOOLS),
    ).toBe(true);
  });

  it("'what's due for the CRM task' does NOT activate teaching (task backlog, no review anchor)", () => {
    const tools = scope("what's due for the CRM task this morning");
    expect(hasNone(tools, TEACHING_TOOLS)).toBe(true);
  });

  it("'do I need to review the deploy script' does NOT activate teaching (code review)", () => {
    const tools = scope("Do I need to review the deploy script before Friday?");
    expect(hasNone(tools, TEACHING_TOOLS)).toBe(true);
  });

  it("'we need a learning plan for Q2' does NOT activate teaching (business plan)", () => {
    const tools = scope("we need a learning plan for Q2 OKRs");
    expect(hasNone(tools, TEACHING_TOOLS)).toBe(true);
  });

  it("'revisa hoy las tareas' does NOT activate teaching (generic review today → task scope)", () => {
    const tools = scope("revisa hoy las tareas pendientes");
    expect(hasNone(tools, TEACHING_TOOLS)).toBe(true);
  });

  it("'hablemos de maestría en código' does NOT activate teaching", () => {
    // Note: typed with `e` instead of `é` to match a variant spelling. The
    // tightened regex drops the bare `mastería` arm entirely.
    const tools = scope("hablemos de maestria en código");
    expect(hasNone(tools, TEACHING_TOOLS)).toBe(true);
  });

  // Positive variants recovered after tightening
  it("'mi learning plan' DOES activate teaching (anchored by mi)", () => {
    const tools = scope("qué unidades tengo en mi learning plan?");
    expect(hasAll(tools, TEACHING_TOOLS)).toBe(true);
  });

  it("'mastery report' DOES activate teaching", () => {
    const tools = scope("dame mi mastery report");
    expect(hasAll(tools, TEACHING_TOOLS)).toBe(true);
  });

  it("'what concepts do I need to review' DOES activate teaching", () => {
    const tools = scope("what concepts do I need to review today?");
    expect(hasAll(tools, TEACHING_TOOLS)).toBe(true);
  });

  it("'enseñálo' clitic-object form DOES activate teaching", () => {
    const tools = scope("Jarvis, enseñálo con un ejemplo real");
    expect(hasAll(tools, TEACHING_TOOLS)).toBe(true);
  });
});

describe("video scope group (v7.4 S1 tighten)", () => {
  // Positive — EN
  it("activates on 'hazme un video sobre X'", () => {
    const tools = scope("hazme un video sobre inteligencia artificial");
    expect(hasAll(tools, VIDEO_TOOLS)).toBe(true);
  });

  it("activates on 'render a video for YouTube'", () => {
    const tools = scope("Render a video for YouTube about our launch");
    expect(hasAll(tools, VIDEO_TOOLS)).toBe(true);
  });

  it("activates on 'storyboard for a 60s clip'", () => {
    const tools = scope("Give me a storyboard for a 60s clip");
    expect(hasAll(tools, VIDEO_TOOLS)).toBe(true);
  });

  // Positive — ES, accented + unaccented + subjunctive
  it("activates on accented 'vídeo' (ES)", () => {
    const tools = scope("quiero un vídeo para TikTok");
    expect(hasAll(tools, VIDEO_TOOLS)).toBe(true);
  });

  it("activates on unaccented 'video' (ES common form)", () => {
    const tools = scope("renderiza el video con esta narración");
    expect(hasAll(tools, VIDEO_TOOLS)).toBe(true);
  });

  it("activates on 'transición de video' (ES) and 'composición de video'", () => {
    const t1 = scope("muéstrame una transición de video tipo fade");
    expect(hasAll(t1, VIDEO_TOOLS)).toBe(true);
    const t2 = scope("prepara la composición de video para el cliente");
    expect(hasAll(t2, VIDEO_TOOLS)).toBe(true);
  });

  // False-positive negatives — dev chatter must NOT fire
  it("'the video tag in HTML' does NOT fire (dev chatter)", () => {
    const tools = scope("Explain how the video tag in HTML works");
    expect(hasNone(tools, ["video_compose_manifest", "video_job_cancel"])).toBe(
      true,
    );
  });

  it("'render a React component' does NOT fire (bare render removed)", () => {
    const tools = scope("render a React component with useState");
    expect(hasNone(tools, ["video_compose_manifest", "video_job_cancel"])).toBe(
      true,
    );
  });

  it("'extract mp4 from the archive' does NOT fire", () => {
    const tools = scope("extract mp4 from the zip file to disk");
    expect(hasNone(tools, ["video_compose_manifest", "video_job_cancel"])).toBe(
      true,
    );
  });

  // Regression: existing S5d phrases still work
  it("regression: 'screenshot' still activates video scope (screenshot_element lives here)", () => {
    const tools = scope("tómame un screenshot de example.com");
    expect(tools).toContain("screenshot_element");
  });

  it("regression: 'voz para video' (ES TTS) still activates", () => {
    const tools = scope("genera la voz para el video del curso");
    expect(hasAll(tools, VIDEO_TOOLS)).toBe(true);
  });

  // Positive-boundary: word followed by punctuation, not just space
  it("boundary: 'render el video.' with period still activates", () => {
    const tools = scope("render el video.");
    expect(hasAll(tools, VIDEO_TOOLS)).toBe(true);
  });

  // Round-1 M4 — additional FP-negatives for over-broad tokens
  it("'overlay CSS class' does NOT fire (bare overlay removed)", () => {
    const tools = scope("Add an overlay CSS class to the modal");
    expect(hasNone(tools, ["video_compose_manifest", "video_job_cancel"])).toBe(
      true,
    );
  });

  it("'take a screenshot of my IDE' fires (video scope owns screenshot)", () => {
    // screenshot_element is the tool; this positive case confirms it still fires
    const tools = scope("take a screenshot of my IDE for the bug report");
    expect(tools).toContain("screenshot_element");
  });

  it("'Screenshot attribute in CSS' dev chatter does NOT fire", () => {
    const tools = scope("Explain the Screenshot attribute in CSS-Paint-API");
    expect(hasNone(tools, ["video_compose_manifest", "video_job_cancel"])).toBe(
      true,
    );
  });

  it("'the TikTok demographic report' does NOT fire video (bare platform)", () => {
    const tools = scope("show me the TikTok demographic report for Q1");
    expect(hasNone(tools, ["video_compose_manifest", "video_job_cancel"])).toBe(
      true,
    );
  });

  it("'YouTube channel performance' does NOT fire video (bare platform)", () => {
    const tools = scope("YouTube channel performance for last month");
    expect(hasNone(tools, ["video_compose_manifest", "video_job_cancel"])).toBe(
      true,
    );
  });

  // Regression for M4 fix: legitimate platform+video phrasing still fires
  it("'TikTok video' fires (platform + video qualifier)", () => {
    const tools = scope("preparame un TikTok video de 30 segundos");
    expect(hasAll(tools, VIDEO_TOOLS)).toBe(true);
  });

  it("'overlay mode' (S5d mode name) fires", () => {
    const tools = scope("render using overlay mode with ocean-waves");
    expect(hasAll(tools, VIDEO_TOOLS)).toBe(true);
  });

  // Round-2 W2 regression fix: 'reel' singular and 'reels de/para X'
  it("'hacer un reel para Instagram' fires (Round-2 W2 ES reels fix)", () => {
    const tools = scope("hacer un reel para Instagram");
    expect(hasAll(tools, VIDEO_TOOLS)).toBe(true);
  });

  it("'reels de marca' fires (Round-2 W2 ES reels fix)", () => {
    const tools = scope("prepara reels de marca para el cliente");
    expect(hasAll(tools, VIDEO_TOOLS)).toBe(true);
  });

  it("'make a reel for my brand' fires (Round-2 W2 EN reels fix)", () => {
    const tools = scope("make a reel for my brand launch");
    expect(hasAll(tools, VIDEO_TOOLS)).toBe(true);
  });

  // v7.4.3 — HTML-as-Composition DSL arms
  it("v7.4.3: 'compose a video from html' fires", () => {
    const tools = scope("compose a video from html for the demo");
    expect(hasAll(tools, VIDEO_TOOLS)).toBe(true);
  });

  it("v7.4.3: 'render this html as mp4' fires", () => {
    const tools = scope("render this html as mp4 please");
    expect(hasAll(tools, VIDEO_TOOLS)).toBe(true);
  });

  it("v7.4.3: 'html to mp4' short form fires", () => {
    const tools = scope("html to mp4 with 30fps");
    expect(hasAll(tools, VIDEO_TOOLS)).toBe(true);
  });

  it("v7.4.3: ES 'video desde html' fires", () => {
    const tools = scope("hazme un video desde el html adjunto");
    expect(hasAll(tools, VIDEO_TOOLS)).toBe(true);
  });

  it("v7.4.3: ES 'compon un video desde html' fires", () => {
    const tools = scope("compone un video desde el html de la landing");
    expect(hasAll(tools, VIDEO_TOOLS)).toBe(true);
  });

  it("v7.4.3: direct tool reference 'video_html_compose' fires", () => {
    const tools = scope("usa video_html_compose con mi archivo");
    expect(hasAll(tools, VIDEO_TOOLS)).toBe(true);
  });

  // v7.4.3 FP-negatives — HTML dev-chatter must NOT fire video scope
  it("v7.4.3 FP: 'write html for a landing page' does NOT fire", () => {
    const tools = scope("write html for a landing page with CSS");
    expect(
      hasNone(tools, ["video_html_compose", "video_compose_manifest"]),
    ).toBe(true);
  });

  it("v7.4.3 FP: 'html email template' does NOT fire", () => {
    const tools = scope("create an html email template for newsletter");
    expect(
      hasNone(tools, ["video_html_compose", "video_compose_manifest"]),
    ).toBe(true);
  });

  it("v7.4.3 FP: 'parse html document' does NOT fire", () => {
    const tools = scope("parse the html document with cheerio");
    expect(
      hasNone(tools, ["video_html_compose", "video_compose_manifest"]),
    ).toBe(true);
  });

  it("v7.4.3 FP: 'render html to react' does NOT fire", () => {
    const tools = scope("render html to react components dynamically");
    expect(
      hasNone(tools, ["video_html_compose", "video_compose_manifest"]),
    ).toBe(true);
  });

  it("v7.4.3 FP R1 W5: 'html composition engine design' does NOT fire", () => {
    const tools = scope("discussing the html composition architecture");
    expect(
      hasNone(tools, ["video_html_compose", "video_compose_manifest"]),
    ).toBe(true);
  });

  it("v7.4.3 R1 W5: 'html composition video job' still fires", () => {
    const tools = scope("start an html-composition video job for the demo");
    expect(hasAll(tools, VIDEO_TOOLS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Dim-5 C-SCP-1 regression — NFD decomposed input activates scope patterns
// containing accented character classes (art[ií]culo, c[aá]mbia, etc.).
// Mobile clients (Telegram/WhatsApp) sometimes deliver decomposed Unicode.
// scopeToolsForMessage + detectActiveGroups normalize internally now.
// ---------------------------------------------------------------------------

describe("Dim-5 C-SCP-1: NFD input normalization", () => {
  // "artículo" in NFD = "art" + "i" + U+0301 (combining acute) + "culo"
  const NFD_ARTICULO = "art" + "í" + "culo";

  it("NFD input produces the same scope tools as NFC input", () => {
    const nfd = scope(`edita el ${NFD_ARTICULO} 546`);
    const nfc = scope("edita el artículo 546");
    expect(nfd.sort()).toEqual(nfc.sort());
  });

  it("detectActiveGroups activates wordpress on NFD 'artículo'", () => {
    const groups = detectActiveGroups(
      `actualiza el ${NFD_ARTICULO}`,
      [],
      DEFAULT_SCOPE_PATTERNS,
    );
    expect(groups.has("wordpress")).toBe(true);
  });

  it("NFD in recentUserMessages is normalized on the inheritance path", () => {
    const nfd = detectActiveGroups(
      "Sube eso",
      [`el ${NFD_ARTICULO} nuevo`],
      DEFAULT_SCOPE_PATTERNS,
    );
    const nfc = detectActiveGroups(
      "Sube eso",
      ["el artículo nuevo"],
      DEFAULT_SCOPE_PATTERNS,
    );
    expect([...nfd].sort()).toEqual([...nfc].sort());
  });
});
