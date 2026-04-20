import { describe, it, expect } from "vitest";
import { chartSvg, type SvgBar } from "./chart-svg.js";

const BARS: SvgBar[] = [
  { time: "2026-04-01", open: 100, high: 102, low: 99, close: 101 },
  { time: "2026-04-02", open: 101, high: 103, low: 100, close: 102 },
  { time: "2026-04-03", open: 102, high: 104, low: 100, close: 101 }, // red
];

describe("chartSvg", () => {
  it("produces a well-formed SVG with the symbol in the title", () => {
    const svg = chartSvg({ symbol: "SPY", bars: BARS });
    expect(svg.startsWith(`<?xml version="1.0"`)).toBe(true);
    expect(svg).toContain("<svg ");
    expect(svg).toContain("</svg>");
    expect(svg).toContain("<title>SPY</title>");
  });

  it("draws one candlestick body per bar (rect count)", () => {
    const svg = chartSvg({ symbol: "SPY", bars: BARS });
    const rects = svg.match(/<rect /g) ?? [];
    // 1 background rect + 1 body per bar = 1 + BARS.length
    expect(rects.length).toBeGreaterThanOrEqual(1 + BARS.length);
  });

  it("colors up candles green and down candles red", () => {
    const svg = chartSvg({ symbol: "SPY", bars: BARS });
    expect(svg).toContain("#4ade80"); // green (up)
    expect(svg).toContain("#f87171"); // red (down)
  });

  it("renders a polyline for each overlay series with >=2 points", () => {
    const svg = chartSvg({
      symbol: "SPY",
      bars: BARS,
      overlays: [
        {
          label: "SMA20",
          color: "#60a5fa",
          data: [
            { time: "2026-04-01", value: 100.5 },
            { time: "2026-04-02", value: 101.1 },
            { time: "2026-04-03", value: 101.5 },
          ],
        },
      ],
    });
    expect(svg).toContain("<polyline");
    expect(svg).toContain('stroke="#60a5fa"');
    expect(svg).toContain("SMA20"); // legend label
  });

  it("drops overlays with <2 points (single-point series has nothing to draw)", () => {
    const svg = chartSvg({
      symbol: "SPY",
      bars: BARS,
      overlays: [{ label: "Spot", data: [{ time: "2026-04-01", value: 100 }] }],
    });
    expect(svg).not.toContain("<polyline");
  });

  it("draws arrow markers for buy/sell signals", () => {
    const svg = chartSvg({
      symbol: "SPY",
      bars: BARS,
      signals: [
        {
          time: "2026-04-01",
          position: "belowBar",
          shape: "arrowUp",
          text: "BUY",
        },
        {
          time: "2026-04-03",
          position: "aboveBar",
          shape: "arrowDown",
          text: "SELL",
        },
      ],
    });
    expect(svg).toContain("<polygon");
    expect(svg).toContain(">BUY</text>");
    expect(svg).toContain(">SELL</text>");
  });

  it("escapes XML special chars in symbol and overlay labels", () => {
    const svg = chartSvg({
      symbol: "<script>",
      bars: BARS,
      overlays: [
        {
          label: "&amp; more",
          data: [
            { time: "2026-04-01", value: 100 },
            { time: "2026-04-02", value: 101 },
          ],
        },
      ],
    });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("&amp;amp; more");
  });

  it("rejects empty bars", () => {
    expect(() => chartSvg({ symbol: "SPY", bars: [] })).toThrow(/empty/i);
  });

  it("rejects non-finite dimensions", () => {
    expect(() =>
      chartSvg({ symbol: "SPY", bars: BARS, width: Infinity }),
    ).toThrow(/finite/i);
    expect(() =>
      chartSvg({ symbol: "SPY", bars: BARS, height: Number.NaN }),
    ).toThrow(/finite/i);
  });

  it("rejects out-of-range dimensions", () => {
    expect(() => chartSvg({ symbol: "SPY", bars: BARS, width: 0 })).toThrow(
      /\(0, 4096\]/,
    );
    expect(() => chartSvg({ symbol: "SPY", bars: BARS, height: 5000 })).toThrow(
      /\(0, 4096\]/,
    );
  });

  it("handles dark theme (default) vs light theme backgrounds", () => {
    const dark = chartSvg({ symbol: "SPY", bars: BARS });
    const light = chartSvg({ symbol: "SPY", bars: BARS, theme: "light" });
    expect(dark).toContain('fill="#0f172a"'); // slate-900
    expect(light).toContain('fill="#ffffff"');
  });

  it("produces finite SVG when all bars have equal prices (degenerate range)", () => {
    const flat: SvgBar[] = [
      { time: "2026-04-01", open: 100, high: 100, low: 100, close: 100 },
      { time: "2026-04-02", open: 100, high: 100, low: 100, close: 100 },
    ];
    const svg = chartSvg({ symbol: "FLAT", bars: flat });
    expect(svg).toContain("<svg");
    expect(svg).not.toContain("NaN");
    expect(svg).not.toContain("Infinity");
  });
});
