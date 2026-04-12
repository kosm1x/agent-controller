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

  it("specialty activates on chart/rss/image keywords", () => {
    const tools = scope("Genera un gráfico de ventas");
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
// wordpress positive activation
// ---------------------------------------------------------------------------

describe("wordpress positive", () => {
  it("activates on 'Publica el artículo en WordPress'", () => {
    const tools = scope("Publica el artículo en WordPress");
    expect(hasAll(tools, WORDPRESS_TOOLS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// v7.3 SEO/GEO scope group
// ---------------------------------------------------------------------------

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

  it("detects specialty on chart/image keywords", () => {
    const groups = detect("Genera un gráfico");
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
