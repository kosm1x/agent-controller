import { describe, it, expect } from "vitest";
import {
  blackLitterman,
  blackLittermanFromSignals,
  equilibriumReturnsReverse,
  invertDiagonal,
  type AssetSignal,
} from "./black-litterman.js";
import { matMul, matIdentity, diagMatrix } from "./matrix.js";

const closeVec = (a: number[], b: number[], tol = 1e-9): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i]! - b[i]!) > tol) return false;
  }
  return true;
};

describe("invertDiagonal", () => {
  it("inverts each diagonal element", () => {
    expect(
      invertDiagonal([
        [2, 0, 0],
        [0, 4, 0],
        [0, 0, 5],
      ]),
    ).toEqual([
      [0.5, 0, 0],
      [0, 0.25, 0],
      [0, 0, 0.2],
    ]);
  });

  it("rejects matrices with non-zero off-diagonal entries", () => {
    expect(() =>
      invertDiagonal([
        [1, 0.5],
        [0.5, 1],
      ]),
    ).toThrow(/off-diagonal/);
  });

  it("rejects singular (zero on diagonal)", () => {
    expect(() =>
      invertDiagonal([
        [1, 0],
        [0, 0],
      ]),
    ).toThrow(/singular/);
  });
});

describe("blackLitterman — no-views path (K=0)", () => {
  it("returns the prior unchanged when no views are supplied", () => {
    const r = blackLitterman({
      assets: ["A", "B"],
      pi: [0.05, 0.07],
      Sigma: [
        [0.04, 0.01],
        [0.01, 0.09],
      ],
      P: [],
      Q: [],
      Omega: [],
    });
    expect(r.posteriorMu).toEqual([0.05, 0.07]);
    expect(r.posteriorSigma).toEqual([
      [0.04, 0.01],
      [0.01, 0.09],
    ]);
  });

  it("rejects K=0 with non-empty P", () => {
    expect(() =>
      blackLitterman({
        assets: ["A"],
        pi: [0.05],
        Sigma: [[0.04]],
        P: [[1]],
        Q: [],
        Omega: [],
      }),
    ).toThrow(/K=0 requires P/);
  });
});

describe("blackLitterman — single view", () => {
  it("posterior μ moves the targeted asset toward the view", () => {
    // Prior says both assets return 5%. View says asset 0 returns 10%
    // with high confidence — posterior μ[0] should land between 5% and 10%,
    // weighted by the view confidence vs. the prior strength.
    const r = blackLitterman({
      assets: ["A", "B"],
      pi: [0.05, 0.05],
      Sigma: [
        [0.04, 0.0],
        [0.0, 0.04],
      ],
      P: [[1, 0]], // view applies to asset 0 only
      Q: [0.1], // view: asset 0 returns 10%
      Omega: [[0.001]], // very tight uncertainty → high confidence
      tau: 0.05,
    });
    expect(r.posteriorMu[0]).toBeGreaterThan(0.05);
    expect(r.posteriorMu[0]).toBeLessThanOrEqual(0.1);
    // Asset 1 has zero correlation in Σ → barely moves.
    expect(Math.abs(r.posteriorMu[1]! - 0.05)).toBeLessThan(0.01);
  });

  it("low-confidence (high Ω) view barely moves the prior", () => {
    const tight = blackLitterman({
      assets: ["A"],
      pi: [0.05],
      Sigma: [[0.04]],
      P: [[1]],
      Q: [0.1],
      Omega: [[0.0001]], // tight uncertainty
      tau: 0.05,
    });
    const loose = blackLitterman({
      assets: ["A"],
      pi: [0.05],
      Sigma: [[0.04]],
      P: [[1]],
      Q: [0.1],
      Omega: [[100]], // huge uncertainty
      tau: 0.05,
    });
    // Tight view pulls posterior most of the way to Q; loose view barely moves.
    expect(Math.abs(tight.posteriorMu[0]! - 0.1)).toBeLessThan(
      Math.abs(loose.posteriorMu[0]! - 0.1),
    );
    expect(Math.abs(loose.posteriorMu[0]! - 0.05)).toBeLessThan(0.005);
  });

  it("posterior Σ exceeds prior Σ on the diagonal (views inject uncertainty)", () => {
    const r = blackLitterman({
      assets: ["A"],
      pi: [0.05],
      Sigma: [[0.04]],
      P: [[1]],
      Q: [0.1],
      Omega: [[0.01]],
      tau: 0.05,
    });
    expect(r.posteriorSigma[0]![0]).toBeGreaterThan(0.04);
  });
});

describe("blackLitterman — input validation", () => {
  const Sigma = [
    [0.04, 0.0],
    [0.0, 0.09],
  ];

  it("rejects empty asset universe", () => {
    expect(() =>
      blackLitterman({
        assets: [],
        pi: [],
        Sigma: [],
        P: [],
        Q: [],
        Omega: [],
      }),
    ).toThrow(/empty asset universe/);
  });

  it("rejects mismatched π length", () => {
    expect(() =>
      blackLitterman({
        assets: ["A", "B"],
        pi: [0.05],
        Sigma,
        P: [],
        Q: [],
        Omega: [],
      }),
    ).toThrow(/pi length/);
  });

  it("rejects non-square Σ", () => {
    expect(() =>
      blackLitterman({
        assets: ["A", "B"],
        pi: [0.05, 0.07],
        Sigma: [[0.04, 0.0]],
        P: [],
        Q: [],
        Omega: [],
      }),
    ).toThrow(/Sigma must be/);
  });

  it("rejects non-positive τ", () => {
    expect(() =>
      blackLitterman({
        assets: ["A"],
        pi: [0.05],
        Sigma: [[0.04]],
        P: [],
        Q: [],
        Omega: [],
        tau: 0,
      }),
    ).toThrow(/tau must be positive/);
  });

  it("rejects mismatched P shape", () => {
    expect(() =>
      blackLitterman({
        assets: ["A", "B"],
        pi: [0.05, 0.05],
        Sigma,
        P: [[1, 0, 0]], // 3 cols, but N=2
        Q: [0.1],
        Omega: [[0.01]],
      }),
    ).toThrow(/P must be/);
  });
});

describe("blackLittermanFromSignals", () => {
  const assets = ["A", "B", "C"];
  const pi = [0.05, 0.06, 0.04];
  const Sigma = [
    [0.04, 0.0, 0.0],
    [0.0, 0.09, 0.0],
    [0.0, 0.0, 0.01],
  ];

  it("filters signals with confidence ≤ 0", () => {
    const signals: AssetSignal[] = [
      { asset: "A", signal: 0.1, confidence: 0.8 },
      { asset: "B", signal: 0.2, confidence: 0 }, // dropped
      { asset: "C", signal: 0.05, confidence: -0.1 }, // dropped
    ];
    const r = blackLittermanFromSignals({ assets, pi, Sigma, signals });
    // A should move; B + C should stay near prior since their signals were filtered.
    expect(r.posteriorMu[0]).toBeGreaterThan(0.05);
    expect(Math.abs(r.posteriorMu[1]! - 0.06)).toBeLessThan(0.005);
    expect(Math.abs(r.posteriorMu[2]! - 0.04)).toBeLessThan(0.005);
  });

  it("filters signals for unknown assets", () => {
    const signals: AssetSignal[] = [
      { asset: "A", signal: 0.1, confidence: 0.8 },
      { asset: "Z", signal: 0.5, confidence: 0.9 }, // not in universe
    ];
    const r = blackLittermanFromSignals({ assets, pi, Sigma, signals });
    expect(r.posteriorMu).toHaveLength(3);
  });

  it("returns prior unchanged when no signals survive filtering", () => {
    const signals: AssetSignal[] = [
      { asset: "Z", signal: 0.1, confidence: 0.5 },
    ];
    const r = blackLittermanFromSignals({ assets, pi, Sigma, signals });
    expect(r.posteriorMu).toEqual(pi);
  });

  it("higher confidence pulls posterior closer to the signal", () => {
    const low = blackLittermanFromSignals({
      assets,
      pi,
      Sigma,
      signals: [{ asset: "A", signal: 0.2, confidence: 0.05 }],
      tau: 0.05,
    });
    const high = blackLittermanFromSignals({
      assets,
      pi,
      Sigma,
      signals: [{ asset: "A", signal: 0.2, confidence: 1.0 }],
      tau: 0.05,
    });
    // High-confidence posterior should move A's μ further toward 0.2 than low-confidence.
    expect(high.posteriorMu[0]! - 0.05).toBeGreaterThan(
      low.posteriorMu[0]! - 0.05,
    );
  });

  it("clamps confidence > 1 to 1 (does not produce negative Ω)", () => {
    const signals: AssetSignal[] = [{ asset: "A", signal: 0.1, confidence: 5 }];
    // Should not throw and should produce a finite posterior.
    const r = blackLittermanFromSignals({ assets, pi, Sigma, signals });
    expect(r.posteriorMu.every(Number.isFinite)).toBe(true);
  });

  it("ignores non-finite signal magnitude", () => {
    const signals: AssetSignal[] = [
      { asset: "A", signal: NaN, confidence: 0.5 },
      { asset: "B", signal: 0.1, confidence: 0.8 },
    ];
    const r = blackLittermanFromSignals({ assets, pi, Sigma, signals });
    // Only B's view should be applied.
    expect(Math.abs(r.posteriorMu[0]! - 0.05)).toBeLessThan(0.005);
    expect(r.posteriorMu[1]).toBeGreaterThan(0.06);
  });
});

describe("equilibriumReturnsReverse", () => {
  it("computes π = δ · Σ · w", () => {
    const Sigma = [
      [0.04, 0.0],
      [0.0, 0.09],
    ];
    const w = [0.6, 0.4];
    // δ·Σ·w = δ·[0.024, 0.036] = [0.06, 0.09] for δ=2.5
    const pi = equilibriumReturnsReverse(w, Sigma, 2.5);
    expect(closeVec(pi, [0.06, 0.09], 1e-12)).toBe(true);
  });

  it("scales linearly with risk aversion", () => {
    const Sigma = [
      [0.04, 0.0],
      [0.0, 0.09],
    ];
    const w = [0.5, 0.5];
    const pi1 = equilibriumReturnsReverse(w, Sigma, 1);
    const pi2 = equilibriumReturnsReverse(w, Sigma, 2);
    expect(
      closeVec(
        pi2,
        pi1.map((x) => 2 * x),
        1e-12,
      ),
    ).toBe(true);
  });

  it("rejects shape mismatches and non-finite δ", () => {
    expect(() => equilibriumReturnsReverse([], [], 2)).toThrow();
    expect(() => equilibriumReturnsReverse([1, 2], [[1]], 2)).toThrow();
    expect(() => equilibriumReturnsReverse([1], [[1]], NaN)).toThrow();
  });
});

describe("blackLitterman — non-diagonal Ω fallback (audit W6)", () => {
  it("accepts a non-diagonal Ω by falling back to full Gauss-Jordan", () => {
    // Slight off-diagonal correlation in view uncertainty — should NOT throw.
    const r = blackLitterman({
      assets: ["A", "B"],
      pi: [0.05, 0.06],
      Sigma: [
        [0.04, 0.0],
        [0.0, 0.09],
      ],
      P: [
        [1, 0],
        [0, 1],
      ],
      Q: [0.1, 0.07],
      Omega: [
        [0.01, 0.001], // off-diagonal correlation between view 0 and view 1
        [0.001, 0.01],
      ],
      tau: 0.05,
    });
    expect(r.posteriorMu.every(Number.isFinite)).toBe(true);
    expect(r.posteriorMu).toHaveLength(2);
  });
});

describe("blackLitterman — mutation discipline (audit W7)", () => {
  it("does not mutate the input Sigma on the views path", () => {
    const Sigma = [
      [0.04, 0.0],
      [0.0, 0.09],
    ];
    const before = JSON.stringify(Sigma);
    blackLitterman({
      assets: ["A", "B"],
      pi: [0.05, 0.06],
      Sigma,
      P: [[1, 0]],
      Q: [0.1],
      Omega: [[0.01]],
      tau: 0.05,
    });
    expect(JSON.stringify(Sigma)).toBe(before);
  });

  it("does not mutate the input Sigma on the no-views path", () => {
    const Sigma = [
      [0.04, 0.0],
      [0.0, 0.09],
    ];
    const before = JSON.stringify(Sigma);
    const r = blackLitterman({
      assets: ["A", "B"],
      pi: [0.05, 0.06],
      Sigma,
      P: [],
      Q: [],
      Omega: [],
    });
    expect(JSON.stringify(Sigma)).toBe(before);
    // Returned Σ is a deep copy — caller-side mutation does not affect input.
    r.posteriorSigma[0]![0] = 999;
    expect(Sigma[0]![0]).toBe(0.04);
  });
});

describe("equilibriumReturnsReverse — strict δ guard (audit W8)", () => {
  it("rejects negative δ", () => {
    expect(() =>
      equilibriumReturnsReverse(
        [0.5, 0.5],
        [
          [0.04, 0],
          [0, 0.09],
        ],
        -1,
      ),
    ).toThrow(/positive finite/);
  });
  it("rejects δ = 0", () => {
    expect(() =>
      equilibriumReturnsReverse(
        [0.5, 0.5],
        [
          [0.04, 0],
          [0, 0.09],
        ],
        0,
      ),
    ).toThrow(/positive finite/);
  });
});

describe("blackLitterman — sanity round-trip", () => {
  it("equilibriumReturnsReverse → blackLitterman with no views recovers the equilibrium", () => {
    const Sigma = [
      [0.04, 0.0, 0.0],
      [0.0, 0.09, 0.0],
      [0.0, 0.0, 0.01],
    ];
    const w = [0.4, 0.4, 0.2];
    const pi = equilibriumReturnsReverse(w, Sigma, 2.5);
    const r = blackLitterman({
      assets: ["A", "B", "C"],
      pi,
      Sigma,
      P: [],
      Q: [],
      Omega: [],
    });
    expect(closeVec(r.posteriorMu, pi)).toBe(true);
  });

  it("Σ × Σ⁻¹ via diag construction yields identity (sanity)", () => {
    const D = diagMatrix([2, 4, 5]);
    const Dinv = invertDiagonal(D);
    const I = matMul(D, Dinv);
    expect(I).toEqual(matIdentity(3));
  });
});
