/**
 * Tests for auto entity detection (v6.5 M3).
 */

import { describe, it, expect } from "vitest";
import { extractEntities } from "./entity-extractor.js";

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
