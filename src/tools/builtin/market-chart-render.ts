/**
 * v7.1 — market_chart_render tool.
 *
 * Renders a candlestick chart (OHLCV) with optional indicator overlays and
 * signal markers to a self-contained SVG (default) or PNG (via ImageMagick
 * `convert`). Pure-TS string-builder render — no browser, no canvas, no
 * native deps beyond the apt `convert` binary that v7.14.1 already requires
 * for infographic PNG output.
 *
 * Scope group: `chart` (added in v7.1). Deferred — only loaded when the
 * chart scope regex fires.
 */

import {
  writeFileSync,
  mkdirSync,
  statSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Tool } from "../types.js";
import { getDataLayer } from "../../finance/data-layer.js";
import { chartSvg } from "../../finance/chart-svg.js";
import { sma, ema, bollingerBands, vwap } from "../../finance/indicators.js";
import type { MarketBar } from "../../finance/types.js";
import type {
  SvgLineSeries,
  SvgSignalMarker,
} from "../../finance/chart-svg.js";

const execFileAsync = promisify(execFile);

const OUTPUT_ALLOW_PREFIXES = ["/tmp/", "/workspace/"];
const PNG_CONVERT_TIMEOUT_MS = 20_000;
const INTERVALS = ["daily", "weekly"] as const;
type Interval = (typeof INTERVALS)[number];
const SUPPORTED_INDICATORS = [
  "sma20",
  "sma50",
  "sma200",
  "ema20",
  "ema50",
  "bollinger",
  "vwap",
] as const;
type IndicatorKey = (typeof SUPPORTED_INDICATORS)[number];
const FORMATS = ["svg", "png"] as const;
type OutputFormat = (typeof FORMATS)[number];

interface SignalInput {
  time: string;
  kind: "buy" | "sell" | "note";
  text?: string;
}

function toLineSeries(
  label: string,
  color: string,
  values: (number | null)[],
  bars: MarketBar[],
): SvgLineSeries {
  const data: SvgLineSeries["data"] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v !== null && Number.isFinite(v)) {
      data.push({ time: bars[i].timestamp.slice(0, 10), value: v });
    }
  }
  return { label, color, data };
}

function computeOverlays(
  bars: MarketBar[],
  keys: IndicatorKey[],
): SvgLineSeries[] {
  const out: SvgLineSeries[] = [];
  const closes = bars.map((b) => b.close);
  for (const k of keys) {
    if (k === "sma20")
      out.push(toLineSeries("SMA20", "#60a5fa", sma(closes, 20), bars));
    if (k === "sma50")
      out.push(toLineSeries("SMA50", "#a78bfa", sma(closes, 50), bars));
    if (k === "sma200")
      out.push(toLineSeries("SMA200", "#f472b6", sma(closes, 200), bars));
    if (k === "ema20")
      out.push(toLineSeries("EMA20", "#34d399", ema(closes, 20), bars));
    if (k === "ema50")
      out.push(toLineSeries("EMA50", "#fb923c", ema(closes, 50), bars));
    if (k === "bollinger") {
      const bb = bollingerBands(closes, 20, 2);
      out.push(toLineSeries("BB upper", "#94a3b8", bb.upper, bars));
      out.push(toLineSeries("BB mid", "#64748b", bb.middle, bars));
      out.push(toLineSeries("BB lower", "#94a3b8", bb.lower, bars));
    }
    if (k === "vwap") {
      out.push(
        toLineSeries(
          "VWAP",
          "#fbbf24",
          vwap(
            bars.map((b) => b.high),
            bars.map((b) => b.low),
            bars.map((b) => b.close),
            bars.map((b) => b.volume),
          ),
          bars,
        ),
      );
    }
  }
  return out;
}

function mapSignals(signals: SignalInput[]): SvgSignalMarker[] {
  return signals.map((s) => {
    if (s.kind === "buy") {
      return {
        time: s.time,
        position: "belowBar",
        color: "#4ade80",
        shape: "arrowUp",
        text: s.text ?? "BUY",
      };
    }
    if (s.kind === "sell") {
      return {
        time: s.time,
        position: "aboveBar",
        color: "#f87171",
        shape: "arrowDown",
        text: s.text ?? "SELL",
      };
    }
    return {
      time: s.time,
      position: "aboveBar",
      color: "#fbbf24",
      shape: "circle",
      text: s.text ?? "",
    };
  });
}

export function resolveChartOutputPath(
  raw: string | undefined,
  format: OutputFormat,
): { ok: true; abs: string } | { ok: false; error: string } {
  const ext = "." + format;
  if (!raw) {
    const name = `chart-${randomUUID()}${ext}`;
    return { ok: true, abs: resolve("/tmp/", name) };
  }
  const abs = resolve(raw);
  if (!abs.toLowerCase().endsWith(ext)) {
    return { ok: false, error: `output_path must end with ${ext}` };
  }
  if (!OUTPUT_ALLOW_PREFIXES.some((p) => abs.startsWith(p))) {
    return {
      ok: false,
      error: `output_path must be under one of: ${OUTPUT_ALLOW_PREFIXES.join(", ")}`,
    };
  }
  const parent = dirname(abs);
  try {
    const p = realpathSync(parent);
    const withSlash = p.endsWith("/") ? p : p + "/";
    if (!OUTPUT_ALLOW_PREFIXES.some((prefix) => withSlash.startsWith(prefix))) {
      return { ok: false, error: "output_path parent escapes allow-list" };
    }
  } catch {
    // Parent doesn't exist yet — we'll mkdir below; re-canonicalize then.
  }
  return { ok: true, abs };
}

export const marketChartRenderTool: Tool = {
  name: "market_chart_render",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "market_chart_render",
      description: `Render a financial chart to SVG or PNG (candlestick + optional indicator overlays + optional signal markers).

USE WHEN:
- User asks for a chart, gráfico, price chart, candlestick of a symbol
- Want to visualize an indicator overlay (SMA, EMA, Bollinger, VWAP) on OHLC
- Need to render an image for market_chart_patterns classification

DO NOT USE WHEN:
- Generic non-financial chart (use chart_generate for bar/line/pie of arbitrary numbers)

Interval: "daily" (default) or "weekly". Lookback bounded to [20, 520] bars.
Indicators subset: sma20, sma50, sma200, ema20, ema50, bollinger, vwap.
Signals: array of { time (YYYY-MM-DD), kind: buy|sell|note, text? } — plotted as arrows above/below bars.
Format: svg (default, faster) or png (via ImageMagick \`convert\`, WhatsApp/Telegram-friendly).
Output: file path under /tmp/ or /workspace/. Default /tmp/chart-<uuid>.{svg|png}.`,
      parameters: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: "Equity ticker, e.g. SPY, AAPL",
          },
          interval: {
            type: "string",
            enum: [...INTERVALS],
            description: "Bar interval",
          },
          lookback_bars: {
            type: "number",
            description: "How many recent bars to render (20–520, default 90)",
          },
          indicators: {
            type: "array",
            items: { type: "string", enum: [...SUPPORTED_INDICATORS] },
            description: "Indicator overlays to draw on the price pane",
          },
          signals: {
            type: "array",
            items: {
              type: "object",
              properties: {
                time: { type: "string", description: "YYYY-MM-DD" },
                kind: { type: "string", enum: ["buy", "sell", "note"] },
                text: { type: "string" },
              },
              required: ["time", "kind"],
            },
          },
          format: {
            type: "string",
            enum: [...FORMATS],
            description: "svg (default) or png",
          },
          output_path: {
            type: "string",
            description:
              "Absolute output path (extension must match format), under /tmp/ or /workspace/",
          },
          theme: {
            type: "string",
            enum: ["dark", "light"],
            description: "Visual theme",
          },
          width: {
            type: "number",
            description: "Chart width in px (default 1280)",
          },
          height: {
            type: "number",
            description: "Chart height in px (default 720)",
          },
        },
        required: ["symbol"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const symbol = typeof args.symbol === "string" ? args.symbol.trim() : "";
    if (!symbol) return JSON.stringify({ error: "symbol required" });

    const interval: Interval = INTERVALS.includes(args.interval as Interval)
      ? (args.interval as Interval)
      : "daily";

    const lookbackRaw = args.lookback_bars;
    const lookback =
      typeof lookbackRaw === "number" && Number.isFinite(lookbackRaw)
        ? Math.max(20, Math.min(520, Math.floor(lookbackRaw)))
        : 90;

    const rawIndicators = Array.isArray(args.indicators) ? args.indicators : [];
    const indicators: IndicatorKey[] = rawIndicators.filter(
      (k): k is IndicatorKey =>
        SUPPORTED_INDICATORS.includes(k as IndicatorKey),
    );

    const signalsRaw = Array.isArray(args.signals) ? args.signals : [];
    const signals: SignalInput[] = [];
    for (const s of signalsRaw) {
      if (
        s &&
        typeof s === "object" &&
        typeof (s as SignalInput).time === "string" &&
        ["buy", "sell", "note"].includes((s as SignalInput).kind)
      ) {
        signals.push(s as SignalInput);
      }
    }

    const format: OutputFormat = FORMATS.includes(args.format as OutputFormat)
      ? (args.format as OutputFormat)
      : "svg";
    const theme = args.theme === "light" ? "light" : "dark";
    const width =
      typeof args.width === "number" &&
      Number.isFinite(args.width) &&
      args.width > 0 &&
      args.width <= 4096
        ? args.width
        : 1280;
    const height =
      typeof args.height === "number" &&
      Number.isFinite(args.height) &&
      args.height > 0 &&
      args.height <= 4096
        ? args.height
        : 720;

    const outputCheck = resolveChartOutputPath(
      args.output_path as string | undefined,
      format,
    );
    if (!outputCheck.ok) return JSON.stringify({ error: outputCheck.error });

    // Fetch bars
    let bars: MarketBar[];
    try {
      const dl = getDataLayer();
      const res =
        interval === "daily"
          ? await dl.getDaily(symbol, { lookback })
          : await dl.getWeekly(symbol, { lookback });
      bars = res.bars;
    } catch (err) {
      return JSON.stringify({
        error: "data_fetch_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    if (bars.length === 0) {
      return JSON.stringify({ error: "no_bars", symbol, interval });
    }

    const barDates = new Set(bars.map((b) => b.timestamp.slice(0, 10)));
    const filteredSignals = signals.filter((s) => barDates.has(s.time));

    const chartBars = bars.map((b) => ({
      time: b.timestamp.slice(0, 10),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
    }));

    const overlays = computeOverlays(bars, indicators);

    let svg: string;
    try {
      svg = chartSvg({
        symbol: symbol.toUpperCase(),
        bars: chartBars,
        overlays,
        signals: mapSignals(filteredSignals),
        width,
        height,
        theme,
        title: `${symbol.toUpperCase()} · ${interval} · ${bars.length} bars`,
      });
    } catch (err) {
      return JSON.stringify({
        error: "render_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    // Re-canonicalize parent AFTER mkdir to defeat TOCTOU.
    try {
      const parent = dirname(outputCheck.abs);
      mkdirSync(parent, { recursive: true });
      const canonicalParent = realpathSync(parent);
      const withSlash = canonicalParent.endsWith("/")
        ? canonicalParent
        : canonicalParent + "/";
      if (!OUTPUT_ALLOW_PREFIXES.some((p) => withSlash.startsWith(p))) {
        return JSON.stringify({
          error: "output_parent_escaped_allow_list",
          canonical: canonicalParent,
        });
      }
    } catch (err) {
      return JSON.stringify({
        error: "write_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    // Write SVG first. For PNG, convert via ImageMagick then delete the SVG.
    let svgTmp: string;
    if (format === "svg") {
      svgTmp = outputCheck.abs;
    } else {
      svgTmp = outputCheck.abs + ".svg";
    }
    try {
      writeFileSync(svgTmp, svg);
    } catch (err) {
      return JSON.stringify({
        error: "write_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    if (format === "png") {
      try {
        await execFileAsync("convert", [svgTmp, outputCheck.abs], {
          timeout: PNG_CONVERT_TIMEOUT_MS,
        });
      } catch (err) {
        try {
          unlinkSync(svgTmp);
        } catch {
          /* ignore */
        }
        return JSON.stringify({
          error: "png_convert_failed",
          message: err instanceof Error ? err.message : String(err),
          hint: "ensure ImageMagick is installed (apt install imagemagick)",
        });
      }
      try {
        unlinkSync(svgTmp);
      } catch {
        /* ignore */
      }
    }

    let sizeBytes = 0;
    try {
      sizeBytes = statSync(outputCheck.abs).size;
    } catch {
      /* ignore */
    }

    return JSON.stringify({
      ok: true,
      path: outputCheck.abs,
      filename: basename(outputCheck.abs),
      format,
      size_bytes: sizeBytes,
      symbol: symbol.toUpperCase(),
      interval,
      bars_rendered: bars.length,
      indicators,
      signals_rendered: filteredSignals.length,
    });
  },
};
