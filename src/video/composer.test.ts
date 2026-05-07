import { describe, it, expect, vi, afterEach } from "vitest";
import { buildOverlayFilterGraph } from "./composer.js";

// Mock child_process for the per-scene clip fan-out test (no real ffmpeg)
const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));
vi.mock("child_process", async (importOriginal) => {
  const orig = (await importOriginal()) as typeof import("child_process");
  return {
    ...orig,
    execFile: (...args: unknown[]) => childProcessMocks.execFile(...args),
    execFileSync: (...args: unknown[]) =>
      childProcessMocks.execFileSync(...args),
  };
});

// Pin worker-pool sizing so the parallelism assertion below isn't host-dependent.
// Without this, a 1- or 2-core CI box yields pool size 1 and the `peak > 1`
// assertion fails for environment reasons rather than code reasons.
vi.mock("os", async (importOriginal) => {
  const orig = (await importOriginal()) as typeof import("os");
  return {
    ...orig,
    cpus: () =>
      Array(8).fill({
        model: "mock",
        speed: 0,
        times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
      }) as ReturnType<typeof orig.cpus>,
    freemem: () => 4 * 1024 * 1024 * 1024, // 4 GB free
  };
});

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

describe("composeVideo — v7.4 S1.1 parallel scene-clip generation", () => {
  afterEach(() => {
    childProcessMocks.execFile.mockReset();
    childProcessMocks.execFileSync.mockReset();
  });

  it("fans out per-scene clip ffmpeg calls via runPool (parallel observable)", async () => {
    let inflight = 0;
    let peak = 0;
    const callTimes: { kind: "clip" | "other"; t: number }[] = [];

    // execFile (async) — used for per-scene clip step via promisify
    childProcessMocks.execFile.mockImplementation(
      (
        _file: string,
        args: string[],
        _opts: unknown,
        cb: (e: Error | null, stdout?: string, stderr?: string) => void,
      ) => {
        const isClipStep = args.some((a) => /clip-\d{3}\.mp4$/.test(a));
        const kind = isClipStep ? "clip" : "other";
        if (isClipStep) {
          inflight++;
          peak = Math.max(peak, inflight);
        }
        callTimes.push({ kind, t: Date.now() });
        setTimeout(() => {
          if (isClipStep) inflight--;
          cb(null, "", "");
        }, 15);
      },
    );

    // execFileSync — used for concat + final encode steps
    childProcessMocks.execFileSync.mockImplementation(() => Buffer.from(""));

    const { composeVideo } = await import("./composer.js");
    const result = await composeVideo({
      jobId: `test-${Date.now()}`,
      script: {
        title: "t",
        scenes: [
          { text: "a", duration: 1, imageQuery: "x" },
          { text: "b", duration: 1, imageQuery: "x" },
          { text: "c", duration: 1, imageQuery: "x" },
          { text: "d", duration: 1, imageQuery: "x" },
        ],
        totalDuration: 4,
        language: "en",
      },
      imageFiles: ["/x/0.jpg", "/x/1.jpg", "/x/2.jpg", "/x/3.jpg"],
      audioFile: "/x/a.mp3",
      subtitleFile: "/nope/missing.srt", // existsSync false → no -vf subtitles branch
      template: "landscape",
    });

    expect(result).toMatch(/output\.mp4$/);

    // Verify all 4 clip ffmpeg calls happened
    const clipCalls = callTimes.filter((c) => c.kind === "clip");
    expect(clipCalls).toHaveLength(4);

    // Parallelism observable: with 8 mocked CPUs + 4GB mocked free mem,
    // computePoolSize() returns min(MAX_WORKERS=4, 8*0.5=4, 4096/512=8) = 4.
    // 4-task fan-out → peak inflight should hit 4 (or at least 2 worst case).
    expect(peak).toBeGreaterThanOrEqual(2);

    // Sequential downstream steps still run via execFileSync (concat + encode)
    expect(
      childProcessMocks.execFileSync.mock.calls.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("propagates per-scene ffmpeg failures with scene index", async () => {
    childProcessMocks.execFile.mockImplementation(
      (
        _file: string,
        args: string[],
        _opts: unknown,
        cb: (e: Error | null, stdout?: string, stderr?: string) => void,
      ) => {
        if (args.some((a) => /clip-001\.mp4$/.test(a))) {
          setTimeout(() => cb(new Error("ffmpeg exploded")), 5);
          return;
        }
        setTimeout(() => cb(null, "", ""), 5);
      },
    );
    childProcessMocks.execFileSync.mockImplementation(() => Buffer.from(""));

    const { composeVideo } = await import("./composer.js");
    await expect(
      composeVideo({
        jobId: `fail-${Date.now()}`,
        script: {
          title: "t",
          scenes: [
            { text: "a", duration: 1, imageQuery: "x" },
            { text: "b", duration: 1, imageQuery: "x" },
            { text: "c", duration: 1, imageQuery: "x" },
          ],
          totalDuration: 3,
          language: "en",
        },
        imageFiles: ["/x/0.jpg", "/x/1.jpg", "/x/2.jpg"],
        audioFile: "/x/a.mp3",
        subtitleFile: "/nope/missing.srt",
        template: "landscape",
      }),
    ).rejects.toThrow(/scene 1 ffmpeg failed/);
  });
});
