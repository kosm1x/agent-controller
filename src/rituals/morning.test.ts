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

  it("keeps the existing required tools (regression guard — submit_report intentionally NOT here, see C2 below)", () => {
    const submission = createMorningBriefing("2026-04-21");
    expect(submission.requiredTools).toEqual([
      "jarvis_file_read",
      "gmail_send",
    ]);
  });

  it("v7.7 Spine 1 Phase 2a: submit_report wired before gmail_send", () => {
    const submission = createMorningBriefing("2026-04-21");
    expect(submission.tools).toContain("submit_report");
    expect(submission.description).toMatch(/submit_report/);
    expect(submission.description).toMatch(/surface="morning_brief"/);
    // CRITICAL: gmail_send must run even on audit failure — observability,
    // not delivery gate. Regression guard for the most load-bearing semantic.
    expect(submission.description).toMatch(
      /submit_report is observability, NOT a delivery gate/,
    );
  });

  it("R1-C2 regression guard: submit_report is NOT in requiredTools (would trigger duplicate gmail_send on skip)", () => {
    const submission = createMorningBriefing("2026-04-21");
    expect(submission.requiredTools).not.toContain("submit_report");
  });

  it("R1-C1 regression guard: prompt embeds a concrete task_id for the cap to function", () => {
    const submission = createMorningBriefing("2026-04-21");
    // The exact value is random per call; verify the pattern is wired
    expect(submission.description).toMatch(
      /task_id="morning-brief-2026-04-21-[a-f0-9]{8}"/,
    );
  });

  describe("v7.7 Spine 2 Bundle 2 — S3 alert section", () => {
    it("when alertSection is undefined: no S3 section appears", () => {
      const submission = createMorningBriefing("2026-04-21");
      expect(submission.description).not.toContain("Sección de alertas S3");
      expect(submission.description).not.toContain(
        "COPIA VERBATIM al final del email",
      );
    });

    it("when alertSection is empty string: no S3 section appears (OMIT discipline)", () => {
      const submission = createMorningBriefing("2026-04-21", "");
      expect(submission.description).not.toContain("Sección de alertas S3");
    });

    it("when alertSection is whitespace only: still treated as empty", () => {
      const submission = createMorningBriefing("2026-04-21", "   \n  ");
      expect(submission.description).not.toContain("Sección de alertas S3");
    });

    it("when alertSection is non-empty: section + verbatim-copy instruction appear", () => {
      const alert =
        "## 🚨 Alertas de deriva (S3)\n\n### 🔴 Crítico (P0) — 1\n\n- **test_signal** (test) — above, observado: 42";
      const submission = createMorningBriefing("2026-04-21", alert);
      expect(submission.description).toContain("Sección de alertas S3");
      expect(submission.description).toContain(
        "COPIA VERBATIM al final del email",
      );
      // CRITICAL: the section markdown must appear verbatim, not paraphrased
      expect(submission.description).toContain(alert);
    });

    it("verbatim-copy instruction tells the LLM not to translate signal names", () => {
      const alert = "## 🚨 Alertas de deriva (S3)\n\n- **sig_name**";
      const submission = createMorningBriefing("2026-04-21", alert);
      // Case-insensitive: instruction wording moved to lowercase after R1-W1
      // fold ("no traduzcas los nombres de señal"), but the constraint stands.
      expect(submission.description).toMatch(
        /no traduzcas los nombres de señal/i,
      );
    });
  });
});
