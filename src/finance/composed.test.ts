/**
 * v7.6 Spine 6 — L4-L6 composed pipeline smoke test.
 *
 * Each of the four library modules (HRP, BM25 reflection memory, adversarial
 * critique, Black-Litterman) ships green at the unit level. This file proves
 * they speak to each other end-to-end without runtime explosions and pins the
 * type contract at every module boundary.
 *
 * Anti-mission per V7.6-GUIDE.md:154-163: this is NOT a runner wire-up.
 * No new code paths, no new integrations beyond the test itself. Catches API
 * drift between modules that unit tests miss.
 *
 * **Aspirational contract caveat (round-1 audit W4)**: as of v7.6-Spine-6, no
 * production caller wires HRP → equilibriumReturnsReverse → BL anywhere in
 * `src/`. The flow asserted here is what the F7 runner WOULD wire when it
 * ships; until then this test is pinning a target contract, not catching
 * drift in a real producer/consumer pair. When F7 lands, either (a) update
 * this test to import the real F7 runner output, or (b) delete it as
 * superseded by the runner's own integration tests.
 *
 * The composed flow exercises the textbook hand-off:
 *
 *     synthetic returns matrix
 *           │
 *           ▼
 *     ┌─────────────┐         ┌────────────────────────────┐
 *     │ HRP weights │ ──────► │ equilibriumReturnsReverse  │  → π (BL prior)
 *     └─────────────┘         └────────────────────────────┘
 *           │                              │
 *           ▼                              ▼
 *     ┌──────────────────┐    ┌────────────────────────┐
 *     │ BM25 reflection  │    │ adversarial critique   │
 *     │   retrieve top-K │    │ (bull/bear/judge stub) │
 *     └──────────────────┘    └────────────────────────┘
 *                                         │
 *                                         ▼
 *                             ┌──────────────────────────┐
 *                             │ AssetSignals → BL combine│
 *                             └──────────────────────────┘
 *                                         │
 *                                         ▼
 *                             posteriorMu + posteriorSigma
 *
 * Hermetic: no real LLM calls (stub `infer`), no DB, no network. Re-runs
 * deterministically.
 */

import { describe, it, expect } from "vitest";
import { hierarchicalRiskParity } from "./hrp.js";
import { covarianceMatrix } from "./allocators.js";
import {
  createBank,
  addLesson,
  retrieveTop,
  formatLessonsBlock,
  bankSize,
  type ReflectionEntry,
  type ReflectionBank,
} from "./reflection-memory.js";
import {
  runAdversarialCritique,
  type CritiqueInferFn,
  type AdversarialCritiqueResult,
} from "./adversarial-critic.js";
import {
  blackLittermanFromSignals,
  equilibriumReturnsReverse,
  type AssetSignal,
  type BlackLittermanResult,
} from "./black-litterman.js";

/**
 * Build a synthetic T×N returns matrix with two correlation clusters so HRP's
 * recursive bisection has structure to find. Deterministic — same trig
 * functions every run, no randomness.
 */
function syntheticReturns(T: number): number[][] {
  const out: number[][] = [];
  for (let t = 0; t < T; t++) {
    // Cluster 1: AAPL/MSFT — co-move on first sine wave
    const c1 = Math.sin(t * 0.3) * 0.02;
    // Cluster 2: NVDA/TSLA — co-move on shifted cosine
    const c2 = Math.cos(t * 0.4) * 0.025;
    // Per-asset idiosyncratic noise — small enough to keep clusters intact
    out.push([
      c1 + 0.001 * (t % 2),
      c1 - 0.001 * (t % 2),
      c2 + 0.002 * ((t % 3) - 1),
      c2 - 0.002 * ((t % 3) - 1),
    ]);
  }
  return out;
}

describe("v7.6 Spine 6 — L4-L6 composed pipeline smoke test", () => {
  it("threads synthetic returns through HRP → BM25 → adversarial → Black-Litterman with intact type contracts", async () => {
    // -----------------------------------------------------------------
    // Stage 1 — HRP: synthetic returns → cluster-aware portfolio weights
    // -----------------------------------------------------------------
    const assets: readonly string[] = ["AAPL", "MSFT", "NVDA", "TSLA"];
    const N = assets.length;
    const T = 60;
    const returns = syntheticReturns(T);
    expect(returns).toHaveLength(T);
    expect(returns[0]).toHaveLength(N);

    const hrpWeights: number[] = hierarchicalRiskParity(returns);

    // Boundary contract: HRP must return N non-negative weights summing to 1
    expect(hrpWeights).toHaveLength(N);
    expect(hrpWeights.every((w) => Number.isFinite(w))).toBe(true);
    expect(hrpWeights.every((w) => w >= 0)).toBe(true);
    const wsum = hrpWeights.reduce((a, b) => a + b, 0);
    expect(wsum).toBeCloseTo(1.0, 6);

    // -----------------------------------------------------------------
    // Stage 2 — Build BL prior from HRP weights via equilibriumReturnsReverse
    //           Pins the HRP→BL hand-off shape. Uses `covarianceMatrix`
    //           from allocators.ts so the cov estimator is single-source —
    //           round-1 audit W3 fix (no inline cov math in tests).
    // -----------------------------------------------------------------
    const Sigma: number[][] = covarianceMatrix(returns);
    expect(Sigma).toHaveLength(N);
    expect(Sigma[0]).toHaveLength(N);
    // Σ must be symmetric (contract for BL inputs)
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        expect(Sigma[i]![j]).toBeCloseTo(Sigma[j]![i]!, 12);
      }
    }

    const pi: number[] = equilibriumReturnsReverse(hrpWeights, Sigma, 2.5);

    // Boundary contract: π has length N, all finite
    expect(pi).toHaveLength(N);
    expect(pi.every((p) => Number.isFinite(p))).toBe(true);

    // -----------------------------------------------------------------
    // Stage 3 — BM25 reflection memory: index past lessons, retrieve relevant
    // -----------------------------------------------------------------
    const bank: ReflectionBank = createBank("composed-pm");
    expect(bankSize(bank)).toBe(0);

    const pastLessons: ReflectionEntry[] = [
      {
        situation:
          "AAPL earnings beat with strong iPhone guidance after weak quarter",
        lesson:
          "Post-earnings guidance changes drive multi-day momentum, hold 3-5 days",
        pnl: 1500,
        ts: 1_700_000_000_000, // fixed epoch — keeps test fully deterministic
      },
      {
        situation:
          "NVDA datacenter revenue beat but margin compression flagged",
        lesson:
          "Margin compression matters more than revenue beats in late-cycle semis",
        pnl: -800,
        ts: 1_700_500_000_000,
      },
      {
        situation: "TSLA delivery miss in late Q4 with macro headwinds",
        lesson:
          "Delivery numbers signal demand inflection — cut size on 2-std beat",
        pnl: -1200,
        ts: 1_701_000_000_000,
      },
    ];
    for (const e of pastLessons) addLesson(bank, e);
    expect(bankSize(bank)).toBe(pastLessons.length);

    const tradingContext = "AAPL upcoming earnings with iPhone guidance focus";
    const retrieved: ReflectionEntry[] = retrieveTop(bank, tradingContext, 2);

    // Boundary contract: BM25 returns ≤ K entries with positive scores
    expect(retrieved.length).toBeGreaterThan(0);
    expect(retrieved.length).toBeLessThanOrEqual(2);
    // Sanity: AAPL/iPhone lesson must surface for an AAPL/iPhone query
    expect(retrieved[0]!.situation.toLowerCase()).toContain("aapl");

    // Round-2 audit W10: lessonsBlock is NOT consumed downstream after the
    // W5 fix dropped it from `context`. We still call formatLessonsBlock
    // and assert on its shape because it pins the L6→prompt-injection
    // contract for any FUTURE caller that wants to use lessons in a
    // sanitized prompt-injection channel (separate from adversarial
    // critique). If `formatLessonsBlock` is renamed or its output shape
    // changes, this test fails loudly even though the composed pipeline
    // doesn't consume the block.
    const lessonsBlock: string = formatLessonsBlock("composed-pm", retrieved);
    expect(lessonsBlock).toContain("Past lessons for composed-pm");
    expect(lessonsBlock).toContain("Post-earnings");

    // -----------------------------------------------------------------
    // Stage 4 — Adversarial bull/bear/judge with hermetic stub `infer`
    //
    // **Trust-model invariant (round-1 audit W5, round-2 audit W8)**: the
    // `context` field on `runAdversarialCritique` is interpolated VERBATIM
    // into all three role prompts (see adversarial-critic.ts:42-51). The
    // safety property is "no user-controlled bytes can flow into context."
    // The static English label "Prior π for AAPL:" below is operator-authored
    // in this test file — it is NOT user input, so it cannot carry a prompt
    // injection. Only `pi[0]` (a deterministic float derived from synthetic
    // returns) is dynamic, and floats cannot encode prompt-injection payloads.
    // We deliberately do NOT pass `lessonsBlock` into `context` even though
    // Stage 3 retrieved lessons. If a future F7 wire-up wants lessons to
    // influence the critique, it must sanitize them or attach them via a
    // channel that doesn't bleed into the verbatim-interpolated context.
    // -----------------------------------------------------------------
    let inferCalls = 0;
    const seenSystemPrompts: string[] = [];
    const stubInfer: CritiqueInferFn = async (sys, _user) => {
      inferCalls += 1;
      seenSystemPrompts.push(sys);
      // Identify role by the system-prompt tail to keep the stub
      // robust to wording tweaks in adversarial-critic.ts.
      let content: string;
      if (sys.includes("bull-side")) {
        content = "AAPL guidance beats historically drive 5-7% pops; size up.";
      } else if (sys.includes("bear-side")) {
        content =
          "Macro tape choppy; iPhone TAM matures; trim risk into the print.";
      } else {
        // Judge
        content =
          "BUY AAPL with confidence 0.5, conditional on guidance > consensus.";
      }
      return { content, tokensUsed: 100 };
    };

    const draft = "BUY AAPL with confidence 0.7 ahead of earnings";
    const safeContext = `Prior π for AAPL: ${pi[0]!.toFixed(4)}`;
    const critique: AdversarialCritiqueResult = await runAdversarialCritique({
      draft,
      context: safeContext,
      infer: stubInfer,
    });

    // Boundary contract: critique result must populate every field shape
    expect(typeof critique.bull).toBe("string");
    expect(typeof critique.bear).toBe("string");
    expect(typeof critique.judged).toBe("string");
    expect(critique.bull.length).toBeGreaterThan(0);
    expect(critique.bear.length).toBeGreaterThan(0);
    expect(critique.judged.length).toBeGreaterThan(0);
    expect(critique.tokensUsed).toBe(300); // 3 calls × 100
    expect(critique.failedOpen).toBe(false);
    expect(critique.failureReason).toBeUndefined();
    expect(inferCalls).toBe(3);
    // The stub must have seen exactly one bull, one bear, one judge prompt
    const bullSeen = seenSystemPrompts.filter((s) => s.includes("bull-side"));
    const bearSeen = seenSystemPrompts.filter((s) => s.includes("bear-side"));
    const judgeSeen = seenSystemPrompts.filter((s) =>
      s.includes("investment judge"),
    );
    expect(bullSeen).toHaveLength(1);
    expect(bearSeen).toHaveLength(1);
    expect(judgeSeen).toHaveLength(1);

    // -----------------------------------------------------------------
    // Stage 5 — Black-Litterman: synthesize AssetSignals from the judged
    //           decision and combine with the BL prior. In production an
    //           LLM extractor would parse `critique.judged` into typed
    //           signals; the test synthesizes them deterministically.
    //
    // Use a SINGLE positive view (AAPL) so the monotonicity assertion is a
    // BL math guarantee, not a numeric coincidence (round-1 audit W1 fix).
    // The two-view shape is asserted in the second `it()` block so the
    // monotonicity test isn't entangled with cross-view interactions.
    // -----------------------------------------------------------------
    const signals: AssetSignal[] = [
      // Single-view: positive AAPL, mid confidence
      { asset: "AAPL", signal: 0.04, confidence: 0.5 },
    ];

    const blResult: BlackLittermanResult = blackLittermanFromSignals({
      assets,
      pi,
      Sigma,
      signals,
    });

    // Boundary contract: posteriorMu length N, posteriorSigma N×N, all finite
    expect(blResult.posteriorMu).toHaveLength(N);
    expect(blResult.posteriorSigma).toHaveLength(N);
    for (const row of blResult.posteriorSigma) expect(row).toHaveLength(N);
    expect(blResult.posteriorMu.every((m) => Number.isFinite(m))).toBe(true);
    for (const row of blResult.posteriorSigma) {
      expect(row.every((v) => Number.isFinite(v))).toBe(true);
    }

    // BL math guarantee: a single one-hot positive view on asset k pulls
    // posteriorMu[k] toward (Q - π[k]), so posteriorMu[k] > π[k] when Q > π[k].
    // Q here is +0.04 vs π[AAPL] which is small positive — so posterior > prior.
    const aaplIdx = assets.indexOf("AAPL");
    expect(blResult.posteriorMu[aaplIdx]!).toBeGreaterThan(pi[aaplIdx]!);

    // posteriorSigma must remain symmetric (BL adds inv(M) to symmetric Σ)
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        expect(blResult.posteriorSigma[i]![j]!).toBeCloseTo(
          blResult.posteriorSigma[j]![i]!,
          10,
        );
      }
    }

    // -----------------------------------------------------------------
    // Stage 6 — Cross-stage shape: every module's output is non-degenerate
    //           and threads into the next without exception. Per-field
    //           assertions above already cover the substantive type
    //           contracts; round-1 audit S1 dropped the bundle-authored
    //           `composedOutput` shape pin since it asserted only that the
    //           test agreed with itself.
    // -----------------------------------------------------------------
    expect(hrpWeights.length).toBe(N);
    expect(retrieved.length).toBeGreaterThan(0);
    expect(critique.judged).toBeTruthy();
    expect(blResult.posteriorMu.length).toBe(N);
  });

  it("two non-orthogonal views combine without exploding the type contract", async () => {
    // Separate from the monotonicity test (round-1 audit W1) so the
    // multi-view path is exercised without claiming a math guarantee that
    // depends on cross-view orthogonality. We assert SHAPE and FINITENESS
    // only — sign-of-update for the second view depends on Σ off-diagonals
    // that aren't a BL invariant.
    const assets: readonly string[] = ["AAPL", "MSFT", "NVDA", "TSLA"];
    const N = assets.length;
    const returns = syntheticReturns(60);
    const hrpWeights = hierarchicalRiskParity(returns);
    const Sigma = covarianceMatrix(returns);
    const pi = equilibriumReturnsReverse(hrpWeights, Sigma, 2.5);

    const signals: AssetSignal[] = [
      { asset: "AAPL", signal: 0.04, confidence: 0.5 },
      { asset: "NVDA", signal: -0.01, confidence: 0.3 },
    ];

    const blResult = blackLittermanFromSignals({
      assets,
      pi,
      Sigma,
      signals,
    });

    expect(blResult.posteriorMu).toHaveLength(N);
    expect(blResult.posteriorMu.every((m) => Number.isFinite(m))).toBe(true);
    expect(blResult.posteriorSigma).toHaveLength(N);
    for (const row of blResult.posteriorSigma) {
      expect(row).toHaveLength(N);
      expect(row.every((v) => Number.isFinite(v))).toBe(true);
    }
  });

  it("composed pipeline degrades gracefully when adversarial critique fails open", async () => {
    // Cross-module robustness check: if one stage fails (here, adversarial
    // throws on bull side), the failure shape is well-defined and downstream
    // BL still receives a valid AssetSignal[].
    const assets: readonly string[] = ["AAPL", "MSFT"];
    const returns = syntheticReturns(40).map((r) => [r[0]!, r[1]!]);
    const hrpWeights = hierarchicalRiskParity(returns);
    const Sigma = covarianceMatrix(returns);
    const pi = equilibriumReturnsReverse(hrpWeights, Sigma, 2.5);

    let calls = 0;
    const failingInfer: CritiqueInferFn = async (sys) => {
      calls += 1;
      if (sys.includes("bull-side")) {
        throw new Error("synthetic bull failure");
      }
      return { content: "stub", tokensUsed: 50 };
    };

    const draft = "HOLD AAPL pending earnings";
    const critique = await runAdversarialCritique({
      draft,
      context: `pi[0] = ${pi[0]!.toFixed(4)}`,
      infer: failingInfer,
    });

    // Failure shape contract: judged falls back to draft, failedOpen=true,
    // failureReason populated AND identifies the bull side as the failing
    // role (round-2 audit W9 — pins WHICH side failed, not just that some
    // side failed). adversarial-critic.ts:202 builds the message as
    // `bull/bear stage: ${failed.join("; ")}` so a regression that swaps
    // "bull" for "bear" or drops the role tag would fail this assertion.
    expect(critique.failedOpen).toBe(true);
    expect(critique.judged).toBe(draft);
    expect(typeof critique.failureReason).toBe("string");
    expect(critique.failureReason!.length).toBeGreaterThan(0);
    expect(critique.failureReason).toContain("bull");
    expect(critique.failureReason).toContain("synthetic bull failure");
    // Exact-equality (round-1 audit W2): bull throws + bear succeeds via
    // Promise.allSettled, then the function early-returns at line ~196 of
    // adversarial-critic.ts. Judge is never invoked. A regression that
    // retries bull or bypasses the early-return would push calls above 2
    // and we want that to fail loudly here.
    expect(calls).toBe(2);

    // BL is unaffected by upstream failure-open — it just sees AssetSignals.
    const signals: AssetSignal[] = [
      { asset: "AAPL", signal: 0.0, confidence: 0.1 },
    ];
    const blResult = blackLittermanFromSignals({
      assets,
      pi,
      Sigma,
      signals,
    });
    expect(blResult.posteriorMu).toHaveLength(2);
    expect(blResult.posteriorMu.every((m) => Number.isFinite(m))).toBe(true);
  });
});
