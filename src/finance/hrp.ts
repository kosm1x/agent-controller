/**
 * Hierarchical Risk Parity (HRP) — F7 weight allocator (v7.5 L4 / A9).
 *
 * Port of López de Prado's HRP from skfolio (`cluster/hierarchical/_hrp.py`)
 * to pure TS. Replaces heuristic confidence-weighted sums in F7 with a
 * principled risk-aware allocator that's robust to estimation error
 * (the failure mode of Markowitz mean-variance).
 *
 * Algorithm (López de Prado 2016):
 *   1. correlationMatrix       — N×N Pearson correlations from T×N returns
 *   2. distance(corr)          — d_ij = sqrt(0.5 * (1 - corr_ij))
 *   3. linkage(distance)       — single-linkage hierarchical clustering
 *   4. quasiDiag(linkage)      — leaf order from cluster tree → places
 *                                related assets adjacent
 *   5. recursiveBisection(cov, order) — split groups; allocate each by
 *                                inverse-variance; recurse
 *
 * No external linkage library — single-linkage is ~40 LOC and sufficient
 * for HRP. Ward / complete linkage can be added later via the linkage
 * parameter without changing the public contract.
 *
 * Convention: returns matrix is T×N (rows=time, cols=asset), matching
 * `allocators.ts` and every finance library convention.
 */

import { correlation } from "./alpha-linalg.js";
import { equalWeight, varianceVector } from "./allocators.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface HRPOptions {
  /**
   * Linkage method. Only `single` is implemented today — `complete` and
   * `ward` reserved for follow-up. Defaults to `single`, which is what
   * López de Prado used in the original paper.
   */
  linkage?: "single";
}

/**
 * Run HRP on a T×N returns matrix. Returns N weights that sum to 1.0
 * with all weights >= 0 (long-only).
 *
 * Degenerate cases:
 *   - N=0 throws (no assets to allocate).
 *   - N=1 returns [1.0] (only choice).
 *   - All-zero variance returns equal-weight (no risk signal to cluster on).
 */
export function hierarchicalRiskParity(
  returns: number[][],
  options: HRPOptions = {},
): number[] {
  const linkageMethod = options.linkage ?? "single";
  if (linkageMethod !== "single") {
    throw new Error(
      `hierarchicalRiskParity: linkage='${linkageMethod}' not implemented yet`,
    );
  }
  if (!Array.isArray(returns) || returns.length === 0) {
    throw new Error("hierarchicalRiskParity: empty returns matrix");
  }
  const T = returns.length;
  const N = returns[0]!.length;
  if (N === 0) {
    throw new Error("hierarchicalRiskParity: returns matrix has zero columns");
  }
  if (N === 1) return [1.0];

  const variances = varianceVector(returns);
  // No-risk shortcut: every asset is flat → equal weights.
  if (variances.every((v) => v === 0)) return equalWeight(N);

  // 1. Correlation matrix (N×N) — transpose returns so columns become rows.
  const cols: number[][] = Array.from(
    { length: N },
    () => new Array<number>(T),
  );
  for (let t = 0; t < T; t++) {
    for (let i = 0; i < N; i++) cols[i]![t] = returns[t]![i]!;
  }
  const corr = corrMatrixFromCols(cols);

  // 2. Distance matrix d_ij = sqrt(0.5 * (1 - corr_ij))
  const dist = distanceFromCorrelation(corr);

  // 3. Single-linkage clustering
  const linkage = singleLinkage(dist);

  // 4. Quasi-diagonal leaf order
  const order = quasiDiag(linkage, N);

  // 5. Recursive bisection. Note: López de Prado 2016 (`getClusterVar`)
  //    computes cluster variance as `wᵀ·Σ·w` over the FULL slice
  //    covariance. We pass only the diagonal (per-asset variances) — a
  //    common simplification (skfolio exposes this mode) that's
  //    equivalent when intra-cluster correlations are weak. Empirically
  //    close enough on uncorrelated test fixtures; full-cov bisection
  //    is reserved for follow-up if F7 telemetry shows allocation
  //    artefacts. Audit W3 fix: comment was previously inaccurate
  //    about LdP fidelity.
  return recursiveBisection(variances, order);
}

// ---------------------------------------------------------------------------
// Helpers — exported for unit tests
// ---------------------------------------------------------------------------

/**
 * Build an N×N correlation matrix from N row-vectors (each of length T).
 * Local copy of the alpha-linalg helper because that one expects N×M
 * "signals as rows" and we want to be explicit about the orientation
 * we're feeding it.
 */
export function corrMatrixFromCols(cols: number[][]): number[][] {
  const N = cols.length;
  const out: number[][] = Array.from({ length: N }, () =>
    new Array<number>(N).fill(0),
  );
  for (let i = 0; i < N; i++) {
    out[i]![i] = 1;
    for (let j = i + 1; j < N; j++) {
      const c = correlation(cols[i]!, cols[j]!);
      out[i]![j] = c;
      out[j]![i] = c;
    }
  }
  return out;
}

/**
 * López de Prado distance from correlation: `d = sqrt(0.5 * (1 - corr))`.
 * Maps [-1, 1] → [0, 1] with d=0 ⇔ perfect positive correlation,
 * d=1 ⇔ perfect negative correlation.
 *
 * Floating-point overshoot guard: empirical correlations can land at
 * `1 + ε` (observed: 1.0000000000000007 on perfectly-correlated synthetic
 * data). The `Math.max(0, …)` clamp prevents `sqrt(negative)` → NaN,
 * which would otherwise nuke the entire linkage step (NaN distances
 * never compare less than Infinity, so single-linkage finds no pair).
 *
 * NaN/non-finite correlations collapse to 1 (treat as "maximally distant"
 * — safer than letting NaN propagate into linkage).
 */
export function distanceFromCorrelation(corr: number[][]): number[][] {
  const N = corr.length;
  const out: number[][] = Array.from({ length: N }, () =>
    new Array<number>(N).fill(0),
  );
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      if (i === j) {
        out[i]![j] = 0;
        continue;
      }
      const c = corr[i]![j]!;
      const d = Number.isFinite(c) ? Math.sqrt(Math.max(0, 0.5 * (1 - c))) : 1;
      out[i]![j] = d;
    }
  }
  return out;
}

export interface LinkageStep {
  /** Cluster id of left child (0..N-1 = leaves; N..N+steps-1 = inner). */
  leftId: number;
  /** Cluster id of right child. */
  rightId: number;
  /** Distance at which the two children were merged. */
  distance: number;
  /** Number of leaves under this cluster. */
  size: number;
}

/**
 * Single-linkage hierarchical clustering from a symmetric N×N distance
 * matrix. Distance between two clusters = min pairwise distance between
 * their members. O(N^3) naive; fine for F7's typical N≈15.
 *
 * Returns N-1 merge steps. Cluster ids: 0..N-1 = leaves, N..2N-2 =
 * internal nodes (each step creates a new id).
 */
export function singleLinkage(dist: number[][]): LinkageStep[] {
  const N = dist.length;
  if (N <= 1) return [];

  // Active cluster ids and their leaf membership.
  const active = new Set<number>();
  for (let i = 0; i < N; i++) active.add(i);
  const members = new Map<number, number[]>();
  for (let i = 0; i < N; i++) members.set(i, [i]);

  // Cluster→cluster distance. Initialize to leaf-leaf distances; updated
  // via single-linkage min on each merge.
  const D = new Map<number, Map<number, number>>();
  for (let i = 0; i < N; i++) D.set(i, new Map());
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      D.get(i)!.set(j, dist[i]![j]!);
      D.get(j)!.set(i, dist[i]![j]!);
    }
  }

  const steps: LinkageStep[] = [];
  let nextId = N;

  while (active.size > 1) {
    // Find the closest pair of active clusters.
    let bestI = -1;
    let bestJ = -1;
    let bestD = Infinity;
    const ids = Array.from(active);
    for (let a = 0; a < ids.length; a++) {
      const i = ids[a]!;
      for (let b = a + 1; b < ids.length; b++) {
        const j = ids[b]!;
        const d = D.get(i)!.get(j) ?? Infinity;
        // Tie-break on lower-id first then second-id, so output is
        // deterministic across runs (independent of Set iteration order).
        if (
          d < bestD ||
          (d === bestD &&
            (Math.min(i, j) < Math.min(bestI, bestJ) ||
              (Math.min(i, j) === Math.min(bestI, bestJ) &&
                Math.max(i, j) < Math.max(bestI, bestJ))))
        ) {
          bestD = d;
          bestI = i;
          bestJ = j;
        }
      }
    }
    if (bestI === -1) break;

    const newId = nextId++;
    const leftMembers = members.get(bestI)!;
    const rightMembers = members.get(bestJ)!;
    const newMembers = [...leftMembers, ...rightMembers];

    steps.push({
      leftId: Math.min(bestI, bestJ),
      rightId: Math.max(bestI, bestJ),
      distance: bestD,
      size: newMembers.length,
    });

    // Update distance map: new cluster vs every other active cluster.
    const newDistRow = new Map<number, number>();
    for (const k of active) {
      if (k === bestI || k === bestJ) continue;
      const dik = D.get(bestI)!.get(k) ?? Infinity;
      const djk = D.get(bestJ)!.get(k) ?? Infinity;
      newDistRow.set(k, Math.min(dik, djk));
      D.get(k)!.set(newId, Math.min(dik, djk));
      D.get(k)!.delete(bestI);
      D.get(k)!.delete(bestJ);
    }

    // Drop merged clusters; install the new one.
    active.delete(bestI);
    active.delete(bestJ);
    members.delete(bestI);
    members.delete(bestJ);
    D.delete(bestI);
    D.delete(bestJ);
    active.add(newId);
    members.set(newId, newMembers);
    D.set(newId, newDistRow);
  }

  return steps;
}

/**
 * Quasi-diagonalization: walk the dendrogram from the root and emit
 * leaves in left-then-right order. The result is a permutation of
 * 0..N-1 where similar assets sit adjacent. Required for the recursive
 * bisection step (HRP needs adjacent leaves to be similar so subgroups
 * stay coherent).
 */
export function quasiDiag(steps: LinkageStep[], N: number): number[] {
  if (N <= 0) return [];
  if (steps.length === 0) return [0];

  // Root is the last merge.
  const root = N + steps.length - 1;

  const expand = (id: number): number[] => {
    if (id < N) return [id];
    const step = steps[id - N]!;
    return [...expand(step.leftId), ...expand(step.rightId)];
  };
  return expand(root);
}

/**
 * HRP recursive bisection. Walks down the order, splits each group
 * in half, allocates by inverse-variance share between the halves,
 * and recurses. Final weights sum to 1.
 *
 * Receives the per-asset variance vector (length N) and the order
 * (a permutation of 0..N-1 from quasiDiag). Returns weights in the
 * ORIGINAL asset order (not the quasi-diag order) so callers don't
 * need to undo the permutation.
 */
export function recursiveBisection(
  variances: number[],
  order: number[],
): number[] {
  const N = variances.length;
  if (N === 0) return [];
  if (N === 1) return [1.0];

  // Working weights per asset, in original order.
  const w = new Array<number>(N).fill(1.0);

  // Stack of [start, end) index ranges into `order`.
  const stack: Array<[number, number]> = [[0, order.length]];

  while (stack.length > 0) {
    const [s, e] = stack.pop()!;
    if (e - s <= 1) continue;
    const mid = Math.floor((s + e) / 2);
    const leftAssets = order.slice(s, mid);
    const rightAssets = order.slice(mid, e);

    const leftVar = clusterVariance(variances, leftAssets);
    const rightVar = clusterVariance(variances, rightAssets);
    const total = leftVar + rightVar;

    let alpha: number;
    if (total === 0) {
      // Both halves zero variance — split evenly.
      alpha = 0.5;
    } else {
      // Allocate INVERSE to variance: high-variance side gets less weight.
      alpha = 1 - leftVar / total;
    }

    for (const a of leftAssets) w[a] = w[a]! * alpha;
    for (const a of rightAssets) w[a] = w[a]! * (1 - alpha);

    stack.push([s, mid]);
    stack.push([mid, e]);
  }

  // Normalize for numerical safety; should already sum to ~1 but rounding
  // drifts accumulate over deep trees.
  let sum = 0;
  for (let i = 0; i < N; i++) sum += w[i]!;
  if (sum === 0) return equalWeight(N);
  for (let i = 0; i < N; i++) w[i] = w[i]! / sum;

  // Last-asset absorbs rounding error so callers see exact sum=1.
  let runningSum = 0;
  for (let i = 0; i < N - 1; i++) runningSum += w[i]!;
  w[N - 1] = 1 - runningSum;
  return w;
}

/**
 * Inverse-variance portfolio variance for a subset of assets. Used by
 * the recursive bisection to weight the two halves of each split.
 *
 * IVP variance ≈ 1 / Σ(1/σ²_i). Pure diagonal — cross-terms ignored
 * (HRP's deliberate simplification).
 */
function clusterVariance(variances: number[], indices: number[]): number {
  if (indices.length === 0) return 0;
  let invSum = 0;
  for (const i of indices) {
    const v = variances[i]!;
    if (v > 0) invSum += 1 / v;
  }
  if (invSum === 0) {
    // All zero-variance — return 0 so the bisection treats this side as
    // "no risk" and the alpha computation falls back to even split.
    return 0;
  }
  return 1 / invSum;
}
