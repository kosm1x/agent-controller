import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runSelfReview } from "./self-review.js";
import type { Mutation } from "./types.js";

const baseMutation: Mutation = {
  surface: "tool_description",
  target: "web_search",
  mutation_type: "rewrite",
  mutated_value: "Search the web for current information.",
  hypothesis: "Clarify when this tool is appropriate.",
};

describe("runSelfReview", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  beforeEach(() => {
    delete process.env.TUNING_SELF_REVIEW;
  });

  it("always rejects placeholder text regardless of flag", async () => {
    const r = await runSelfReview(
      { ...baseMutation, mutated_value: "TODO: fill in later" },
      "original text",
    );
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("placeholder");
    expect(r.tokensUsed).toBe(0);
  });

  it("rejects FIXME placeholder", async () => {
    const r = await runSelfReview(
      { ...baseMutation, mutated_value: "Search. FIXME edge case." },
      "original",
    );
    expect(r.passed).toBe(false);
  });

  it("rejects <fill in> placeholder", async () => {
    const r = await runSelfReview(
      {
        ...baseMutation,
        mutated_value: "Search when user asks about <fill in>.",
      },
      "original",
    );
    expect(r.passed).toBe(false);
  });

  it("returns pass with zero tokens when flag is off", async () => {
    const r = await runSelfReview(baseMutation, "original");
    expect(r.passed).toBe(true);
    expect(r.tokensUsed).toBe(0);
  });

  it("calls infer function when flag is on and returns ACCEPT", async () => {
    process.env.TUNING_SELF_REVIEW = "true";
    const r = await runSelfReview(baseMutation, "original", async () => ({
      content: "ACCEPT",
      tokensUsed: 120,
    }));
    expect(r.passed).toBe(true);
    expect(r.tokensUsed).toBe(120);
  });

  it("parses REJECT with reason", async () => {
    process.env.TUNING_SELF_REVIEW = "true";
    const r = await runSelfReview(baseMutation, "original", async () => ({
      content: "REJECT: contradictory clauses in lines 2-3",
      tokensUsed: 130,
    }));
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("contradictory");
    expect(r.tokensUsed).toBe(130);
  });

  it("non-fatally passes on infer errors", async () => {
    process.env.TUNING_SELF_REVIEW = "true";
    const r = await runSelfReview(baseMutation, "original", async () => {
      throw new Error("simulated infer error");
    });
    expect(r.passed).toBe(true);
    expect(r.tokensUsed).toBe(0);
  });

  // R1 C1: legitimate "TODO" in content must NOT trigger placeholder gate
  it("accepts legitimate TODO noun usage", async () => {
    const r = await runSelfReview(
      {
        ...baseMutation,
        mutated_value: "Track TODOs and outstanding tasks for the user.",
      },
      "original",
    );
    expect(r.passed).toBe(true);
  });

  it("rejects TODO with colon (template placeholder)", async () => {
    const r = await runSelfReview(
      {
        ...baseMutation,
        mutated_value: "Search the web. TODO: add date-range support.",
      },
      "original",
    );
    expect(r.passed).toBe(false);
  });

  it("rejects unsubstituted {{template}} marker", async () => {
    const r = await runSelfReview(
      {
        ...baseMutation,
        mutated_value: "Do {{action}} for the user.",
      },
      "original",
    );
    expect(r.passed).toBe(false);
  });

  it("rejects <INSERT ...> marker", async () => {
    const r = await runSelfReview(
      {
        ...baseMutation,
        mutated_value: "Search the web. <INSERT DESCRIPTION>",
      },
      "original",
    );
    expect(r.passed).toBe(false);
  });
});
