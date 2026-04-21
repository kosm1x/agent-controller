import { describe, it, expect } from "vitest";
import { computePoolSize, runPool } from "./worker-pool.js";

describe("computePoolSize", () => {
  it("caps at 4 workers no matter how generous CPU/memory", () => {
    expect(computePoolSize(32, 64000)).toBe(4);
  });

  it("returns at least 1 on low-resource hosts", () => {
    expect(computePoolSize(1, 100)).toBe(1);
    expect(computePoolSize(0, 0)).toBe(1);
  });

  it("is bounded by memory when memory is the constraint", () => {
    // 16 cores * 0.5 = 8; 1024 MB / 512 MB = 2 → should pick 2
    expect(computePoolSize(16, 1024)).toBe(2);
  });

  it("is bounded by CPU when CPU is the constraint", () => {
    // 2 cores * 0.5 = 1; 8000 MB / 512 MB = 15 → should pick 1
    expect(computePoolSize(2, 8000)).toBe(1);
  });
});

describe("runPool", () => {
  it("respects the concurrency cap", async () => {
    const order: number[] = [];
    let running = 0;
    let peak = 0;
    const fn = async (t: number) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
      order.push(t);
      return t * 2;
    };
    const result = await runPool([1, 2, 3, 4, 5, 6], fn, { maxConcurrency: 2 });
    expect(result.results).toEqual([2, 4, 6, 8, 10, 12]);
    expect(result.errors).toEqual([]);
    expect(result.cancelled).toBe(false);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("captures errors but does not kill the pool", async () => {
    const fn = async (t: number) => {
      if (t === 2) throw new Error("boom");
      return t;
    };
    const result = await runPool([1, 2, 3], fn, { maxConcurrency: 2 });
    expect(result.results[0]).toBe(1);
    expect(result.results[1]).toBeUndefined();
    expect(result.results[2]).toBe(3);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].index).toBe(1);
    expect(result.errors[0].task).toBe(2);
    expect(result.errors[0].error.message).toBe("boom");
  });

  it("returns cancelled=true when signal aborts", async () => {
    const controller = new AbortController();
    const fn = async (t: number) => {
      await new Promise((r) => setTimeout(r, 20));
      if (t === 1) controller.abort();
      return t;
    };
    const result = await runPool([1, 2, 3, 4, 5], fn, {
      maxConcurrency: 1,
      signal: controller.signal,
    });
    expect(result.cancelled).toBe(true);
    // The task that fired the abort still resolves, later tasks should be skipped.
    expect(result.results.filter((r) => r !== undefined).length).toBeLessThan(
      5,
    );
  });

  it("handles empty input", async () => {
    const result = await runPool([], async (t) => t, { maxConcurrency: 4 });
    expect(result.results).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.cancelled).toBe(false);
  });

  it("preserves input-order in results array even when tasks finish out of order", async () => {
    const fn = async (t: number) => {
      await new Promise((r) => setTimeout(r, (10 - t) * 5));
      return t;
    };
    const result = await runPool([1, 2, 3, 4, 5], fn, { maxConcurrency: 5 });
    expect(result.results).toEqual([1, 2, 3, 4, 5]);
  });

  it("caps workerCount to task length when concurrency > tasks.length", async () => {
    let peak = 0;
    let running = 0;
    const fn = async (t: number) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return t;
    };
    await runPool([1, 2], fn, { maxConcurrency: 100 });
    expect(peak).toBeLessThanOrEqual(2);
  });
});
