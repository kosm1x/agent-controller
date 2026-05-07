/**
 * Pure-TS dense-matrix primitives for the F7 weight-allocation stack
 * (Black-Litterman, HRP, etc.). Zero deps, deterministic, no I/O.
 *
 * Convention: matrices are `number[][]` with rows-as-outer-array. All
 * functions throw on shape mismatch; none mutate inputs. Numerical
 * stability is sufficient for F7's expected dimensions (N ≤ ~30).
 *
 * Why hand-rolled instead of pulling in a math library:
 *   - mc invariant disallows new deps without discussion (CLAUDE.md)
 *   - Gauss-Jordan inverse is ~50 LOC and our problem sizes don't
 *     justify a 1MB+ math library or its transitive surface
 *   - Keeps the F7 numerics stack auditable end-to-end in the repo
 */

const EPSILON = 1e-12;

/** Throw if matrix has inconsistent row lengths or zero dim. */
function assertRect(
  A: number[][],
  fnName: string,
): { rows: number; cols: number } {
  const rows = A.length;
  if (rows === 0) throw new Error(`${fnName}: empty matrix`);
  const cols = A[0]!.length;
  if (cols === 0) throw new Error(`${fnName}: zero-column matrix`);
  for (let i = 1; i < rows; i++) {
    if (A[i]!.length !== cols) {
      throw new Error(
        `${fnName}: row ${i} has ${A[i]!.length} cols, expected ${cols}`,
      );
    }
  }
  return { rows, cols };
}

/** N×N identity matrix. */
export function matIdentity(n: number): number[][] {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`matIdentity: n must be a positive integer, got ${n}`);
  }
  const out: number[][] = Array.from({ length: n }, () =>
    new Array<number>(n).fill(0),
  );
  for (let i = 0; i < n; i++) out[i]![i] = 1;
  return out;
}

/** Element-wise matrix add. Both inputs must share dimensions. */
export function matAdd(A: number[][], B: number[][]): number[][] {
  const a = assertRect(A, "matAdd");
  const b = assertRect(B, "matAdd");
  if (a.rows !== b.rows || a.cols !== b.cols) {
    throw new Error(
      `matAdd: shape mismatch ${a.rows}x${a.cols} vs ${b.rows}x${b.cols}`,
    );
  }
  const out: number[][] = Array.from({ length: a.rows }, () =>
    new Array<number>(a.cols).fill(0),
  );
  for (let i = 0; i < a.rows; i++) {
    for (let j = 0; j < a.cols; j++) out[i]![j] = A[i]![j]! + B[i]![j]!;
  }
  return out;
}

/** Transpose. */
export function matTranspose(A: number[][]): number[][] {
  const { rows, cols } = assertRect(A, "matTranspose");
  const out: number[][] = Array.from({ length: cols }, () =>
    new Array<number>(rows).fill(0),
  );
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) out[j]![i] = A[i]![j]!;
  }
  return out;
}

/** Matrix-matrix multiply. (m×k)(k×n) → (m×n). */
export function matMul(A: number[][], B: number[][]): number[][] {
  const a = assertRect(A, "matMul");
  const b = assertRect(B, "matMul");
  if (a.cols !== b.rows) {
    throw new Error(
      `matMul: inner dim mismatch ${a.rows}x${a.cols} * ${b.rows}x${b.cols}`,
    );
  }
  const out: number[][] = Array.from({ length: a.rows }, () =>
    new Array<number>(b.cols).fill(0),
  );
  for (let i = 0; i < a.rows; i++) {
    for (let k = 0; k < a.cols; k++) {
      const aik = A[i]![k]!;
      if (aik === 0) continue;
      const Bk = B[k]!;
      const Oi = out[i]!;
      for (let j = 0; j < b.cols; j++) Oi[j]! += aik * Bk[j]!;
    }
  }
  return out;
}

/** Matrix-vector multiply. (m×n) · (n) → (m). */
export function matVecMul(A: number[][], v: number[]): number[] {
  const { rows, cols } = assertRect(A, "matVecMul");
  if (v.length !== cols) {
    throw new Error(
      `matVecMul: vector length ${v.length} != matrix cols ${cols}`,
    );
  }
  const out = new Array<number>(rows).fill(0);
  for (let i = 0; i < rows; i++) {
    let s = 0;
    const Ai = A[i]!;
    for (let j = 0; j < cols; j++) s += Ai[j]! * v[j]!;
    out[i] = s;
  }
  return out;
}

/**
 * Invert a square matrix via Gauss-Jordan with partial pivoting.
 * Throws on non-square or singular input.
 *
 * O(N^3); fine for N ≤ ~50. Uses partial pivoting (swap rows so the
 * largest-magnitude pivot is on the diagonal) for numerical stability
 * on poorly-conditioned matrices.
 *
 * `epsilon` defaults to 1e-12. A pivot magnitude below this is treated
 * as zero → matrix considered singular → throw.
 */
export function matInverse(
  A: number[][],
  epsilon: number = EPSILON,
): number[][] {
  const { rows, cols } = assertRect(A, "matInverse");
  if (rows !== cols) {
    throw new Error(`matInverse: not square (${rows}x${cols})`);
  }
  const n = rows;

  // Working augmented matrix [A | I]; deep-copy A so input is not mutated.
  const M: number[][] = Array.from({ length: n }, (_, i) => [
    ...A[i]!,
    ...new Array<number>(n).fill(0).map((_v, j) => (i === j ? 1 : 0)),
  ]);

  for (let col = 0; col < n; col++) {
    // Find the row with the largest-magnitude pivot at this column.
    let pivotRow = col;
    let pivotMag = Math.abs(M[col]![col]!);
    for (let r = col + 1; r < n; r++) {
      const m = Math.abs(M[r]![col]!);
      if (m > pivotMag) {
        pivotMag = m;
        pivotRow = r;
      }
    }
    if (pivotMag < epsilon) {
      throw new Error(
        `matInverse: matrix is singular (pivot ${pivotMag} < ${epsilon})`,
      );
    }
    if (pivotRow !== col) {
      const tmp = M[col]!;
      M[col] = M[pivotRow]!;
      M[pivotRow] = tmp;
    }

    // Normalize the pivot row so M[col][col] = 1.
    const pivot = M[col]![col]!;
    const pivotRowArr = M[col]!;
    for (let j = 0; j < 2 * n; j++) pivotRowArr[j] = pivotRowArr[j]! / pivot;

    // Eliminate this column in every other row.
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r]![col]!;
      if (factor === 0) continue;
      const Mr = M[r]!;
      for (let j = 0; j < 2 * n; j++) Mr[j] = Mr[j]! - factor * pivotRowArr[j]!;
    }
  }

  // Right half of augmented M is the inverse.
  const inv: number[][] = Array.from({ length: n }, () =>
    new Array<number>(n).fill(0),
  );
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) inv[i]![j] = M[i]![n + j]!;
  }
  return inv;
}

/**
 * Build an N×N diagonal matrix from a length-N vector.
 * Convenience for diag(σ²), diag(1/σ²), etc.
 */
export function diagMatrix(diag: number[]): number[][] {
  const n = diag.length;
  if (n === 0) throw new Error("diagMatrix: empty diag vector");
  const out: number[][] = Array.from({ length: n }, () =>
    new Array<number>(n).fill(0),
  );
  for (let i = 0; i < n; i++) out[i]![i] = diag[i]!;
  return out;
}
