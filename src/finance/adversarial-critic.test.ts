import { describe, it, expect, vi } from "vitest";
import {
  runAdversarialCritique,
  ADVERSARIAL_PROMPTS,
  type CritiqueInferFn,
} from "./adversarial-critic.js";

const mockInfer = (
  responses: { content: string; tokensUsed?: number }[],
): CritiqueInferFn => {
  let i = 0;
  return async () => {
    const r = responses[i] ?? responses[responses.length - 1]!;
    i++;
    return { content: r.content, tokensUsed: r.tokensUsed ?? 10 };
  };
};

describe("runAdversarialCritique — happy path", () => {
  it("calls bull, bear, and judge once each and returns the judged decision", async () => {
    const infer = vi.fn().mockImplementation(async (sys: string) => {
      if (sys.includes("bull-side"))
        return { content: "be more aggressive", tokensUsed: 12 };
      if (sys.includes("bear-side"))
        return { content: "be more cautious", tokensUsed: 11 };
      if (sys.includes("judge"))
        return { content: "HOLD with tighter stop", tokensUsed: 25 };
      throw new Error("unexpected role");
    });

    const r = await runAdversarialCritique({
      draft: "BUY 100 shares",
      context: "RSI 72, support holding",
      infer,
    });

    expect(infer).toHaveBeenCalledTimes(3);
    expect(r.bull).toBe("be more aggressive");
    expect(r.bear).toBe("be more cautious");
    expect(r.judged).toBe("HOLD with tighter stop");
    expect(r.failedOpen).toBe(false);
    expect(r.tokensUsed).toBe(48);
    expect(r.failureReason).toBeUndefined();
  });

  it("runs bull and bear in parallel (both started before either resolves)", async () => {
    const callTimes: { role: string; t: number }[] = [];
    const infer: CritiqueInferFn = async (sys) => {
      const role = sys.includes("bull-side")
        ? "bull"
        : sys.includes("bear-side")
          ? "bear"
          : "judge";
      callTimes.push({ role, t: Date.now() });
      // Each call takes 100ms. The parallelism assertion's 50ms margin
      // is wide enough to absorb realistic CI scheduler jitter — at 30ms
      // sleep + 25ms margin the gap was prone to flake under load
      // (audit W3).
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { content: `${role} reply`, tokensUsed: 5 };
    };

    await runAdversarialCritique({
      draft: "BUY",
      infer,
    });

    const bullStart = callTimes.find((c) => c.role === "bull")!.t;
    const bearStart = callTimes.find((c) => c.role === "bear")!.t;
    const judgeStart = callTimes.find((c) => c.role === "judge")!.t;
    // bull and bear started effectively concurrently (< 50ms gap)
    expect(Math.abs(bearStart - bullStart)).toBeLessThan(50);
    // judge started AFTER bull/bear settled (≥ 80ms after bull start;
    // 100ms call - 20ms slack)
    expect(judgeStart - bullStart).toBeGreaterThanOrEqual(80);
  });

  it("forwards different infer fns for each role when overrides are provided", async () => {
    const bullCalls: string[] = [];
    const bearCalls: string[] = [];
    const judgeCalls: string[] = [];

    const r = await runAdversarialCritique({
      draft: "BUY",
      infer: async () => ({ content: "fallback", tokensUsed: 1 }),
      bullInfer: async (sys) => {
        bullCalls.push(sys);
        return { content: "bull", tokensUsed: 1 };
      },
      bearInfer: async (sys) => {
        bearCalls.push(sys);
        return { content: "bear", tokensUsed: 1 };
      },
      judgeInfer: async (sys) => {
        judgeCalls.push(sys);
        return { content: "judged", tokensUsed: 1 };
      },
    });

    expect(bullCalls).toHaveLength(1);
    expect(bearCalls).toHaveLength(1);
    expect(judgeCalls).toHaveLength(1);
    expect(r.judged).toBe("judged");
  });
});

describe("runAdversarialCritique — fail-open paths", () => {
  it("falls back to draft when the bull call throws AND preserves bear's tokens (audit C1)", async () => {
    const infer: CritiqueInferFn = async (sys) => {
      if (sys.includes("bull-side")) throw new Error("bull provider down");
      // Bear succeeds and reports 7 tokens. Promise.allSettled (not
      // Promise.all) must capture this even though the run fails open.
      return { content: "bear ok", tokensUsed: 7 };
    };
    const r = await runAdversarialCritique({ draft: "BUY 100", infer });
    expect(r.failedOpen).toBe(true);
    expect(r.judged).toBe("BUY 100");
    expect(r.failureReason).toMatch(/bull/);
    // Bear's tokens were charged before bull failed; cost ledger must reflect.
    expect(r.tokensUsed).toBe(7);
    expect(r.bear).toBe("bear ok");
  });

  it("falls back to draft when the bear call throws", async () => {
    const infer: CritiqueInferFn = async (sys) => {
      if (sys.includes("bear-side")) throw new Error("bear provider down");
      return { content: "fine", tokensUsed: 5 };
    };
    const r = await runAdversarialCritique({ draft: "SELL 50", infer });
    expect(r.failedOpen).toBe(true);
    expect(r.judged).toBe("SELL 50");
    expect(r.failureReason).toMatch(/bear/);
  });

  it("falls back to draft when the judge call throws (still preserves bull/bear text)", async () => {
    const infer: CritiqueInferFn = async (sys) => {
      if (sys.includes("bull-side"))
        return { content: "more aggressive", tokensUsed: 5 };
      if (sys.includes("bear-side"))
        return { content: "more cautious", tokensUsed: 5 };
      throw new Error("judge timed out");
    };
    const r = await runAdversarialCritique({ draft: "HOLD", infer });
    expect(r.failedOpen).toBe(true);
    expect(r.judged).toBe("HOLD");
    expect(r.bull).toBe("more aggressive");
    expect(r.bear).toBe("more cautious");
    expect(r.failureReason).toMatch(/judge/);
    // Token cost from bull + bear was charged before the judge died.
    expect(r.tokensUsed).toBe(10);
  });

  it("falls back to draft when judge returns empty content", async () => {
    const infer: CritiqueInferFn = async (sys) => {
      if (sys.includes("bull-side")) return { content: "x", tokensUsed: 1 };
      if (sys.includes("bear-side")) return { content: "y", tokensUsed: 1 };
      return { content: "   ", tokensUsed: 5 };
    };
    const r = await runAdversarialCritique({ draft: "BUY", infer });
    expect(r.failedOpen).toBe(true);
    expect(r.judged).toBe("BUY");
    expect(r.failureReason).toMatch(/empty/);
  });

  it("respects per-call timeoutMs and fails open on timeout", async () => {
    const slow: CritiqueInferFn = (sys) =>
      new Promise((resolve) =>
        setTimeout(
          () => resolve({ content: sys.slice(0, 4), tokensUsed: 1 }),
          100,
        ),
      );
    const r = await runAdversarialCritique({
      draft: "BUY",
      infer: slow,
      options: { timeoutMs: 10 },
    });
    expect(r.failedOpen).toBe(true);
    expect(r.judged).toBe("BUY");
    expect(r.failureReason).toMatch(/timed out/);
  });
});

describe("runAdversarialCritique — input validation", () => {
  it("throws on empty draft", async () => {
    const infer = mockInfer([{ content: "x" }]);
    await expect(runAdversarialCritique({ draft: "", infer })).rejects.toThrow(
      /empty draft/,
    );
    await expect(
      runAdversarialCritique({ draft: "   ", infer }),
    ).rejects.toThrow(/empty draft/);
  });

  it("falls back to default no-context message when none provided", async () => {
    let observedJudgeUser = "";
    const infer: CritiqueInferFn = async (sys, user) => {
      if (sys.includes("judge")) observedJudgeUser = user;
      return { content: sys.slice(0, 4), tokensUsed: 1 };
    };
    await runAdversarialCritique({ draft: "BUY", infer });
    // Judge is shown the SAME context placeholder when none provided.
    expect(observedJudgeUser).toContain("(no additional context provided)");
  });
});

describe("ADVERSARIAL_PROMPTS — exposed for inspection / tuning", () => {
  it("exports the three system prompts as constants", () => {
    expect(ADVERSARIAL_PROMPTS.bullSystem).toContain("bull-side");
    expect(ADVERSARIAL_PROMPTS.bearSystem).toContain("bear-side");
    expect(ADVERSARIAL_PROMPTS.judgeSystem).toContain("judge");
  });
});
