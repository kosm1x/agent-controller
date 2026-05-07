import { describe, it, expect, vi } from "vitest";
import {
  runSkillEval,
  recommend,
  type SkillEvalCase,
  type SkillEvalInferFn,
} from "./skill-eval-loop.js";

const cs = (id: string, message: string, evidence: string): SkillEvalCase => ({
  id,
  message,
  assertions: [{ text: `output should mention ${evidence}`, evidence }],
});

describe("runSkillEval", () => {
  it("scores baseline 0 and with-skill 1 when the skill injects the keyword", async () => {
    const cases = [cs("c1", "describe a fox", "quick")];
    const inferFn: SkillEvalInferFn = async (sys) => ({
      // The skill arm prepends "use the word quick" to the system prompt.
      content: sys.includes("quick") ? "the quick fox" : "the fox",
      tokensUsed: 5,
    });

    const r = await runSkillEval(
      "use the word quick",
      "you describe animals",
      cases,
      inferFn,
    );

    expect(r.baseline).toBe(0);
    expect(r.withSkill).toBe(1);
    expect(r.delta).toBe(1);
    expect(r.improved).toBe(1);
    expect(r.regressed).toBe(0);
    expect(r.unchanged).toBe(0);
    // Single-case win: confidence downgrade kicks in (n < 3).
    expect(r.recommendation).toBe("refine");
  });

  it("recommends adopt when 3+ cases improve uniformly with no regressions", async () => {
    const cases = [
      cs("c1", "x", "alpha"),
      cs("c2", "y", "beta"),
      cs("c3", "z", "gamma"),
    ];
    const inferFn: SkillEvalInferFn = async (sys, msg) => {
      // With-skill arm: every requested keyword is injected.
      const content = sys.includes("KEYWORD")
        ? `output for ${msg}: alpha beta gamma`
        : `bare output for ${msg}`;
      return { content, tokensUsed: 10 };
    };
    const r = await runSkillEval(
      "KEYWORD inject all of: alpha, beta, gamma",
      "system",
      cases,
      inferFn,
    );
    expect(r.improved).toBe(3);
    expect(r.regressed).toBe(0);
    expect(r.delta).toBe(1);
    expect(r.recommendation).toBe("adopt");
  });

  it("recommends reject when more cases regress than improve", async () => {
    const cases = [
      cs("c1", "x", "alpha"),
      cs("c2", "y", "beta"),
      cs("c3", "z", "gamma"),
    ];
    // Skill makes things worse: baseline gets keywords, with-skill loses them.
    const inferFn: SkillEvalInferFn = async (sys, msg) => ({
      content: sys.includes("HARMFUL")
        ? `bare ${msg}`
        : `${msg}: alpha beta gamma`,
      tokensUsed: 10,
    });
    const r = await runSkillEval("HARMFUL", "sys", cases, inferFn);
    expect(r.improved).toBe(0);
    expect(r.regressed).toBe(3);
    expect(r.recommendation).toBe("reject");
  });

  it("recommends refine when net positive but at least one case regresses", async () => {
    const cases = [
      cs("c1", "good", "alpha"),
      cs("c2", "good", "beta"),
      cs("c3", "good", "gamma"),
      cs("c4", "BAD", "delta"),
    ];
    const inferFn: SkillEvalInferFn = async (sys, msg) => {
      // Three cases improve under the skill; one regresses (delta-loss).
      if (sys.includes("MIXED")) {
        if (msg.includes("BAD")) return { content: "no kw", tokensUsed: 5 };
        return { content: "alpha beta gamma", tokensUsed: 5 };
      }
      // Baseline: c4 has the keyword, c1-c3 don't.
      if (msg.includes("BAD")) return { content: "delta!", tokensUsed: 5 };
      return { content: "no kw", tokensUsed: 5 };
    };
    const r = await runSkillEval("MIXED", "sys", cases, inferFn);
    expect(r.improved).toBe(3);
    expect(r.regressed).toBe(1);
    expect(r.delta).toBeGreaterThan(0);
    expect(r.recommendation).toBe("refine");
  });

  it("recommends discard when delta is below 0.05 with no regressions", async () => {
    // 4 cases, with-skill scores exactly 0.04 higher on average → discard.
    const cases: SkillEvalCase[] = [
      {
        id: "c1",
        message: "m",
        assertions: [
          { text: "a", evidence: "AAA" },
          { text: "b", evidence: "BBB" },
          { text: "c", evidence: "CCC" },
          { text: "d", evidence: "DDD" },
          { text: "e", evidence: "EEE" },
        ],
      },
      {
        id: "c2",
        message: "m",
        assertions: [
          { text: "a", evidence: "AAA" },
          { text: "b", evidence: "BBB" },
          { text: "c", evidence: "CCC" },
          { text: "d", evidence: "DDD" },
          { text: "e", evidence: "EEE" },
        ],
      },
    ];
    let toggle = false;
    const inferFn: SkillEvalInferFn = async (sys) => {
      // Baseline outputs hit 4/5 keywords; with-skill hits 4/5 too most of
      // the time, occasionally 5/5 — net delta 0.04, no regressions.
      const isSkill = sys.includes("MARGINAL");
      toggle = !toggle;
      if (isSkill && toggle) {
        return { content: "AAA BBB CCC DDD EEE", tokensUsed: 5 };
      }
      return { content: "AAA BBB CCC DDD missing", tokensUsed: 5 };
    };
    const r = await runSkillEval("MARGINAL", "sys", cases, inferFn);
    // Net positive but tiny → discard.
    expect(r.delta).toBeLessThan(0.05);
    expect(r.regressed).toBe(0);
    expect(r.recommendation).toBe("discard");
  });

  it("returns assertion details for both arms (so callers can debug)", async () => {
    const cases: SkillEvalCase[] = [
      {
        id: "c1",
        message: "describe",
        assertions: [
          { text: "mentions fox", evidence: "fox" },
          { text: "mentions cat", evidence: /\bcat\b/i },
        ],
      },
    ];
    const inferFn: SkillEvalInferFn = async (sys) => ({
      content: sys.includes("INJECT") ? "fox and cat" : "just a fox",
      tokensUsed: 3,
    });
    const r = await runSkillEval("INJECT", "sys", cases, inferFn);
    const baseline = r.perCase[0].baselineAssertions;
    const skill = r.perCase[0].withSkillAssertions;
    expect(baseline[0].passed).toBe(true); // fox
    expect(baseline[1].passed).toBe(false); // cat absent
    expect(skill[0].passed).toBe(true);
    expect(skill[1].passed).toBe(true);
    // Regex evidence is stringified for serialisation.
    expect(skill[1].evidence).toMatch(/^\/\\bcat\\b/);
  });

  it("handles empty cases with safe defaults (no division-by-zero)", async () => {
    const inferFn = vi.fn();
    const r = await runSkillEval("s", "sys", [], inferFn);
    expect(r.baseline).toBe(0);
    expect(r.withSkill).toBe(0);
    expect(r.delta).toBe(0);
    expect(r.perCase).toEqual([]);
    expect(inferFn).not.toHaveBeenCalled();
  });

  it("counts tokensUsed and callsTotal across both arms", async () => {
    const cases = [cs("c1", "x", "y"), cs("c2", "x", "y")];
    const inferFn: SkillEvalInferFn = async () => ({
      content: "y",
      tokensUsed: 7,
    });
    const r = await runSkillEval("s", "sys", cases, inferFn);
    expect(r.tokensUsed).toBe(2 * 2 * 7); // 2 cases * 2 arms * 7 tokens
    expect(r.callsTotal).toBe(4); // 2 cases * 2 arms
  });

  it("surfaces emptyCaseIds for cases with zero assertions (audit W4)", async () => {
    const cases: SkillEvalCase[] = [
      { id: "c1", message: "ok", assertions: [{ text: "a", evidence: "y" }] },
      { id: "blank", message: "msg", assertions: [] },
      cs("c2", "ok", "y"),
    ];
    const inferFn: SkillEvalInferFn = async () => ({
      content: "y",
      tokensUsed: 1,
    });
    const r = await runSkillEval("s", "sys", cases, inferFn);
    expect(r.emptyCaseIds).toEqual(["blank"]);
    // Empty case still scores 1.0 in both arms — delta=0, doesn't pollute
    // the per-case improvement signal beyond pulling the unchanged counter.
    expect(r.perCase.find((p) => p.caseId === "blank")?.delta).toBe(0);
  });

  it("appends the skill to baseline system prompt for the with-skill arm", async () => {
    const observedSystems: string[] = [];
    const cases = [cs("c1", "msg", "kw")];
    const inferFn: SkillEvalInferFn = async (sys) => {
      observedSystems.push(sys);
      return { content: "kw", tokensUsed: 1 };
    };
    await runSkillEval("THE-SKILL", "BASE-SYS", cases, inferFn);
    expect(observedSystems[0]).toBe("BASE-SYS");
    expect(observedSystems[1]).toBe("BASE-SYS\n\nTHE-SKILL");
  });
});

describe("recommend (heuristic)", () => {
  it("rejects when regressions outnumber improvements", () => {
    expect(recommend(0.5, 0.5, 1, 4, 5)).toBe("reject");
  });
  it("discards when delta below 0.05", () => {
    expect(recommend(0.5, 0.53, 4, 0, 4)).toBe("discard");
  });
  it("refines when net positive but at least one regression", () => {
    expect(recommend(0.4, 0.7, 3, 1, 4)).toBe("refine");
  });
  it("adopts when delta significant and no regressions, n>=3", () => {
    expect(recommend(0.4, 0.8, 5, 0, 5)).toBe("adopt");
  });
  it("downgrades adopt → refine when sample size is below 3", () => {
    expect(recommend(0.4, 0.9, 2, 0, 2)).toBe("refine");
  });
  it("does NOT downgrade discard for small samples (already conservative)", () => {
    expect(recommend(0.5, 0.52, 1, 0, 1)).toBe("discard");
  });
});
