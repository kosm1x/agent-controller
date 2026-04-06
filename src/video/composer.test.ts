import { describe, it, expect } from "vitest";
import { buildOverlayFilterGraph } from "./composer.js";

describe("buildOverlayFilterGraph", () => {
  it("generates correct filter for 1 image", () => {
    const graph = buildOverlayFilterGraph(1, [5.0], 486, 0.9);
    expect(graph).toContain("enable='between(t,0.00,5.00)");
    expect(graph).toContain("scale=486:-1");
    expect(graph).toContain("colorchannelmixer=aa=0.9");
    expect(graph).toContain("[1:v]");
    expect(graph).toContain("[v0]");
  });

  it("generates correct timing for 3 images", () => {
    const graph = buildOverlayFilterGraph(3, [3.0, 5.0, 4.0], 486, 0.9);
    // First overlay: 0-3s
    expect(graph).toContain("between(t,0.00,3.00)");
    // Second overlay: 3-8s
    expect(graph).toContain("between(t,3.00,8.00)");
    // Third overlay: 8-12s
    expect(graph).toContain("between(t,8.00,12.00)");
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
    expect(graph).toContain("between(t,0.00,0.00)");
  });

  it("applies custom opacity", () => {
    const graph = buildOverlayFilterGraph(1, [5.0], 486, 0.5);
    expect(graph).toContain("colorchannelmixer=aa=0.5");
  });
});
