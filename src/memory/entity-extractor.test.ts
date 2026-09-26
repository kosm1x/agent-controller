/**
 * Tests for auto entity detection (v6.5 M3).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/projects.js", () => ({ listProjects: vi.fn() }));

import { listProjects } from "../db/projects.js";
import {
  extractEntities,
  _resetProjectTermsCacheForTests,
} from "./entity-extractor.js";

/** Minimal registry rows — only the fields the extractor reads. */
function registry(
  rows: Array<{ slug: string; name: string; aliases?: string[] }>,
) {
  return rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    config: r.aliases ? { aliases: r.aliases } : {},
  })) as unknown as ReturnType<typeof listProjects>;
}

const ACTIVE_REGISTRY = registry([
  { slug: "cuatro-flor", name: "Cuatro Flor" },
  { slug: "pipesong", name: "PipeSong - Voice AI Infrastructure" },
  {
    slug: "very-light-cms",
    name: "Very Light CMS",
    aliases: ["vlcms", "very-light-cms", "very light cms", "williams cms"],
  },
  {
    slug: "williams-entry-radar",
    name: "Williams Entry Radar",
    aliases: ["williams", "radar", "journal", "thewilliamsradar"],
  },
  { slug: "pulso-aura-upfront", name: "Pulso Aura Upfront" },
]);

beforeEach(() => {
  _resetProjectTermsCacheForTests();
  vi.mocked(listProjects).mockReset();
  vi.mocked(listProjects).mockReturnValue(ACTIVE_REGISTRY);
});

describe("extractEntities", () => {
  it("returns empty for short/empty text", () => {
    expect(extractEntities("")).toEqual([]);
    expect(extractEntities("hi")).toEqual([]);
    expect(extractEntities("short msg")).toEqual([]);
  });

  it("detects known project slugs", () => {
    const triples = extractEntities(
      "Estamos trabajando en pipesong y completé la fase 3 del voice engine",
    );
    const pipesong = triples.find((t) => t.subject === "pipesong");
    expect(pipesong).toBeDefined();
    expect(pipesong!.predicate).toBe("status_completed");
  });

  it("detects 'proyecto X' mentions", () => {
    const triples = extractEntities(
      "El proyecto Cuatro Flor tiene avances importantes en la investigación",
    );
    const found = triples.find((t) => t.subject === "cuatro flor");
    expect(found).toBeDefined();
    expect(found!.predicate).toBe("mentioned_in_conversation");
  });

  it("detects decisions in Spanish", () => {
    const triples = extractEntities(
      "Decidí usar Claude Sonnet como proveedor principal de inferencia",
    );
    const decision = triples.find((t) => t.predicate === "decided");
    expect(decision).toBeDefined();
    expect(decision!.object).toContain("Claude Sonnet");
  });

  it("detects decisions in English", () => {
    const triples = extractEntities(
      "We decided to switch to Groq as the fallback provider for better tool support",
    );
    const decision = triples.find((t) => t.predicate === "decided");
    expect(decision).toBeDefined();
    expect(decision!.object).toContain("Groq");
  });

  it("detects adoption patterns", () => {
    const triples = extractEntities(
      "Vamos con DeepInfra para el hosting alternativo de Qwen",
    );
    const adopted = triples.find((t) => t.predicate === "adopted");
    expect(adopted).toBeDefined();
    expect(adopted!.object).toContain("DeepInfra");
  });

  it("detects person mentions with prepositions", () => {
    const triples = extractEntities(
      "Tuve una reunión con Carlos sobre el diseño del sistema de pagos",
    );
    const person = triples.find((t) => t.subject === "carlos");
    expect(person).toBeDefined();
    expect(person!.predicate).toBe("mentioned_in_conversation");
  });

  it("detects @ mentions", () => {
    const triples = extractEntities(
      "Le pregunté a @fernando sobre la integración del API",
    );
    const person = triples.find((t) => t.subject === "fernando");
    expect(person).toBeDefined();
  });

  it("filters Spanish preposition false positives", () => {
    const triples = extractEntities(
      "Esto es para Los usuarios del sistema que necesitan acceso",
    );
    const falsePosNames = triples.filter(
      (t) => t.subject === "los" || t.subject === "una",
    );
    expect(falsePosNames).toHaveLength(0);
  });

  it("deduplicates identical triples", () => {
    const triples = extractEntities(
      "El proyecto Cuatro Flor avanza. Seguimos con el proyecto Cuatro Flor mañana",
    );
    // "proyecto Cuatro Flor" matched twice by regex, dedup keeps one per path
    const projMentions = triples.filter(
      (t) =>
        t.subject === "cuatro flor" &&
        t.predicate === "mentioned_in_conversation",
    );
    expect(projMentions).toHaveLength(1);
  });

  it("detects status changes for known projects", () => {
    const triples = extractEntities(
      "Empecé la validación epigráfica del 117 en el contexto de cuatro-flor",
    );
    const status = triples.find(
      (t) => t.subject === "cuatro-flor" && t.predicate.startsWith("status_"),
    );
    expect(status).toBeDefined();
  });

  it("handles deployment events", () => {
    const triples = extractEntities(
      "Deployed the new circuit breaker fix to production successfully",
    );
    const deploy = triples.find((t) => t.predicate === "status_deployed");
    expect(deploy).toBeDefined();
  });

  it("handles failure events", () => {
    const triples = extractEntities(
      "The nanoclaw container failed with exit code 1 during auto-improvement",
    );
    const fail = triples.find((t) => t.predicate === "status_failed");
    expect(fail).toBeDefined();
  });
});

describe("extractEntities — project slugs from the registry", () => {
  const statusSubjects = (text: string) =>
    extractEntities(text)
      .filter((t) => t.predicate.startsWith("status_"))
      .map((t) => t.subject);

  it("recognises a registry slug (very-light-cms)", () => {
    const triples = extractEntities("deployed very-light-cms to prod");
    const hit = triples.find((t) => t.subject === "very-light-cms");
    expect(hit).toBeDefined();
    expect(hit!.predicate).toBe("status_deployed");
    expect(listProjects).toHaveBeenCalledWith("active");
  });

  it("recognises a registry slug in Spanish (williams-entry-radar)", () => {
    const triples = extractEntities("terminé el williams-entry-radar de W38");
    const hit = triples.find((t) => t.subject === "williams-entry-radar");
    expect(hit).toBeDefined();
    expect(hit!.predicate).toBe("status_completed");
  });

  it("normalises an alias hit to its registry slug (vlcms → very-light-cms)", () => {
    const subjects = statusSubjects("subí a producción vlcms con el fix");
    expect(subjects).toContain("very-light-cms");
    expect(subjects).not.toContain("vlcms");
  });

  it("normalises a registry name hit to its slug", () => {
    expect(
      statusSubjects("completé el onboarding de Pulso Aura Upfront hoy"),
    ).toContain("pulso-aura-upfront");
  });

  it("still recognises the static core with an empty registry", () => {
    vi.mocked(listProjects).mockReturnValue([]);
    for (const slug of [
      "mission-control",
      "jarvis",
      "northstar",
      "agent-controller",
      "eurekamD",
    ]) {
      _resetProjectTermsCacheForTests();
      expect(statusSubjects(`deployed the ${slug} release to prod`)).toContain(
        slug,
      );
    }
  });

  it("keeps the eurekamD subject string existing triples use", () => {
    vi.mocked(listProjects).mockReturnValue([]);
    const hit = extractEntities("completé el sitio de EurekaMD").find((t) =>
      t.predicate.startsWith("status_"),
    );
    expect(hit?.subject).toBe("eurekamD");
  });

  it("ignores stoplisted routing aliases (williams, radar, journal)", () => {
    expect(statusSubjects("deployed the journal to the new box")).not.toContain(
      "williams-entry-radar",
    );
    expect(
      statusSubjects("terminé con Caleb Williams el análisis"),
    ).not.toContain("williams-entry-radar");
    expect(
      statusSubjects("empecé a revisar lo que está en el radar"),
    ).not.toContain("williams-entry-radar");
  });

  it("still matches non-stoplisted aliases (thewilliamsradar)", () => {
    expect(
      statusSubjects("publiqué thewilliamsradar y deployed el post"),
    ).toContain("williams-entry-radar");
  });

  it("no longer recognises the retired crm-azteca slug", () => {
    expect(
      statusSubjects("crm-azteca empezó el módulo de prospectos"),
    ).not.toContain("crm-azteca");
  });

  it("falls back to the static set when the registry read throws", () => {
    vi.mocked(listProjects).mockImplementation(() => {
      throw new Error("Database not initialized. Call initDatabase() first.");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(statusSubjects("deployed mission-control v8 to prod")).toContain(
        "mission-control",
      );
      // Registry-only slug is not recognised without the registry.
      expect(statusSubjects("deployed very-light-cms to prod")).not.toContain(
        "very-light-cms",
      );
      expect(warn).toHaveBeenCalledTimes(1); // logged once, not per call
    } finally {
      warn.mockRestore();
    }
  });

  it("caches the registry read between calls", () => {
    extractEntities("deployed very-light-cms to prod");
    extractEntities("terminé el williams-entry-radar de W38");
    expect(listProjects).toHaveBeenCalledTimes(1);
  });
});
