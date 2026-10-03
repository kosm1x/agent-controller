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
    // jarvis_file_read dropped 2026-10-03: the narrative is harness-embedded,
    // README reads are optional — requiring one would re-run (re-send) the brief.
    expect(submission.requiredTools).toEqual(["gmail_send"]);
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

  // Cambio 2 (2026-06-19): the brief reads the prior-day narrative so it has
  // ground truth on what happened yesterday instead of marking it "incierto".
  describe("Cambio 2 — brief reads prior-day narrative", () => {
    // 2026-10-03: the scheduler loads the narrative and the template embeds
    // it — a model-side read of a narrative over 8,000 chars got an outline.
    it("embeds yesterday's narrative verbatim, fenced as data, with no read instruction", () => {
      const tail = "y quedó DESPLEGADO y verificado en producción";
      const narrative = `# Bitácora narrativa — 2026-04-20\n\n| 10:00 | Deploy | ${"x".repeat(9_000)} ${tail} |\n`;
      const submission = createMorningBriefing("2026-04-21", "", narrative);
      const d = submission.description;
      expect(d).toContain(tail);
      expect(d).toContain(
        "⟦BEGIN NARRATIVE — logs/day-narratives/2026-04-20.md — ",
      );
      expect(d).toContain("⟦END NARRATIVE⟧");
      expect(d).toMatch(/quoted DATA/);
      expect(d).not.toContain('jarvis_file_read on path="logs/day-narratives/');
    });

    it("the data block is the END of the description, after the S3 section (2026-10-03)", () => {
      const d = createMorningBriefing(
        "2026-04-21",
        "### Alertas S3\n- señal X",
        "# narrativa\n| 10:00 | a | b |\n",
      ).description;
      expect(d.endsWith("⟦END NARRATIVE⟧")).toBe(true);
      expect(d.indexOf("## Yesterday's narrative (DATA")).toBeGreaterThan(
        d.indexOf("- señal X"),
      );
      expect(d.indexOf("## Yesterday's narrative (DATA")).toBeGreaterThan(
        d.indexOf("## Email body format"),
      );
    });

    it("no narrative → the harness says so and the Ayer line is omitted", () => {
      const submission = createMorningBriefing("2026-04-21", "", null);
      expect(submission.description).toContain(
        "(`logs/day-narratives/2026-04-20.md`) does not exist",
      );
      expect(submission.description).not.toContain("⟦BEGIN NARRATIVE");
    });

    it("adds the '📋 Ayer' line to the brief template", () => {
      const submission = createMorningBriefing("2026-04-21");
      expect(submission.description).toMatch(/📋 Ayer/);
    });

    it("computes yesterday across a month boundary (non-leap Feb)", () => {
      const submission = createMorningBriefing("2026-03-01");
      expect(submission.description).toContain(
        "logs/day-narratives/2026-02-28.md",
      );
    });

    it("computes yesterday across a year boundary", () => {
      const submission = createMorningBriefing("2026-01-01");
      expect(submission.description).toContain(
        "logs/day-narratives/2025-12-31.md",
      );
    });
  });
});
