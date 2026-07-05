/**
 * Enrichment service tests — mock memory service and outcomes.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../memory/index.js", () => ({
  getMemoryService: vi.fn().mockReturnValue({
    backend: "hindsight",
    recall: vi
      .fn()
      .mockResolvedValue([
        { content: "Fede prefiere respuestas concisas en español" },
        { content: "Proyecto CRM Azteca en progreso" },
      ]),
  }),
}));

vi.mock("../db/task-outcomes.js", () => ({
  queryOutcomes: vi.fn().mockReturnValue([]),
}));

// v7.7 Spine 3 Phase 3 B2 (R1-W2 fold): enrichment now routes through
// retrieveSkills (vector + keyword fallback) instead of the direct
// findSkillsByKeywords call. The old mock was dead code that masked
// the real test path. Mock the retrieval surface + getSkill lookup.
vi.mock("../db/skills.js", () => ({
  findSkillsByKeywords: vi.fn().mockReturnValue([]),
  getSkill: vi.fn().mockReturnValue(null),
}));

vi.mock("../skills/retrieval.js", () => ({
  retrieveSkills: vi.fn().mockResolvedValue([]),
}));

import { enrichContext } from "./enrichment.js";
import { queryOutcomes } from "../db/task-outcomes.js";

describe("enrichment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return context block with recalled user context", async () => {
    const result = await enrichContext("muéstrame las tareas", "telegram");

    expect(result.contextBlock).toContain("Contexto relevante del usuario");
    expect(result.contextBlock).toContain("concisas en español");
    expect(result.contextBlock).toContain("CRM Azteca");
  });

  it("should return context block starting with newlines", async () => {
    const result = await enrichContext("test", "telegram");

    expect(result.contextBlock.startsWith("\n\n")).toBe(true);
  });

  it("should include tool hints when outcomes have data", async () => {
    vi.mocked(queryOutcomes).mockReturnValue(
      Array.from({ length: 10 }, (_, i) => ({
        id: i,
        task_id: `task-${i}`,
        classified_as: "fast",
        ran_on: "fast",
        tools_used: JSON.stringify(["jarvis_file_read", "jarvis_file_write"]),
        duration_ms: 2000,
        success: 1,
        feedback_signal: "none",
        tags: "[]",
        created_at: "2026-03-16",
      })),
    );

    const result = await enrichContext("test", "telegram");

    expect(result.contextBlock).toContain("Herramientas más efectivas");
    expect(result.contextBlock).toContain("jarvis_file_read");
  });

  it("should return matchedSkillIds and confidence", async () => {
    const result = await enrichContext("test", "telegram");

    expect(result.matchedSkillIds).toEqual([]);
    expect(result.confidence).toBe("low");
  });

  it("propagates retrieveSkills hits to matchedSkillIds (R1-W2 fold)", async () => {
    const { retrieveSkills } = await import("../skills/retrieval.js");
    const { getSkill } = await import("../db/skills.js");

    vi.mocked(retrieveSkills).mockResolvedValueOnce([
      {
        skillId: "id-1",
        name: "test-skill",
        description: "desc",
        similarity: 0.9,
        source: "vector",
      },
    ]);
    vi.mocked(getSkill).mockReturnValueOnce({
      id: 1,
      skill_id: "id-1",
      name: "test-skill",
      description: "Send a follow-up",
      trigger_text: "follow-up",
      steps: '["do thing"]',
      tools: '["whatsapp_send"]',
      use_count: 5,
      success_count: 4,
      source: "manual",
      active: 1,
      created_at: "2026-05-19",
      updated_at: "2026-05-19",
    });

    const result = await enrichContext("send follow-up", "telegram");
    expect(result.matchedSkillIds).toEqual(["id-1"]);
    expect(result.contextBlock).toContain("test-skill");
  });

  describe("tool-first guard", () => {
    it("should inject reminder for schedule queries", async () => {
      const result = await enrichContext(
        "Qué reportes tienes programados?",
        "telegram",
      );

      expect(result.contextBlock).toContain("OBLIGATORIO");
      expect(result.contextBlock).toContain("list_schedules");
    });

    it("should inject reminder for task queries", async () => {
      const result = await enrichContext(
        "Qué tareas pendientes hay?",
        "telegram",
      );

      expect(result.contextBlock).toContain("OBLIGATORIO");
      expect(result.contextBlock).toContain("jarvis_file_read");
    });

    it("should inject correction protocol when user says olvidaste", async () => {
      const result = await enrichContext(
        "Olvidaste incluir el reporte de SMCI",
        "telegram",
      );

      expect(result.contextBlock).toContain("Protocolo de corrección");
      expect(result.contextBlock).toContain("regenera desde CERO");
    });

    it("should not inject reminder for generic messages", async () => {
      const result = await enrichContext("Hola, cómo estás?", "telegram");

      expect(result.contextBlock).not.toContain("OBLIGATORIO");
      expect(result.contextBlock).not.toContain("Protocolo de corrección");
    });
  });
});
