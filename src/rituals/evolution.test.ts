import { describe, it, expect } from "vitest";
import { createEvolutionRitual } from "./evolution.js";
import { resolveUseOpus } from "../prometheus/model-tier.js";

describe("createEvolutionRitual", () => {
  const ritual = createEvolutionRitual("2026-06-28");

  it("targets the heavy runner with a dated title", () => {
    expect(ritual.agentType).toBe("heavy");
    expect(ritual.title).toBe("Skill evolution — 2026-06-28");
  });

  it("does NOT give the agent memory_store — persistence is deterministic", () => {
    // The old ritual gated success on the agent voluntarily calling
    // memory_store (skipped ~100% of the time on Sonnet). The agent now only
    // does tool-grounded analysis; the dispatcher persists its report.
    expect(ritual.tools).not.toContain("memory_store");
    expect(ritual.tools).toEqual([
      "evolution_get_data",
      "evolution_deactivate_skill",
    ]);
  });

  it("declares deterministic persistResult to the operational bank", () => {
    expect(ritual.persistResult).toEqual({
      bank: "mc-operational",
      tags: ["evolution", "ritual"],
    });
  });

  it("instructs the agent to emit (not store) the report", () => {
    expect(ritual.description).toMatch(
      /FINAL ANSWER must BE the evolution report/,
    );
    expect(ritual.description).toMatch(
      /do NOT try to\s+save the report yourself/i,
    );
    // memory_store appears only as an explicit "do NOT call" instruction, never
    // as a storage step the agent is told to perform.
    expect(ritual.description).toMatch(/do NOT call memory_store/i);
    expect(ritual.description).not.toMatch(/Store your evolution report via/i);
    // The deactivation tool must stay reachable — the prohibition is scoped to
    // saving the report, not to acting on the analysis (qa HIGH-1).
    expect(ritual.description).toMatch(
      /SHOULD still call\s+evolution_deactivate_skill/i,
    );
  });

  it("routes to Opus via resolveUseOpus (Opus pin) — guards the complex wording", () => {
    // The description must carry complex signals so the model-tier resolver
    // picks Opus, not Sonnet. If this fails, someone stripped "comprehensively
    // audit" / "thorough investigation" from the prompt — restore them or the
    // ritual silently regresses to the tier that failed it.
    expect(resolveUseOpus(ritual.description)).toBe(true);
  });
});
