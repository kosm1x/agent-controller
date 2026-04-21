import { describe, it, expect } from "vitest";
import { createMorningBriefing } from "./morning.js";

describe("createMorningBriefing", () => {
  it("includes learner_model_status in the tool list (v7.11 wiring)", () => {
    const submission = createMorningBriefing("2026-04-21");
    expect(submission.tools).toContain("learner_model_status");
  });

  it("instructs the LLM to call learner_model_status in its description", () => {
    const submission = createMorningBriefing("2026-04-21");
    expect(submission.description).toMatch(/learner_model_status/);
    expect(submission.description).toMatch(/filter="due"/);
  });

  it("keeps the existing required tools (regression guard)", () => {
    const submission = createMorningBriefing("2026-04-21");
    expect(submission.requiredTools).toEqual([
      "jarvis_file_read",
      "gmail_send",
    ]);
  });
});
