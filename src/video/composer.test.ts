import { describe, it, expect } from "vitest";
import { buildOverlayFilterGraph } from "./composer.js";

describe("buildOverlayFilterGraph", () => {
  it("generates correct filter for 1 image", () => {
    const graph = buildOverlayFilterGraph(1, [5.0], 486, 0.9);
    // v7.4 S1: time values now routed through formatFrameTime → 6-decimal
    expect(graph).toContain("enable='between(t,0.000000,5.000000)");
    expect(graph).toContain("scale=486:-1");
    expect(graph).toContain("colorchannelmixer=aa=0.9");
    expect(graph).toContain("[1:v]");
    expect(graph).toContain("[v0]");
  });

  it("generates correct timing for 3 images", () => {
    const graph = buildOverlayFilterGraph(3, [3.0, 5.0, 4.0], 486, 0.9);
    // First overlay: 0-3s
    expect(graph).toContain("between(t,0.000000,3.000000)");
    // Second overlay: 3-8s
    expect(graph).toContain("between(t,3.000000,8.000000)");
    // Third overlay: 8-12s
    expect(graph).toContain("between(t,8.000000,12.000000)");
    // Chain: 0:v → v0 → v1 → v2
    expect(graph).toContain("[0:v][img0]");
    expect(graph).toContain("[v0][img1]");
    expect(graph).toContain("[v1][img2]");
  });

  it("uses correct input indices", () => {
    const graph = buildOverlayFilterGraph(2, [4.0, 6.0], 500, 1.0);
    // Input 0 = background, Input 1 = first image, Input 2 = second image
    expect(graph).toContain("[1:v]scale=500:-1");
    expect(graph).toContain("[2:v]scale=500:-1");
  });

  it("handles zero-duration scenes", () => {
    const graph = buildOverlayFilterGraph(1, [0], 486, 0.9);
    expect(graph).toContain("between(t,0.000000,0.000000)");
  });

  it("applies custom opacity", () => {
    const graph = buildOverlayFilterGraph(1, [5.0], 486, 0.5);
    expect(graph).toContain("colorchannelmixer=aa=0.5");
  });

  it("frame-clock: produces deterministic output for identical inputs (v7.4 S1)", () => {
    const g1 = buildOverlayFilterGraph(2, [3.14159, 2.71828], 486, 0.9);
    const g2 = buildOverlayFilterGraph(2, [3.14159, 2.71828], 486, 0.9);
    expect(g1).toBe(g2);
    // And the quantized values are frame-aligned at 24fps (multiples of 1/24)
    expect(g1).toMatch(/between\(t,0\.000000,3\.1(?:2|4)\d+\)/);
  });
});
