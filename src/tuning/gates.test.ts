import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  runGates,
  DEFAULT_GATE_CONFIG,
  loadGateConfigFromEnv,
} from "./gates.js";
import type { Mutation, Experiment } from "./types.js";

const baseMutation: Mutation = {
  surface: "tool_description",
  target: "web_search",
  mutation_type: "rewrite",
  mutated_value: "Search the web.",
  hypothesis: "Make it clearer.",
};

// Hoist a schema mock so the gate's cooldown lookup is controllable from tests.
const schemaMock = vi.hoisted(() => ({
  getLastExperimentForTarget:
    vi.fn<(surface: string, target: string) => Experiment | null>(),
}));
vi.mock("./schema.js", () => ({
  getLastExperimentForTarget: schemaMock.getLastExperimentForTarget,
}));

beforeEach(() => {
  schemaMock.getLastExperimentForTarget.mockReset();
  schemaMock.getLastExperimentForTarget.mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runGates", () => {
  describe("constitution gate", () => {
    it("rejects hypothesis referencing case ID", () => {
      const r = runGates(
        {
          ...baseMutation,
          hypothesis: "Fix case-42 by loosening the regex",
        },
        5,
        "original",
        DEFAULT_GATE_CONFIG,
      );
      expect(r.passed).toBe(false);
      expect(r.failedGate).toBe("constitution");
    });

    it("accepts generic hypotheses", () => {
      const r = runGates(baseMutation, 5, "original", DEFAULT_GATE_CONFIG);
      expect(r.passed).toBe(true);
    });
  });

  describe("size gate", () => {
    it("rejects mutations >2x original length", () => {
      const r = runGates(
        { ...baseMutation, mutated_value: "X".repeat(300) },
        5,
        "X".repeat(100),
        DEFAULT_GATE_CONFIG,
      );
      expect(r.passed).toBe(false);
      expect(r.failedGate).toBe("size");
    });

    it("accepts mutations exactly 2x original length", () => {
      const r = runGates(
        { ...baseMutation, mutated_value: "X".repeat(200) },
        5,
        "X".repeat(100),
        DEFAULT_GATE_CONFIG,
      );
      expect(r.passed).toBe(true);
    });
  });

  describe("worthiness gate", () => {
    it("rejects single-case fix with >20% length increase", () => {
      const r = runGates(
        { ...baseMutation, mutated_value: "X".repeat(130) },
        1,
        "X".repeat(100),
        DEFAULT_GATE_CONFIG,
      );
      expect(r.passed).toBe(false);
      expect(r.failedGate).toBe("worthiness");
    });

    it("accepts multi-case fix with same length change", () => {
      const r = runGates(
        { ...baseMutation, mutated_value: "X".repeat(130) },
        10,
        "X".repeat(100),
        DEFAULT_GATE_CONFIG,
      );
      expect(r.passed).toBe(true);
    });
  });

  describe("safety gate", () => {
    it("is inert when no keywords configured", () => {
      const r = runGates(
        { ...baseMutation, mutated_value: "anything goes" },
        5,
        "NEVER email passwords",
        DEFAULT_GATE_CONFIG,
      );
      expect(r.passed).toBe(true);
    });

    it("rejects when mutation strips a safety keyword present in original", () => {
      const r = runGates(
        { ...baseMutation, mutated_value: "email passwords freely" },
        5,
        "NEVER email passwords",
        { safetyKeywords: "NEVER,MUST NOT", cooldownHours: 0 },
      );
      expect(r.passed).toBe(false);
      expect(r.failedGate).toBe("safety");
      expect(r.reason).toContain("NEVER");
    });

    it("passes when mutation preserves safety keywords", () => {
      const r = runGates(
        {
          ...baseMutation,
          mutated_value: "NEVER email passwords in plain text",
        },
        5,
        "NEVER email passwords",
        { safetyKeywords: "NEVER,MUST NOT", cooldownHours: 0 },
      );
      expect(r.passed).toBe(true);
    });

    it("passes when safety keyword absent from original (no obligation)", () => {
      const r = runGates(
        { ...baseMutation, mutated_value: "do something" },
        5,
        "no safety text here",
        { safetyKeywords: "NEVER,MUST NOT", cooldownHours: 0 },
      );
      expect(r.passed).toBe(true);
    });
  });

  describe("cooldown gate", () => {
    it("is inert when no prior experiment exists", () => {
      schemaMock.getLastExperimentForTarget.mockReturnValue(null);
      const r = runGates(baseMutation, 5, "original", DEFAULT_GATE_CONFIG);
      expect(r.passed).toBe(true);
    });

    it("blocks re-mutation within cooldown window after regression", () => {
      schemaMock.getLastExperimentForTarget.mockReturnValue({
        experiment_id: "prev",
        run_id: "r",
        surface: "tool_description",
        target: "web_search",
        mutation_type: "rewrite",
        original_value: "",
        mutated_value: "",
        hypothesis: "",
        baseline_score: null,
        mutated_score: null,
        status: "regressed",
        created_at: "2026-04-22 00:00:00",
      });
      const r = runGates(
        baseMutation,
        5,
        "original",
        { safetyKeywords: "", cooldownHours: 24 },
        new Date("2026-04-22T12:00:00Z").getTime(), // 12h later
      );
      expect(r.passed).toBe(false);
      expect(r.failedGate).toBe("cooldown");
    });

    it("allows re-mutation after cooldown expires", () => {
      schemaMock.getLastExperimentForTarget.mockReturnValue({
        experiment_id: "prev",
        run_id: "r",
        surface: "tool_description",
        target: "web_search",
        mutation_type: "rewrite",
        original_value: "",
        mutated_value: "",
        hypothesis: "",
        baseline_score: null,
        mutated_score: null,
        status: "regressed",
        created_at: "2026-04-22 00:00:00",
      });
      const r = runGates(
        baseMutation,
        5,
        "original",
        { safetyKeywords: "", cooldownHours: 24 },
        new Date("2026-04-23T02:00:00Z").getTime(), // 26h later
      );
      expect(r.passed).toBe(true);
    });

    it("does not block on a previous passed experiment", () => {
      schemaMock.getLastExperimentForTarget.mockReturnValue({
        experiment_id: "prev",
        run_id: "r",
        surface: "tool_description",
        target: "web_search",
        mutation_type: "rewrite",
        original_value: "",
        mutated_value: "",
        hypothesis: "",
        baseline_score: null,
        mutated_score: null,
        status: "passed",
        created_at: "2026-04-22 00:00:00",
      });
      const r = runGates(
        baseMutation,
        5,
        "original",
        { safetyKeywords: "", cooldownHours: 24 },
        new Date("2026-04-22T12:00:00Z").getTime(),
      );
      expect(r.passed).toBe(true);
    });
  });

  // R1 M3: scope_rule mutations with invalid regex must be rejected explicitly
  describe("scope_rule regex sanity", () => {
    it("rejects unparseable regex in scope_rule mutations", () => {
      const r = runGates(
        {
          ...baseMutation,
          surface: "scope_rule",
          target: "coding",
          mutated_value: "(unclosed",
        },
        5,
        "original",
        DEFAULT_GATE_CONFIG,
      );
      expect(r.passed).toBe(false);
      expect(r.reason).toContain("invalid regex");
    });

    it("accepts valid regex in scope_rule mutations", () => {
      const r = runGates(
        {
          ...baseMutation,
          surface: "scope_rule",
          target: "coding",
          mutated_value: "\\b(code|buildstep)\\b",
        },
        5,
        "\\b(code|programa|build|develop)\\b",
        DEFAULT_GATE_CONFIG,
      );
      expect(r.passed).toBe(true);
    });

    it("does not try to parse non-scope_rule mutations as regex", () => {
      const r = runGates(
        {
          ...baseMutation,
          surface: "tool_description",
          mutated_value: "(this is not regex",
        },
        5,
        "some original description of comparable length here",
        DEFAULT_GATE_CONFIG,
      );
      expect(r.passed).toBe(true);
    });
  });

  describe("loadGateConfigFromEnv", () => {
    const originalEnv = { ...process.env };
    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it("returns defaults when env vars unset", () => {
      delete process.env.TUNING_SAFETY_KEYWORDS;
      delete process.env.TUNING_COOLDOWN_HOURS;
      const cfg = loadGateConfigFromEnv();
      expect(cfg.safetyKeywords).toBe("");
      expect(cfg.cooldownHours).toBe(24);
    });

    it("reads overrides from env", () => {
      process.env.TUNING_SAFETY_KEYWORDS = "NEVER,REQUIRED";
      process.env.TUNING_COOLDOWN_HOURS = "48";
      const cfg = loadGateConfigFromEnv();
      expect(cfg.safetyKeywords).toBe("NEVER,REQUIRED");
      expect(cfg.cooldownHours).toBe(48);
    });

    it("falls back to default on non-numeric cooldown", () => {
      process.env.TUNING_COOLDOWN_HOURS = "not-a-number";
      expect(loadGateConfigFromEnv().cooldownHours).toBe(24);
    });

    // R1 W3: negative cooldown clamps to 0
    it("clamps negative cooldown to 0", () => {
      process.env.TUNING_COOLDOWN_HOURS = "-5";
      expect(loadGateConfigFromEnv().cooldownHours).toBe(0);
    });
  });
});
