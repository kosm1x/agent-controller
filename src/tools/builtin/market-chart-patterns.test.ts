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
  readFileSyncMock.mockReturnValue(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
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

describe("market_chart_patterns execute — bitmap check", () => {
  const VALID_REPLY =
    '{"pattern":"bull_flag","confidence":0.6,"candle_start":null,"candle_end":null,"rationale":"synthetic"}';
  const NOT_A_PNG = {
    error: "not_a_png",
    message:
      "the chart file is not a PNG image: render the chart with format png first, or pass a symbol instead of chart_png_path",
  };
  const VECTOR_TEXT = Buffer.from('<?xml version="1.0"?><svg></svg>');

  it("auto-render asks the chart tool for a PNG", async () => {
    renderExecuteMock.mockResolvedValue(
      JSON.stringify({ ok: true, path: "/tmp/chart-xyz.png" }),
    );
    primeCommon();
    describeImageMock.mockResolvedValue(VALID_REPLY);
    const { marketChartPatternsTool } =
      await import("./market-chart-patterns.js");
    await marketChartPatternsTool.execute({ symbol: "QQQ" });
    expect(renderExecuteMock.mock.calls[0][0]).toEqual({
      symbol: "QQQ",
      interval: "daily",
      lookback_bars: undefined,
      format: "png",
    });
  });

  it("a given chart file holding vector text is refused with no vision call and no stored row", async () => {
    primeCommon();
    readFileSyncMock.mockReturnValue(VECTOR_TEXT);
    describeImageMock.mockResolvedValue(VALID_REPLY);
    const { marketChartPatternsTool } =
      await import("./market-chart-patterns.js");
    const raw = await marketChartPatternsTool.execute({
      chart_png_path: "/tmp/chart-abc.png",
      symbol: "SPY",
    });
    expect({
      result: JSON.parse(raw),
      visionCalls: describeImageMock.mock.calls.length,
      persistCalls: persistChartPatternMock.mock.calls.length,
    }).toEqual({ result: NOT_A_PNG, visionCalls: 0, persistCalls: 0 });
  });

  it("an auto-rendered file holding vector text is refused with no vision call and no stored row", async () => {
    renderExecuteMock.mockResolvedValue(
      JSON.stringify({ ok: true, path: "/tmp/chart-xyz.png" }),
    );
    primeCommon();
    readFileSyncMock.mockReturnValue(VECTOR_TEXT);
    describeImageMock.mockResolvedValue(VALID_REPLY);
    const { marketChartPatternsTool } =
      await import("./market-chart-patterns.js");
    const raw = await marketChartPatternsTool.execute({ symbol: "QQQ" });
    expect({
      result: JSON.parse(raw),
      visionCalls: describeImageMock.mock.calls.length,
      persistCalls: persistChartPatternMock.mock.calls.length,
    }).toEqual({ result: NOT_A_PNG, visionCalls: 0, persistCalls: 0 });
  });

  it("a file matching only the first four signature bytes is refused", async () => {
    primeCommon();
    readFileSyncMock.mockReturnValue(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00]),
    );
    describeImageMock.mockResolvedValue(VALID_REPLY);
    const { marketChartPatternsTool } =
      await import("./market-chart-patterns.js");
    const raw = await marketChartPatternsTool.execute({
      chart_png_path: "/tmp/chart-abc.png",
    });
    expect({
      result: JSON.parse(raw),
      visionCalls: describeImageMock.mock.calls.length,
    }).toEqual({ result: NOT_A_PNG, visionCalls: 0 });
  });

  it("a file matching the first seven signature bytes but not the eighth is refused", async () => {
    primeCommon();
    readFileSyncMock.mockReturnValue(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x00]),
    );
    describeImageMock.mockResolvedValue(VALID_REPLY);
    const { marketChartPatternsTool } =
      await import("./market-chart-patterns.js");
    const raw = await marketChartPatternsTool.execute({
      chart_png_path: "/tmp/chart-abc.png",
    });
    expect({
      result: JSON.parse(raw),
      visionCalls: describeImageMock.mock.calls.length,
    }).toEqual({ result: NOT_A_PNG, visionCalls: 0 });
  });

  it("a file shorter than eight bytes is refused", async () => {
    primeCommon();
    readFileSyncMock.mockReturnValue(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    describeImageMock.mockResolvedValue(VALID_REPLY);
    const { marketChartPatternsTool } =
      await import("./market-chart-patterns.js");
    const raw = await marketChartPatternsTool.execute({
      chart_png_path: "/tmp/chart-abc.png",
    });
    expect({
      result: JSON.parse(raw),
      visionCalls: describeImageMock.mock.calls.length,
    }).toEqual({ result: NOT_A_PNG, visionCalls: 0 });
  });

  it("a PNG reaches the vision call labelled as a PNG and the stored row keeps the rendered path", async () => {
    renderExecuteMock.mockResolvedValue(
      JSON.stringify({ ok: true, path: "/tmp/chart-xyz.png" }),
    );
    primeCommon();
    describeImageMock.mockResolvedValue(VALID_REPLY);
    const { marketChartPatternsTool } =
      await import("./market-chart-patterns.js");
    await marketChartPatternsTool.execute({ symbol: "QQQ" });
    expect({
      visionImage: describeImageMock.mock.calls[0]?.[0],
      storedPath: persistChartPatternMock.mock.calls[0]?.[0]?.png_path,
    }).toEqual({
      visionImage: "data:image/png;base64,iVBORw0KGgo=",
      storedPath: "/tmp/chart-xyz.png",
    });
  });

  it("a failed conversion comes back as a render failure with no vision call", async () => {
    renderExecuteMock.mockResolvedValue(
      JSON.stringify({
        error: "png_convert_failed",
        message: "synthetic",
        hint: "synthetic",
      }),
    );
    const { marketChartPatternsTool } =
      await import("./market-chart-patterns.js");
    const raw = await marketChartPatternsTool.execute({ symbol: "QQQ" });
    expect({
      result: JSON.parse(raw),
      visionCalls: describeImageMock.mock.calls.length,
    }).toEqual({
      result: { error: "render failed: png_convert_failed" },
      visionCalls: 0,
    });
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
