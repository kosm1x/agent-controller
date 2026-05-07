import { describe, it, expect } from "vitest";
import { applyOutcomeBias, OUTCOME_BIAS } from "./outcome-bias.js";
import type { MemoryItem, RecallOptions } from "./types.js";

const opts = (overrides: Partial<RecallOptions> = {}): RecallOptions => ({
  bank: "mc-jarvis",
  ...overrides,
});

const item = (
  content: string,
  tags: string[],
  relevance?: number,
): MemoryItem => ({
  content,
  tags,
  ...(relevance !== undefined ? { relevance } : {}),
});

describe("applyOutcomeBias", () => {
  it("drops outcome:failed by default and keeps everything else", () => {
    const items = [
      item("a", ["outcome:success"], 0.5),
      item("b", ["outcome:concerns"], 0.5),
      item("c", ["outcome:failed"], 0.5),
      item("d", ["outcome:unknown"], 0.5),
      item("e", [], 0.5),
    ];
    const r = applyOutcomeBias(items, opts());
    const contents = r.kept.map((k) => k.content);
    expect(contents).toContain("a");
    expect(contents).toContain("b");
    expect(contents).toContain("d");
    expect(contents).toContain("e");
    expect(contents).not.toContain("c");
    expect(r.excluded).toBe(1);
    expect(r.breakdown).toEqual({
      success: 1,
      concerns: 1,
      failed: 1,
      unknown: 2, // outcome:unknown + untagged both count as unknown
    });
  });

  it("applies +0.10 boost to outcome:success and -0.05 penalty to outcome:concerns", () => {
    const items = [
      item("success", ["outcome:success"], 0.5),
      item("concerns", ["outcome:concerns"], 0.5),
      item("plain", [], 0.5),
    ];
    const r = applyOutcomeBias(items, opts());
    const byContent = Object.fromEntries(
      r.kept.map((k) => [k.content, k.relevance]),
    );
    expect(byContent.success).toBeCloseTo(
      0.5 + OUTCOME_BIAS["outcome:success"],
    );
    expect(byContent.concerns).toBeCloseTo(
      0.5 + OUTCOME_BIAS["outcome:concerns"],
    );
    expect(byContent.plain).toBeCloseTo(0.5);
  });

  it("re-sorts kept items by adjusted relevance descending", () => {
    // Without bias: success=0.40, plain=0.42, concerns=0.50
    // With bias: success=0.50 (+0.10), plain=0.42, concerns=0.45 (-0.05)
    // Expected order: success, concerns, plain
    const items = [
      item("success", ["outcome:success"], 0.4),
      item("plain", [], 0.42),
      item("concerns", ["outcome:concerns"], 0.5),
    ];
    const r = applyOutcomeBias(items, opts());
    expect(r.kept.map((k) => k.content)).toEqual([
      "success",
      "concerns",
      "plain",
    ]);
  });

  it("includeFailed: true keeps failed items in output", () => {
    const items = [
      item("good", ["outcome:success"], 0.5),
      item("bad", ["outcome:failed"], 0.5),
    ];
    const r = applyOutcomeBias(items, opts({ includeFailed: true }));
    expect(r.kept).toHaveLength(2);
    expect(r.excluded).toBe(0);
  });

  it("explicit excludeOutcomes overrides default", () => {
    const items = [
      item("s", ["outcome:success"], 0.5),
      item("c", ["outcome:concerns"], 0.5),
      item("f", ["outcome:failed"], 0.5),
    ];
    const r = applyOutcomeBias(
      items,
      opts({ excludeOutcomes: ["outcome:concerns"] }),
    );
    const contents = r.kept.map((k) => k.content);
    expect(contents).toContain("s");
    expect(contents).toContain("f"); // not dropped because override replaces default
    expect(contents).not.toContain("c");
    expect(r.excluded).toBe(1);
  });

  it("preserves items without relevance (no NaN, no crash)", () => {
    const items = [
      item("with-rel", ["outcome:success"], 0.7),
      item("no-rel", ["outcome:success"]),
    ];
    const r = applyOutcomeBias(items, opts());
    expect(r.kept).toHaveLength(2);
    // Item with relevance gets bias; item without does not.
    const found = r.kept.find((k) => k.content === "with-rel");
    expect(found?.relevance).toBeCloseTo(0.8);
    const noRel = r.kept.find((k) => k.content === "no-rel");
    expect(noRel?.relevance).toBeUndefined();
  });

  it("breakdown sums to input length (sanity)", () => {
    const items = [
      item("a", ["outcome:success"], 0.5),
      item("b", ["outcome:concerns"], 0.5),
      item("c", ["outcome:failed"], 0.5),
      item("d", ["outcome:unknown"], 0.5),
      item("e", [], 0.5),
      item("f", ["unrelated:tag"], 0.5),
    ];
    const r = applyOutcomeBias(items, opts());
    const sum =
      r.breakdown.success +
      r.breakdown.concerns +
      r.breakdown.failed +
      r.breakdown.unknown;
    expect(sum).toBe(items.length);
  });

  it("stable sort preserves original order on relevance ties", () => {
    const items = [item("a", [], 0.5), item("b", [], 0.5), item("c", [], 0.5)];
    const r = applyOutcomeBias(items, opts());
    expect(r.kept.map((k) => k.content)).toEqual(["a", "b", "c"]);
  });
});
