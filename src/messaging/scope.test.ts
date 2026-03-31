/**
 * Tests for scope.ts — pattern matching, two-phase isolation, feature gates.
 *
 * scopeToolsForMessage is a pure function — no mocking needed.
 */

import { describe, it, expect } from "vitest";
import {
  scopeToolsForMessage,
  DEFAULT_SCOPE_PATTERNS,
  CORE_TOOLS,
  COMMIT_READ_TOOLS,
  COMMIT_WRITE_TOOLS,
  GOOGLE_TOOLS,
  WORDPRESS_TOOLS,
  CODING_TOOLS,
  BROWSER_TOOLS,
  SPECIALTY_TOOLS,
  RESEARCH_TOOLS,
  SCHEDULE_TOOLS,
  MISC_TOOLS,
} from "./scope.js";
import type { ScopeOptions } from "./scope.js";

const ALL_ON: ScopeOptions = {
  hasGoogle: true,
  hasWordpress: true,
  hasMemory: true,
};
const ALL_OFF: ScopeOptions = {
  hasGoogle: false,
  hasWordpress: false,
  hasMemory: false,
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

  it("browser activates on navigation keywords", () => {
    const tools = scope("Navega al sitio web de la empresa");
    expect(hasAll(tools, BROWSER_TOOLS)).toBe(true);
  });

  it("specialty activates on chart/rss/image keywords", () => {
    const tools = scope("Genera un gráfico de ventas");
    expect(tools).toContain("chart_generate");
  });

  it("research activates on gemini/study/podcast keywords", () => {
    const tools = scope("Hazme un study guide del documento");
    expect(hasAll(tools, RESEARCH_TOOLS)).toBe(true);
  });

  it("commit_destructive activates on delete/remove keywords", () => {
    const tools = scope("Elimina esa tarea");
    expect(tools).toContain("commit__delete_item");
  });

  it("schedule activates on schedule/reporte/programad keywords", () => {
    const tools = scope("Programa un reporte diario");
    expect(hasAll(tools, SCHEDULE_TOOLS)).toBe(true);
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

  it("imperative verb inherits scope regardless of length", () => {
    const tools = scope("Ejecuta lo que te pedí con las tareas de COMMIT", [
      "Busca en mi gmail los correos de ayer",
    ]);
    // "ejecuta" triggers inheritance even though message has own signals
    expect(hasAll(tools, GOOGLE_TOOLS)).toBe(true);
  });

  it("long message without scope signals gets core tools only", () => {
    const tools = scope(
      "Me siento bien hoy, tuve un buen día y quiero descansar un poco esta tarde después de caminar",
    );
    // 80+ chars, no scope keywords, no imperative verbs
    expect(hasAll(tools, CORE_TOOLS)).toBe(true);
    expect(hasAll(tools, MISC_TOOLS)).toBe(true);
    expect(hasNone(tools, GOOGLE_TOOLS)).toBe(true);
    expect(hasNone(tools, CODING_TOOLS)).toBe(true);
    expect(hasNone(tools, COMMIT_READ_TOOLS)).toBe(true);
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
