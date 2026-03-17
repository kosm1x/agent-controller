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

vi.mock("../db/skills.js", () => ({
  findSkillsByKeywords: vi.fn().mockReturnValue([]),
}));

import { enrichContext, clearEnrichmentCache } from "./enrichment.js";
import { queryOutcomes } from "../db/task-outcomes.js";

describe("enrichment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearEnrichmentCache();
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
        tools_used: JSON.stringify([
          "commit__list_tasks",
          "commit__update_status",
        ]),
        duration_ms: 2000,
        success: 1,
        feedback_signal: "none",
        tags: "[]",
        created_at: "2026-03-16",
      })),
    );

    const result = await enrichContext("test", "telegram");

    expect(result.contextBlock).toContain("Herramientas más efectivas");
    expect(result.contextBlock).toContain("list_tasks");
  });

  it("should return matchedSkillIds and confidence", async () => {
    const result = await enrichContext("test", "telegram");

    expect(result.matchedSkillIds).toEqual([]);
    expect(result.confidence).toBe("low");
  });
});
