import { describe, it, expect } from "vitest";
import {
  matIdentity,
  matAdd,
  matTranspose,
  matMul,
  matVecMul,
  matInverse,
  diagMatrix,
} from "./matrix.js";

const closeMatrix = (A: number[][], B: number[][], tol = 1e-9): boolean => {
  if (A.length !== B.length) return false;
  for (let i = 0; i < A.length; i++) {
    if (A[i]!.length !== B[i]!.length) return false;
    for (let j = 0; j < A[i]!.length; j++) {
      if (Math.abs(A[i]![j]! - B[i]![j]!) > tol) return false;
    }
  }
  return true;
};

describe("matIdentity", () => {
  it("produces an N×N identity", () => {
    expect(matIdentity(3)).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
  });
  it("rejects non-positive integer N", () => {
    expect(() => matIdentity(0)).toThrow();
    expect(() => matIdentity(-2)).toThrow();
    expect(() => matIdentity(2.5)).toThrow();
  });
});

describe("matAdd", () => {
  it("adds element-wise", () => {
    expect(
      matAdd(
        [
          [1, 2],
          [3, 4],
        ],
        [
          [10, 20],
          [30, 40],
        ],
      ),
    ).toEqual([
      [11, 22],
      [33, 44],
    ]);
  });
  it("rejects shape mismatch", () => {
    expect(() =>
      matAdd(
        [
          [1, 2],
          [3, 4],
        ],
        [[1, 2, 3]],
      ),
    ).toThrow();
  });
});

describe("matTranspose", () => {
  it("transposes a 2×3 to a 3×2", () => {
    expect(
      matTranspose([
        [1, 2, 3],
        [4, 5, 6],
      ]),
    ).toEqual([
      [1, 4],
      [2, 5],
      [3, 6],
    ]);
  });
  it("is its own inverse on square matrices", () => {
    const A = [
      [1, 2],
      [3, 4],
    ];
    expect(matTranspose(matTranspose(A))).toEqual(A);
  });
});

describe("matMul", () => {
  it("multiplies (2×3)(3×2) → (2×2)", () => {
    const A = [
      [1, 2, 3],
      [4, 5, 6],
    ];
    const B = [
      [7, 8],
      [9, 10],
      [11, 12],
    ];
    expect(matMul(A, B)).toEqual([
      [58, 64],
      [139, 154],
    ]);
  });
  it("identity is the multiplicative identity", () => {
    const A = [
      [2, 3],
      [4, 5],
    ];
    expect(matMul(matIdentity(2), A)).toEqual(A);
    expect(matMul(A, matIdentity(2))).toEqual(A);
  });
  it("throws on inner-dim mismatch", () => {
    expect(() =>
      matMul(
        [
          [1, 2],
          [3, 4],
        ],
        [[1, 2, 3]],
      ),
    ).toThrow(/inner dim/);
  });
});

describe("matVecMul", () => {
  it("multiplies (2×3) by length-3 vec", () => {
    expect(
      matVecMul(
        [
          [1, 2, 3],
          [4, 5, 6],
        ],
        [1, 2, 3],
      ),
    ).toEqual([14, 32]);
  });
  it("throws when vec length != cols", () => {
    expect(() =>
      matVecMul(
        [
          [1, 2],
          [3, 4],
        ],
        [1, 2, 3],
      ),
    ).toThrow(/length/);
  });
});

describe("matInverse", () => {
  it("inverts a 2×2 with closed-form result", () => {
    // [[1, 2], [3, 4]] inverse = [[-2, 1], [1.5, -0.5]]
    const inv = matInverse([
      [1, 2],
      [3, 4],
    ]);
    expect(
      closeMatrix(inv, [
        [-2, 1],
        [1.5, -0.5],
      ]),
    ).toBe(true);
  });

  it("inv(I) = I", () => {
    const I = matIdentity(4);
    expect(closeMatrix(matInverse(I), I)).toBe(true);
  });

  it("A · inv(A) ≈ I (random 4×4)", () => {
    const A = [
      [4, 2, 1, 3],
      [1, 5, 2, 1],
      [2, 1, 6, 2],
      [3, 1, 2, 5],
    ];
    const inv = matInverse(A);
    const product = matMul(A, inv);
    expect(closeMatrix(product, matIdentity(4), 1e-8)).toBe(true);
  });

  it("throws on non-square input", () => {
    expect(() =>
      matInverse([
        [1, 2, 3],
        [4, 5, 6],
      ]),
    ).toThrow(/not square/);
  });

  it("throws on singular matrix", () => {
    // Two identical rows → singular
    expect(() =>
      matInverse([
        [1, 2],
        [1, 2],
      ]),
    ).toThrow(/singular/);
  });

  it("does not mutate the input matrix", () => {
    const A = [
      [1, 2],
      [3, 4],
    ];
    const original = JSON.parse(JSON.stringify(A));
    matInverse(A);
    expect(A).toEqual(original);
  });

  it("uses partial pivoting for numerical stability", () => {
    // A matrix with a near-zero pivot at [0][0] without pivoting would
    // explode. Partial pivoting swaps rows so the larger element pivots.
    const A = [
      [1e-15, 1, 0],
      [1, 1, 1],
      [0, 1, 2],
    ];
    const inv = matInverse(A);
    expect(closeMatrix(matMul(A, inv), matIdentity(3), 1e-6)).toBe(true);
  });
});

describe("diagMatrix", () => {
  it("builds a diagonal matrix from a vector", () => {
    expect(diagMatrix([1, 2, 3])).toEqual([
      [1, 0, 0],
      [0, 2, 0],
      [0, 0, 3],
    ]);
  });
  it("rejects empty input", () => {
    expect(() => diagMatrix([])).toThrow();
  });
});
