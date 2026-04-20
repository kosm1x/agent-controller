import { describe, it, expect, vi, afterEach } from "vitest";

const describeImageMock = vi.fn();
const persistChartPatternMock = vi.fn();
const readFileSyncMock = vi.fn();
const lstatSyncMock = vi.fn();
const realpathSyncMock = vi.fn();
const renderExecuteMock = vi.fn();

vi.mock("../../inference/vision.js", () => ({
  describeImage: describeImageMock,
}));

vi.mock("../../finance/chart-patterns-persist.js", () => ({
  persistChartPattern: persistChartPatternMock,
}));

vi.mock("node:fs", async () => {
  const actual = (await vi.importActual("node:fs")) as Record<string, unknown>;
  return {
    ...actual,
    readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
    lstatSync: (...args: unknown[]) => lstatSyncMock(...args),
    realpathSync: (...args: unknown[]) => realpathSyncMock(...args),
  };
});

vi.mock("./market-chart-render.js", () => ({
  marketChartRenderTool: {
    execute: renderExecuteMock,
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  describeImageMock.mockReset();
  persistChartPatternMock.mockReset();
  readFileSyncMock.mockReset();
  lstatSyncMock.mockReset();
  realpathSyncMock.mockReset();
  renderExecuteMock.mockReset();
});

function primeCommon() {
  lstatSyncMock.mockReturnValue({
    isSymbolicLink: () => false,
    isFile: () => true,
  });
  realpathSyncMock.mockReturnValue("/tmp/chart-abc.png");
  readFileSyncMock.mockReturnValue(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  persistChartPatternMock.mockReturnValue(42);
}

describe("parseVisionResponse", () => {
  it("parses a clean JSON response", async () => {
    const { parseVisionResponse } = await import("./market-chart-patterns.js");
    const out = parseVisionResponse(
      '{"pattern":"head_and_shoulders","confidence":0.82,"candle_start":12,"candle_end":40,"rationale":"neckline break confirmed"}',
    );
    expect(out?.pattern).toBe("head_and_shoulders");
    expect(out?.confidence).toBeCloseTo(0.82);
    expect(out?.candle_start).toBe(12);
    expect(out?.candle_end).toBe(40);
  });

  it("tolerates prose before/after the JSON block", async () => {
    const { parseVisionResponse } = await import("./market-chart-patterns.js");
    const out = parseVisionResponse(
      'Looking at the chart... {"pattern":"bull_flag","confidence":0.61,"candle_start":null,"candle_end":null,"rationale":"tight pullback"} Hope this helps!',
    );
    expect(out?.pattern).toBe("bull_flag");
  });

  it("clamps confidence to [0,1]", async () => {
    const { parseVisionResponse } = await import("./market-chart-patterns.js");
    expect(
      parseVisionResponse('{"pattern":"x","confidence":1.5}')?.confidence,
    ).toBe(1);
    expect(
      parseVisionResponse('{"pattern":"x","confidence":-3}')?.confidence,
    ).toBe(0);
  });

  it("returns null when JSON parse fails", async () => {
    const { parseVisionResponse } = await import("./market-chart-patterns.js");
    expect(parseVisionResponse("not json at all")).toBeNull();
    expect(parseVisionResponse('{"pattern":')).toBeNull();
  });

  it("returns null when pattern field is missing", async () => {
    const { parseVisionResponse } = await import("./market-chart-patterns.js");
    expect(parseVisionResponse('{"confidence":0.5}')).toBeNull();
  });
});

describe("market_chart_patterns execute — PNG-path input", () => {
  it("classifies an existing PNG and persists", async () => {
    primeCommon();
    describeImageMock.mockResolvedValue(
      '{"pattern":"ascending_triangle","confidence":0.71,"candle_start":5,"candle_end":28,"rationale":"rising lows w/ flat top"}',
    );
    const { marketChartPatternsTool } =
      await import("./market-chart-patterns.js");
    const raw = await marketChartPatternsTool.execute({
      chart_png_path: "/tmp/chart-abc.png",
      symbol: "SPY",
      interval: "daily",
    });
    const out = JSON.parse(raw);
    expect(out.ok).toBe(true);
    expect(out.pattern).toBe("ascending_triangle");
    expect(out.pattern_id).toBe(42);
    expect(persistChartPatternMock).toHaveBeenCalledTimes(1);
    expect(renderExecuteMock).not.toHaveBeenCalled();
  });

  it("rejects symlink source paths", async () => {
    lstatSyncMock.mockReturnValue({
      isSymbolicLink: () => true,
      isFile: () => false,
    });
    const { marketChartPatternsTool } =
      await import("./market-chart-patterns.js");
    const raw = await marketChartPatternsTool.execute({
      chart_png_path: "/tmp/evil-link.png",
    });
    expect(JSON.parse(raw).error).toMatch(/symlink/);
  });

  it("rejects source paths that canonicalize outside allow-list", async () => {
    lstatSyncMock.mockReturnValue({
      isSymbolicLink: () => false,
      isFile: () => true,
    });
    realpathSyncMock.mockReturnValue("/etc/shadow");
    const { marketChartPatternsTool } =
      await import("./market-chart-patterns.js");
    const raw = await marketChartPatternsTool.execute({
      chart_png_path: "/tmp/chart-abc.png",
    });
    expect(JSON.parse(raw).error).toMatch(/allow-list|under one of/i);
  });
});

describe("market_chart_patterns execute — auto-render input", () => {
  it("symbol only → auto-renders then classifies", async () => {
    renderExecuteMock.mockResolvedValue(
      JSON.stringify({ ok: true, path: "/tmp/chart-xyz.png" }),
    );
    primeCommon();
    describeImageMock.mockResolvedValue(
      '{"pattern":"bear_flag","confidence":0.58,"candle_start":null,"candle_end":null,"rationale":"weak bounce in downtrend"}',
    );
    const { marketChartPatternsTool } =
      await import("./market-chart-patterns.js");
    const raw = await marketChartPatternsTool.execute({ symbol: "QQQ" });
    const out = JSON.parse(raw);
    expect(out.ok).toBe(true);
    expect(out.pattern).toBe("bear_flag");
    expect(renderExecuteMock).toHaveBeenCalledTimes(1);
  });

  it("no symbol and no chart_png_path → error", async () => {
    const { marketChartPatternsTool } =
      await import("./market-chart-patterns.js");
    const raw = await marketChartPatternsTool.execute({});
    expect(JSON.parse(raw).error).toMatch(/chart_png_path or symbol/);
  });

  it("render failure propagates as error", async () => {
    renderExecuteMock.mockResolvedValue(
      JSON.stringify({ error: "no_bars", symbol: "XYZ" }),
    );
    const { marketChartPatternsTool } =
      await import("./market-chart-patterns.js");
    const raw = await marketChartPatternsTool.execute({ symbol: "XYZ" });
    expect(JSON.parse(raw).error).toMatch(/render failed/);
  });
});

describe("market_chart_patterns execute — vision + persist paths", () => {
  it("vision_parse_failed on unparseable LLM output", async () => {
    primeCommon();
    describeImageMock.mockResolvedValue("I cannot read this chart, sorry.");
    const { marketChartPatternsTool } =
      await import("./market-chart-patterns.js");
    const raw = await marketChartPatternsTool.execute({
      chart_png_path: "/tmp/chart-abc.png",
      symbol: "SPY",
    });
    expect(JSON.parse(raw).error).toBe("vision_parse_failed");
  });

  it("vision_failed when describeImage throws", async () => {
    primeCommon();
    describeImageMock.mockRejectedValue(new Error("HTTP 503"));
    const { marketChartPatternsTool } =
      await import("./market-chart-patterns.js");
    const raw = await marketChartPatternsTool.execute({
      chart_png_path: "/tmp/chart-abc.png",
      symbol: "SPY",
    });
    expect(JSON.parse(raw).error).toBe("vision_failed");
  });
});
