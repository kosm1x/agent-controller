/**
 * IterationBudget tests — consume, refund, exhaustion.
 */

import { describe, it, expect } from "vitest";
import { IterationBudget } from "./budget.js";

describe("IterationBudget", () => {
  it("should consume up to max iterations", () => {
    const budget = new IterationBudget(3);
    expect(budget.remaining).toBe(3);
    expect(budget.consumed).toBe(0);

    expect(budget.consume()).toBe(true);
    expect(budget.consume()).toBe(true);
    expect(budget.consume()).toBe(true);
    expect(budget.consume()).toBe(false); // exhausted

    expect(budget.remaining).toBe(0);
    expect(budget.consumed).toBe(3);
  });

  it("should refund iterations", () => {
    const budget = new IterationBudget(2);
    budget.consume();
    budget.consume();
    expect(budget.consume()).toBe(false);

    budget.refund();
    expect(budget.remaining).toBe(1);
    expect(budget.consume()).toBe(true);
  });

  it("should not refund below zero", () => {
    const budget = new IterationBudget(5);
    budget.refund();
    expect(budget.consumed).toBe(0);
    expect(budget.remaining).toBe(5);
  });

  it("should handle budget of 0", () => {
    const budget = new IterationBudget(0);
    expect(budget.consume()).toBe(false);
    expect(budget.remaining).toBe(0);
  });
});
