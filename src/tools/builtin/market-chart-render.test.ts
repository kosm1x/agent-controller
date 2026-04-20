import { describe, it, expect, vi, afterEach } from "vitest";

const getDailyMock = vi.fn();
const getWeeklyMock = vi.fn();
const writeFileSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();
const statSyncMock = vi.fn();
const realpathSyncMock = vi.fn();
const unlinkSyncMock = vi.fn();
const execFileMock = vi.fn();

vi.mock("../../finance/data-layer.js", () => ({
  getDataLayer: () => ({
    getDaily: getDailyMock,
    getWeekly: getWeeklyMock,
  }),
}));

vi.mock("node:fs", async () => {
  const actual = (await vi.importActual("node:fs")) as Record<string, unknown>;
  return {
    ...actual,
    writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
    mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
    statSync: (...args: unknown[]) => statSyncMock(...args),
    realpathSync: (...args: unknown[]) => realpathSyncMock(...args),
    unlinkSync: (...args: unknown[]) => unlinkSyncMock(...args),
  };
});

// Mock execFile so PNG-convert path doesn't shell out in tests.
vi.mock("node:child_process", async () => {
  const actual = (await vi.importActual("node:child_process")) as Record<
    string,
    unknown
  >;
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: string[],
      opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => execFileMock(cmd, args, opts, cb),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  getDailyMock.mockReset();
  getWeeklyMock.mockReset();
  writeFileSyncMock.mockReset();
  mkdirSyncMock.mockReset();
  statSyncMock.mockReset();
  realpathSyncMock.mockReset();
  unlinkSyncMock.mockReset();
  execFileMock.mockReset();
});

function primeSuccessPath() {
  const bars = Array.from({ length: 30 }, (_, i) => ({
    symbol: "SPY",
    timestamp: `2026-03-${String(i + 1).padStart(2, "0")}T00:00:00-04:00`,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100.5 + i,
    volume: 1_000_000,
    provider: "alpha_vantage",
    interval: "daily",
  }));
  getDailyMock.mockResolvedValue({ bars, provider: "alpha_vantage" });
  statSyncMock.mockReturnValue({ size: 12345 });
  realpathSyncMock.mockImplementation((p: string) => p);
  // Happy-path execFile: callback with no error
  execFileMock.mockImplementation(
    (
      _cmd,
      _args,
      _opts,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => cb(null, "", ""),
  );
}

describe("market_chart_render execute", () => {
  it("default SVG dispatch writes file + returns ok JSON", async () => {
    primeSuccessPath();
    const { marketChartRenderTool } = await import("./market-chart-render.js");
    const raw = await marketChartRenderTool.execute({ symbol: "SPY" });
    const out = JSON.parse(raw);
    expect(out.ok).toBe(true);
    expect(out.symbol).toBe("SPY");
    expect(out.format).toBe("svg");
    expect(out.bars_rendered).toBe(30);
    expect(out.path).toMatch(/^\/tmp\/chart-[0-9a-f-]+\.svg$/);
    expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
    // First arg is path; second is SVG string starting with xml prolog.
    const firstCall = writeFileSyncMock.mock.calls[0];
    expect(firstCall[1]).toContain("<?xml");
    expect(firstCall[1]).toContain("<svg");
  });

  it("PNG dispatch shells out to convert and deletes the intermediate SVG", async () => {
    primeSuccessPath();
    const { marketChartRenderTool } = await import("./market-chart-render.js");
    const raw = await marketChartRenderTool.execute({
      symbol: "SPY",
      format: "png",
    });
    const out = JSON.parse(raw);
    expect(out.ok).toBe(true);
    expect(out.format).toBe("png");
    expect(out.path).toMatch(/^\/tmp\/chart-[0-9a-f-]+\.png$/);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0][0]).toBe("convert");
    // Intermediate SVG was .png.svg; must be cleaned up after success.
    expect(unlinkSyncMock).toHaveBeenCalledTimes(1);
    expect(unlinkSyncMock.mock.calls[0][0]).toMatch(/\.png\.svg$/);
  });

  it("png_convert_failed surfaces when convert errors, cleans up tmp SVG", async () => {
    primeSuccessPath();
    execFileMock.mockImplementation(
      (
        _cmd,
        _args,
        _opts,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => cb(new Error("convert: command not found"), "", ""),
    );
    const { marketChartRenderTool } = await import("./market-chart-render.js");
    const raw = await marketChartRenderTool.execute({
      symbol: "SPY",
      format: "png",
    });
    const out = JSON.parse(raw);
    expect(out.error).toBe("png_convert_failed");
    expect(out.hint).toMatch(/imagemagick/i);
    expect(unlinkSyncMock).toHaveBeenCalled();
  });

  it("empty symbol returns error", async () => {
    const { marketChartRenderTool } = await import("./market-chart-render.js");
    const out = JSON.parse(
      await marketChartRenderTool.execute({ symbol: "   " }),
    );
    expect(out.error).toMatch(/symbol required/);
  });

  it("rejects output_path with wrong extension for format", async () => {
    const { marketChartRenderTool } = await import("./market-chart-render.js");
    // format defaults to svg, output says .png
    const out = JSON.parse(
      await marketChartRenderTool.execute({
        symbol: "SPY",
        output_path: "/tmp/spy.png",
      }),
    );
    expect(out.error).toMatch(/\.svg/);
  });

  it("rejects output_path outside allow-list", async () => {
    const { marketChartRenderTool } = await import("./market-chart-render.js");
    const out = JSON.parse(
      await marketChartRenderTool.execute({
        symbol: "SPY",
        output_path: "/etc/evil.svg",
      }),
    );
    expect(out.error).toMatch(/allow-list|under one of/i);
  });

  it("weekly interval routes to getWeekly", async () => {
    primeSuccessPath();
    getWeeklyMock.mockResolvedValue({ bars: [], provider: "alpha_vantage" });
    const { marketChartRenderTool } = await import("./market-chart-render.js");
    const out = JSON.parse(
      await marketChartRenderTool.execute({
        symbol: "SPY",
        interval: "weekly",
      }),
    );
    expect(getWeeklyMock).toHaveBeenCalledTimes(1);
    expect(getDailyMock).not.toHaveBeenCalled();
    expect(out.error).toBe("no_bars");
  });

  it("filters indicators to supported subset (ignores made-up keys)", async () => {
    primeSuccessPath();
    const { marketChartRenderTool } = await import("./market-chart-render.js");
    const raw = await marketChartRenderTool.execute({
      symbol: "SPY",
      indicators: ["sma20", "totally_made_up", "bollinger"],
    });
    const out = JSON.parse(raw);
    expect(out.ok).toBe(true);
    // Indicator list in response is filtered to known keys only.
    expect(out.indicators).toEqual(["sma20", "bollinger"]);
  });

  it("filters signals to bars within the rendered window", async () => {
    primeSuccessPath();
    const { marketChartRenderTool } = await import("./market-chart-render.js");
    const raw = await marketChartRenderTool.execute({
      symbol: "SPY",
      signals: [
        { time: "2026-03-05", kind: "buy" }, // in window
        { time: "2000-01-01", kind: "sell" }, // not in window
      ],
    });
    const out = JSON.parse(raw);
    expect(out.signals_rendered).toBe(1);
  });

  it("data_fetch_failed surfaces on DataLayer error", async () => {
    getDailyMock.mockRejectedValue(new Error("AV budget exhausted"));
    const { marketChartRenderTool } = await import("./market-chart-render.js");
    const out = JSON.parse(
      await marketChartRenderTool.execute({ symbol: "SPY" }),
    );
    expect(out.error).toBe("data_fetch_failed");
    expect(out.message).toMatch(/budget exhausted/);
  });
});
