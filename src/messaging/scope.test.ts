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
  COMMIT_READ_TOOLS,
  COMMIT_WRITE_TOOLS,
  COMMIT_JOURNAL_TOOLS,
  GOOGLE_TOOLS,
  WORDPRESS_TOOLS,
  CODING_TOOLS,
  RESEARCH_TOOLS,
  SPECIALTY_TOOLS,
  SCHEDULE_TOOLS,
  MISC_TOOLS,
  CRM_TOOLS_SCOPE,
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
  it("commit_read activates on COMMIT nouns (tarea, objetivo, meta)", () => {
    const tools = scope("Qué tareas tengo pendientes?");
    expect(hasAll(tools, COMMIT_READ_TOOLS)).toBe(true);
  });

  it("commit_read also loads COMMIT_WRITE_TOOLS (merged scope)", () => {
    const tools = scope("Lista mis objetivos");
    expect(hasAll(tools, COMMIT_WRITE_TOOLS)).toBe(true);
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

  it("Lightpanda browser tools always available via MISC_TOOLS", () => {
    const tools = scope("Hola, buenos días");
    expect(tools).toContain("browser__goto");
    expect(tools).toContain("browser__click");
    expect(tools).toContain("browser__fill");
    // Playwright tools are scope-gated, NOT always available
    expect(tools).not.toContain("playwright__browser_navigate");
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
    expect(scope("Crea una tarea en COMMIT")).not.toContain("crm_query");
    expect(scope("Busca en mi gmail")).not.toContain("crm_query");
  });

  it("commit_destructive activates on delete/remove keywords", () => {
    const tools = scope("Elimina esa tarea");
    expect(tools).toContain("commit__delete_item");
  });

  it("commit__delete_item visible when any COMMIT scope is active", () => {
    // delete_item should be visible whenever COMMIT context is present,
    // not only when explicit delete/remove keywords are used.
    // The execution-time lock is the real safety gate.
    const tools = scope("Lista mis tareas de COMMIT");
    expect(tools).toContain("commit__delete_item");
  });

  it("schedule activates on schedule/reporte/programad keywords", () => {
    const tools = scope("Programa un reporte diario");
    expect(hasAll(tools, SCHEDULE_TOOLS)).toBe(true);
  });

  it("meta scope loads ALL groups for diagnostics", () => {
    const tools = scope(
      "Vuelve a hacer el autodiagnostico y lista todas las tools",
    );
    expect(tools).toContain("commit__list_tasks");
    expect(tools).toContain("commit__delete_item");
    expect(tools).toContain("commit__update_task");
    expect(tools).toContain("schedule_task");
    expect(hasAll(tools, CODING_TOOLS)).toBe(true);
  });

  it("meta scope activates on 'herramientas disponibles'", () => {
    const tools = scope("Cuáles herramientas disponibles tienes?");
    expect(tools).toContain("commit__list_tasks");
    expect(tools).toContain("commit__update_task");
  });

  it("meta scope activates on 'nivel operativo'", () => {
    const tools = scope("Dame un auto-diagnostico de tu nivel operativo");
    expect(tools).toContain("commit__list_tasks");
  });

  it("no false positives on casual Spanish conversation", () => {
    const tools = scope("Hola, buenos días. Cómo estás?");
    // Should only have core + misc tools
    expect(hasNone(tools, COMMIT_WRITE_TOOLS)).toBe(true);
    expect(hasNone(tools, GOOGLE_TOOLS)).toBe(true);
    expect(hasNone(tools, CODING_TOOLS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// commit_write patterns — each of 6 sub-patterns tested independently
// ---------------------------------------------------------------------------

describe("commit_write sub-patterns", () => {
  it("create verbs: 'Crea una tarea nueva'", () => {
    const tools = scope("Crea una tarea nueva para mañana");
    expect(hasAll(tools, COMMIT_WRITE_TOOLS)).toBe(true);
  });

  it("verb-first updates: 'Actualiza la tarea de diseño'", () => {
    const tools = scope("Actualiza la tarea de diseño UX");
    expect(hasAll(tools, COMMIT_WRITE_TOOLS)).toBe(true);
  });

  it("clitic pronouns: 'cámbialo'", () => {
    const tools = scope("El objetivo está mal, cámbialo");
    expect(hasAll(tools, COMMIT_WRITE_TOOLS)).toBe(true);
  });

  it("completion markers: 'Marca como completada'", () => {
    const tools = scope("Marca como completada la tarea");
    expect(hasAll(tools, COMMIT_WRITE_TOOLS)).toBe(true);
  });

  it("completion + noun: 'Completé la tarea'", () => {
    const tools = scope("Completé la tarea de escritura");
    expect(hasAll(tools, COMMIT_WRITE_TOOLS)).toBe(true);
  });

  it("noun-before-verb: 'La tarea de ayer, actualízala'", () => {
    const tools = scope("La tarea de ayer necesita cambios, actualízala");
    expect(hasAll(tools, COMMIT_WRITE_TOOLS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// commit_journal — separate scope group
// ---------------------------------------------------------------------------

describe("commit_journal scope", () => {
  it("activates on 'escribe en mi diario'", () => {
    const tools = scope("Escribe en mi diario lo que pasó hoy");
    expect(tools).toContain("commit__create_journal");
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
// Two-phase isolation — scope inheritance behavior
// ---------------------------------------------------------------------------

describe("two-phase scope isolation", () => {
  it("inherits from prior messages when current has scope signals", () => {
    const tools = scope("Actualiza el status de la tarea", [
      "Busca en mi gmail los correos de ayer",
    ]);
    // Current triggers commit_read, prior adds google
    expect(hasAll(tools, COMMIT_READ_TOOLS)).toBe(true);
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
    const tools = scope("Ejecuta lo que te pedí con las tareas de COMMIT", [
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
      ["Lee el journal de COMMIT y busca la consolidación"],
    );
    // 95 chars but "el primero que" triggers referential inheritance
    expect(hasAll(tools, COMMIT_WRITE_TOOLS)).toBe(true);
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
      "lo que pasa es que el clima esta cambiando mucho este año y me preocupa bastante la situación",
      ["Busca en mi gmail los correos de ayer"],
    );
    // 93 chars, "lo que" without "te/me pedí/dije" — should NOT inherit
    expect(hasNone(tools, GOOGLE_TOOLS)).toBe(true);
  });

  it("long message without scope signals gets core tools only", () => {
    const tools = scope(
      "Me siento bien hoy, tuve un buen día y quiero descansar un poco esta tarde después de caminar",
    );
    // 80+ chars, no scope keywords, no imperative verbs
    // COMMIT_READ is now in CORE_TOOLS (always-on), so it's present
    expect(hasAll(tools, CORE_TOOLS)).toBe(true);
    expect(hasAll(tools, MISC_TOOLS)).toBe(true);
    expect(hasNone(tools, GOOGLE_TOOLS)).toBe(true);
    expect(hasNone(tools, CODING_TOOLS)).toBe(true);
    expect(hasNone(tools, COMMIT_WRITE_TOOLS)).toBe(true);
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
    expect(hasAll(tools, COMMIT_WRITE_TOOLS)).toBe(true);
    expect(hasAll(tools, COMMIT_JOURNAL_TOOLS)).toBe(true);
    expect(hasAll(tools, SPECIALTY_TOOLS)).toBe(true);
    expect(hasAll(tools, RESEARCH_TOOLS)).toBe(true);
    expect(hasAll(tools, SCHEDULE_TOOLS)).toBe(true);
    expect(hasAll(tools, CODING_TOOLS)).toBe(true);
    expect(tools).toContain("commit__delete_item");
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

  it("detects commit_read on task keywords", () => {
    const groups = detect("Qué tareas tengo pendientes?");
    expect(groups.has("commit_read")).toBe(true);
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
    expect(groups.has("commit_write")).toBe(true);
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
