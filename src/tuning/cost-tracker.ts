/**
 * Cost tracker for overnight tuning runs.
 *
 * Accumulates token usage and estimated cost per experiment.
 * Provides a budget gate to abort when limits are exceeded.
 */

import { EST_COST_PER_INFERENCE_USD } from "./types.js";

export interface CostBreakdown {
  metaAgent: number;
  evaluation: number;
}

export class CostTracker {
  private totalTokens = 0;
  private totalCostUsd = 0;
  private readonly breakdown: CostBreakdown = {
    metaAgent: 0,
    evaluation: 0,
  };

  constructor(private readonly maxCostUsd: number) {}

  /** Record cost from a meta-agent inference call. */
  recordMetaAgent(tokens: number): void {
    const cost = this.estimateCost(tokens);
    this.totalTokens += tokens;
    this.totalCostUsd += cost;
    this.breakdown.metaAgent += cost;
  }

  /** Record cost from an evaluation run. */
  recordEvaluation(tokens: number, estimatedCost: number): void {
    this.totalTokens += tokens;
    this.totalCostUsd += estimatedCost;
    this.breakdown.evaluation += estimatedCost;
  }

  /** Check if the budget allows another experiment cycle. */
  hasBudget(): boolean {
    return this.totalCostUsd < this.maxCostUsd;
  }

  /** Get remaining budget in USD. */
  remaining(): number {
    return Math.max(0, this.maxCostUsd - this.totalCostUsd);
  }

  /** Get total cost so far. */
  getTotalCost(): number {
    return this.totalCostUsd;
  }

  /** Get total tokens consumed. */
  getTotalTokens(): number {
    return this.totalTokens;
  }

  /** Get cost breakdown by category. */
  getBreakdown(): CostBreakdown {
    return { ...this.breakdown };
  }

  /** Estimate cost from token count. */
  private estimateCost(tokens: number): number {
    // Rough estimate: each inference call costs EST_COST_PER_INFERENCE_USD
    // Scale linearly with token count (baseline ~2000 tokens per call)
    return (tokens / 2000) * EST_COST_PER_INFERENCE_USD;
  }
}
