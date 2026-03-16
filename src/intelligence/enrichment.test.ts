/**
 * Enrichment service tests — mock Hindsight client and outcomes.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../memory/index.js", () => ({
  getMemoryService: () => ({ backend: "hindsight" }),
}));

vi.mock("../memory/hindsight-client.js", () => ({
  HindsightClient: vi.fn().mockImplementation(() => ({
    getMentalModel: vi
      .fn()
      .mockImplementation((_bank: string, modelId: string) => {
        if (modelId === "user-behavior") {
          return Promise.resolve({
            id: "user-behavior",
            content: "Fede prefers concise responses in Spanish",
          });
        }
        if (modelId === "active-projects") {
          return Promise.resolve({
            id: "active-projects",
            content: "Working on CRM Azteca and agent-controller",
          });
        }
        return Promise.resolve({ id: modelId, content: "" });
      }),
  })),
}));

vi.mock("../db/task-outcomes.js", () => ({
  queryOutcomes: vi.fn().mockReturnValue([]),
}));

import { enrichContext, clearEnrichmentCache } from "./enrichment.js";
import { queryOutcomes } from "../db/task-outcomes.js";

describe("enrichment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearEnrichmentCache();
  });

  it("should return context block with mental model content", async () => {
    const result = await enrichContext("test message", "telegram");

    expect(result.contextBlock).toContain("Tu conocimiento del usuario");
    expect(result.contextBlock).toContain("concise responses");
    expect(result.contextBlock).toContain("Estado actual de proyectos");
    expect(result.contextBlock).toContain("CRM Azteca");
  });

  it("should return context block starting with newlines", async () => {
    const result = await enrichContext("test", "telegram");

    // Context block should start with double newline for prompt injection
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

  it("should cache mental model content for 5 minutes", async () => {
    await enrichContext("first", "telegram");
    await enrichContext("second", "telegram");

    // HindsightClient constructor called once, getMentalModel called only for first call
    const { HindsightClient } = await import("../memory/hindsight-client.js");
    const instance = vi.mocked(HindsightClient).mock.results[0]?.value as any;

    // First call: 2 models queried. Second call: cached — 0 additional queries
    expect(instance.getMentalModel).toHaveBeenCalledTimes(2);
  });
});
