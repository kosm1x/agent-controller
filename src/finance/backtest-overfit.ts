/**
 * F7.5 Strategy Backtester — overfit firewall.
 *
 * Computes:
 *   - PBO  (Probability of Backtest Overfitting, Bailey/de Prado 2014)
 *   - DSR  (Deflated Sharpe Ratio, same paper equation 14)
 *
 * Both read a CPCV result (`backtest-cpcv.ts`) and produce a scalar
 * probability used as a ship-gate.
 *
 * PBO (Bailey/de Prado 2014):
 *   For each fold f:
 *     best_is   = argmax_t SR_IS(t, f)
 *     rank_oos  = rank of SR_OOS(best_is, f) among {SR_OOS(t, f)} ascending
 *     logit(f)  = log(rank_oos / (N_trials − rank_oos + 1))
 *   PBO = fraction of folds with logit(f) < 0
 *       = fraction of folds where the in-sample winner fell below median OOS.
 *
 * DSR (equation 14):
 *                  ( SR_obs − E[max SR | SR_true=0] ) · √(T−1)
 *   DSR = Φ ( ──────────────────────────────────────────────────────── )
 *             √( 1 − γ₃·SR_obs + (γ₄−1)/4 · SR_obs² )
 *
 *   E[max SR | SR_true=0] ≈ √V[SR_trials] · (
 *       (1 − γ_EM) · Φ⁻¹(1 − 1/N_trials)
 *     + γ_EM · Φ⁻¹(1 − 1/(N_trials · e))
 *   )
 *
 * pvalue = 1 − DSR. Ship-gate: pvalue < 0.05.
 *
 * All math pure; depends only on `stats.ts`.
 */

import type { CpcvResult } from "./backtest-cpcv.js";
import {
  EULER,
  normCdf,
  normInv,
  sampleExcessKurtosis,
  sampleMean,
  sampleSkewness,
  sampleVariance,
} from "./stats.js";

export interface OverfitDsrMetrics {
  observedSharpe: number;
  expectedNullSharpe: number;
  trialsSharpeVariance: number;
  skewness: number | null;
  kurtosis: number | null;
  ratio: number;
  pvalue: number;
}

export interface OverfitResult {
  /** PBO ∈ [0, 1]; NaN if all folds aborted. */
  pbo: number;
  dsr: OverfitDsrMetrics;
}

/**
 * Rank of `value` among `sample` (1-based, ascending). Ties get averaged.
 *   rank(x, [1, 5, 5, 9]) → x=5 → 2.5
 */
export function rankAscending(value: number, sample: number[]): number {
  let below = 0;
  let ties = 0;
  for (const s of sample) {
    if (s < value) below += 1;
    else if (s === value) ties += 1;
  }
  return below + (ties + 1) / 2;
}

// Note: Bailey/de Prado 2014 define `logit_f = log(rank/(N+1-rank))`. The
// odds ratio `rank/(N+1-rank)` IS the logit input; logit(f) < 0 ⇔ rank <
// (N+1)/2 ⇔ the winner fell below median OOS. We check that directly below —
// no outer `logit()` wrapper, which would nest the transform and shift the
// threshold to (N+1)/3 (under-reporting PBO).

// ---------------------------------------------------------------------------
// PBO
// ---------------------------------------------------------------------------

export function computePbo(cpcv: CpcvResult): number {
  const { trials, nFoldsPerTrial } = cpcv;
  if (trials.length === 0 || nFoldsPerTrial === 0) return Number.NaN;

  let foldLogitsBelowZero = 0;
  let eligibleFolds = 0;

  for (let f = 0; f < nFoldsPerTrial; f++) {
    const isSharpes: Array<{ t: number; is: number | null }> = [];
    const oosSharpes: Array<{ t: number; oos: number | null }> = [];

    for (const trial of trials) {
      const fold = trial.folds.find((x) => x.foldIndex === f);
      if (!fold) continue;
      isSharpes.push({ t: trial.trialIndex, is: fold.isSharpe });
      oosSharpes.push({ t: trial.trialIndex, oos: fold.oosSharpe });
    }

    const validIS = isSharpes.filter((x) => x.is !== null);
    const validOOS = oosSharpes.filter((x) => x.oos !== null);
    if (validIS.length === 0 || validOOS.length < 2) continue;

    // Best IS trial for this fold
    let bestTrial = validIS[0]!.t;
    let bestScore = validIS[0]!.is as number;
    for (const x of validIS) {
      if ((x.is as number) > bestScore) {
        bestScore = x.is as number;
        bestTrial = x.t;
      }
    }

    const winnerOosEntry = validOOS.find((x) => x.t === bestTrial);
    if (!winnerOosEntry || winnerOosEntry.oos === null) continue;

    const oosSample = validOOS.map((x) => x.oos as number);
    const rank = rankAscending(winnerOosEntry.oos, oosSample);
    // Bailey/de Prado logit < 0 iff rank < (N+1)/2 — i.e. the winner fell
    // below median OOS. Compare directly; equivalent to `log(rank/(N+1-rank)) < 0`.
    const N = oosSample.length;
    if (rank < (N + 1) / 2) foldLogitsBelowZero += 1;
    eligibleFolds += 1;
  }

  if (eligibleFolds === 0) return Number.NaN;
  return foldLogitsBelowZero / eligibleFolds;
}

// ---------------------------------------------------------------------------
// DSR
// ---------------------------------------------------------------------------

export interface DsrInput {
  /** Observed Sharpe — may be annualized (see periodsPerYear). */
  observedSharpe: number;
  /** All trial Sharpes; must use the same annualization as observedSharpe. */
  trialSharpes: number[];
  /** Per-period returns of the observed strategy — for skew/kurt estimation. */
  observedReturns: number[];
  /** Number of observation PERIODS in observedReturns (not years). */
  T: number;
  /**
   * Annualization factor embedded in observedSharpe / trialSharpes. Default
   * 52 (weekly-first). DSR is defined in per-period space, so we de-annualize
   * via √periodsPerYear internally. Pass 1 if inputs are already per-period.
   */
  periodsPerYear?: number;
}

export function computeDsr(input: DsrInput): OverfitDsrMetrics {
  const { observedSharpe, trialSharpes, observedReturns, T } = input;
  const ppy = input.periodsPerYear ?? 52;
  const nTrials = trialSharpes.length;

  // Bailey/de Prado 2014 eq. 14 is in per-period space. De-annualize for all
  // internal math; re-annualize the summary fields so the operator-facing
  // surface keeps a consistent Sharpe scale.
  const annFactor = Math.sqrt(Math.max(1, ppy));
  const srPeriod = observedSharpe / annFactor;
  const trialsPeriod = trialSharpes.map((x) => x / annFactor);

  const trialsVarPeriod = sampleVariance(trialsPeriod);
  const sigmaSrPeriod = Math.sqrt(trialsVarPeriod > 0 ? trialsVarPeriod : 0);

  const expectedNullPeriod =
    nTrials > 1 && sigmaSrPeriod > 0
      ? sigmaSrPeriod *
        ((1 - EULER) * normInv(1 - 1 / nTrials) +
          EULER * normInv(1 - 1 / (nTrials * Math.E)))
      : 0;

  const skew =
    observedReturns.length >= 3 ? sampleSkewness(observedReturns) : 0;
  const excessKurt =
    observedReturns.length >= 4 ? sampleExcessKurtosis(observedReturns) : 0;
  const adjKurt = excessKurt + 3; // kurtosis γ₄

  // Denominator uses per-period observed Sharpe.
  const denom = Math.sqrt(
    Math.max(
      1e-12,
      1 - skew * srPeriod + ((adjKurt - 1) / 4) * srPeriod * srPeriod,
    ),
  );

  const numer = (srPeriod - expectedNullPeriod) * Math.sqrt(Math.max(1, T - 1));
  const ratio = numer / denom;
  const dsrProbability = normCdf(ratio);
  const pvalue = 1 - dsrProbability;

  return {
    observedSharpe,
    expectedNullSharpe: expectedNullPeriod * annFactor,
    trialsSharpeVariance: trialsVarPeriod * ppy,
    skewness: observedReturns.length >= 3 ? skew : null,
    kurtosis: observedReturns.length >= 4 ? adjKurt : null,
    ratio,
    pvalue,
  };
}

// ---------------------------------------------------------------------------
// Convenience wrapper taking a CpcvResult
// ---------------------------------------------------------------------------

/**
 * Compute per-trial aggregate OOS Sharpes from a CpcvResult (mean across folds,
 * ignoring aborted folds). Trials with all folds aborted are dropped.
 */
export function trialLevelOosSharpes(cpcv: CpcvResult): number[] {
  const out: number[] = [];
  for (const trial of cpcv.trials) {
    const good = trial.folds
      .filter((f) => !f.aborted && f.oosSharpe !== null)
      .map((f) => f.oosSharpe as number);
    if (good.length === 0) continue;
    out.push(sampleMean(good));
  }
  return out;
}

/**
 * Find the best-OOS trial and return its per-fold OOS returns concatenated,
 * for observed-Sharpe skew/kurt estimation inside DSR.
 *
 * Without per-bar return history we approximate by building a synthetic
 * sample: the set of per-fold OOS Sharpes themselves. This is what de Prado
 * uses when actual returns aren't available. Caller can override by passing
 * `observedReturns` into `computeDsr` directly.
 */
export function bestTrialFoldSharpes(cpcv: CpcvResult): number[] {
  const trialMeans = trialLevelOosSharpes(cpcv);
  if (trialMeans.length === 0) return [];
  let bestIdx = 0;
  for (let i = 1; i < trialMeans.length; i++) {
    if (trialMeans[i]! > trialMeans[bestIdx]!) bestIdx = i;
  }
  const bestTrial = cpcv.trials[bestIdx];
  if (!bestTrial) return [];
  return bestTrial.folds
    .filter((f) => !f.aborted && f.oosSharpe !== null)
    .map((f) => f.oosSharpe as number);
}

export function computeOverfitMetrics(
  cpcv: CpcvResult,
  opts?: {
    observedReturns?: number[];
    T?: number;
    /**
     * Annualization factor of the trial/observed Sharpes. Default 52 (weekly).
     * Audit W1 round 2: plumbed through so future daily (252) or monthly (12)
     * callers get correct DSR deflation without touching the internal math.
     */
    periodsPerYear?: number;
  },
): OverfitResult {
  const trialSharpes = trialLevelOosSharpes(cpcv);
  const bestFolds = bestTrialFoldSharpes(cpcv);
  const observedSharpe =
    trialSharpes.length > 0 ? Math.max(...trialSharpes) : 0;

  // Returns sample for skew/kurtosis: caller can provide real per-bar returns
  // (from walk-forward or specific fold); otherwise fall back to per-fold OOS
  // Sharpes of the best trial (de Prado's approximation).
  const observedReturns = opts?.observedReturns ?? bestFolds;
  const T = opts?.T ?? opts?.observedReturns?.length ?? bestFolds.length;

  const pbo = computePbo(cpcv);
  const dsr = computeDsr({
    observedSharpe,
    trialSharpes,
    observedReturns,
    T,
    periodsPerYear: opts?.periodsPerYear,
  });

  return { pbo, dsr };
}
