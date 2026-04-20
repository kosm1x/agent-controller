/**
 * v7.1 — market_chart_patterns tool.
 *
 * Vision-LLM classification of a chart PNG into named formations (head &
 * shoulders, triangle, wedge, flag, channel, etc.) with confidence ∈ [0,1].
 * Output is structured JSON + a row in `chart_patterns` (see F1 schema).
 *
 * Two input modes:
 *   - `chart_png_path` provided → classify the existing PNG
 *   - `symbol` + `interval` + `lookback_bars` → auto-render via
 *     market_chart_render, then classify (reuses the render handler)
 *
 * Pattern-agent prompt adopts QuantAgent's methodology (piece #2 in
 * `reference_quantagent.md`): plain-language pattern identification with
 * named formations + confidence + candle range location.
 *
 * F7 integration: patterns land in `chart_patterns`, NOT in F7's continuous
 * R(i,s) matrix. Future RRF (Reciprocal Rank Fusion) layer combines F7's
 * MegaAlpha rank with pattern rank — see
 * `docs/planning/phase-beta/11-v71-chart-deps.md` §5.
 */

import { readFileSync, lstatSync, realpathSync } from "node:fs";
import type { Tool } from "../types.js";
import { describeImage } from "../../inference/vision.js";
import {
  persistChartPattern,
  type ChartInterval,
} from "../../finance/chart-patterns-persist.js";
import { marketChartRenderTool } from "./market-chart-render.js";

const SOURCE_ALLOW_PREFIXES = ["/tmp/", "/workspace/"];
const INTERVALS = ["daily", "weekly"] as const;

const PATTERN_PROMPT = `You are a technical-analysis chart reader. Examine this financial price chart (candlestick + optional indicator overlays) and identify the strongest formation present. Choose ONE pattern label from:
- head_and_shoulders, inverse_head_and_shoulders
- double_top, double_bottom
- triple_top, triple_bottom
- ascending_triangle, descending_triangle, symmetrical_triangle
- rising_wedge, falling_wedge
- bull_flag, bear_flag
- ascending_channel, descending_channel, horizontal_channel
- cup_and_handle
- rounding_bottom, rounding_top
- breakout, breakdown
- none (no clear pattern)

Respond with ONLY a JSON object in this exact shape, no prose before or after:
{
  "pattern": "<label from list above>",
  "confidence": <number between 0 and 1>,
  "candle_start": <integer bar index where the pattern begins, or null>,
  "candle_end": <integer bar index where the pattern ends, or null>,
  "rationale": "<one sentence explaining the key features you saw>"
}

If no clear pattern, return {"pattern": "none", "confidence": 0, "candle_start": null, "candle_end": null, "rationale": "<why>"}.`;

interface ParsedPattern {
  pattern: string;
  confidence: number;
  candle_start: number | null;
  candle_end: number | null;
  rationale: string;
}

export function parseVisionResponse(raw: string): ParsedPattern | null {
  // Tolerate code fences, leading prose, trailing prose — extract the first
  // balanced {...} block.
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  const pattern = typeof obj.pattern === "string" ? obj.pattern.trim() : "";
  if (!pattern) return null;
  const confRaw = obj.confidence;
  let confidence = 0;
  if (typeof confRaw === "number" && Number.isFinite(confRaw)) {
    // Observability: log when the vision model returns an out-of-range
    // confidence — helps detect model drift (some VL models emit 1.5 / -0.2
    // consistently). The clamp below keeps the DB CHECK constraint happy.
    if (confRaw < 0 || confRaw > 1) {
      console.warn(
        `[chart-patterns] vision returned out-of-range confidence ${confRaw}, clamping to [0,1]`,
      );
    }
    confidence = Math.max(0, Math.min(1, confRaw));
  }
  const cs =
    typeof obj.candle_start === "number" && Number.isFinite(obj.candle_start)
      ? Math.floor(obj.candle_start)
      : null;
  const ce =
    typeof obj.candle_end === "number" && Number.isFinite(obj.candle_end)
      ? Math.floor(obj.candle_end)
      : null;
  const rationale =
    typeof obj.rationale === "string" ? obj.rationale.slice(0, 500) : "";
  return { pattern, confidence, candle_start: cs, candle_end: ce, rationale };
}

function validateSourcePath(
  raw: string,
): { ok: true; abs: string } | { ok: false; error: string } {
  const abs = raw;
  try {
    const lst = lstatSync(abs);
    if (lst.isSymbolicLink()) {
      return { ok: false, error: "chart_png_path must not be a symlink" };
    }
    if (!lst.isFile()) {
      return { ok: false, error: "chart_png_path must be a regular file" };
    }
    const canonical = realpathSync(abs);
    if (!SOURCE_ALLOW_PREFIXES.some((p) => canonical.startsWith(p))) {
      return {
        ok: false,
        error: `chart_png_path must resolve under one of: ${SOURCE_ALLOW_PREFIXES.join(", ")}`,
      };
    }
    return { ok: true, abs: canonical };
  } catch (err) {
    return {
      ok: false,
      error: `chart_png_path not readable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

async function renderIfNeeded(args: {
  chart_png_path?: string;
  symbol?: string;
  interval?: ChartInterval;
  lookback_bars?: number;
}): Promise<
  | { ok: true; png_path: string; symbol: string; interval: ChartInterval }
  | { ok: false; error: string }
> {
  if (args.chart_png_path) {
    const sourceCheck = validateSourcePath(args.chart_png_path);
    if (!sourceCheck.ok) return sourceCheck;
    return {
      ok: true,
      png_path: sourceCheck.abs,
      symbol: args.symbol ?? "",
      interval: args.interval ?? "daily",
    };
  }
  if (!args.symbol) {
    return { ok: false, error: "provide either chart_png_path or symbol" };
  }
  const interval: ChartInterval =
    args.interval && INTERVALS.includes(args.interval)
      ? args.interval
      : "daily";
  const renderRaw = await marketChartRenderTool.execute({
    symbol: args.symbol,
    interval,
    lookback_bars: args.lookback_bars,
  });
  let render: Record<string, unknown>;
  try {
    render = JSON.parse(renderRaw) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "chart render returned non-JSON" };
  }
  if (render.ok !== true || typeof render.path !== "string") {
    return {
      ok: false,
      error:
        typeof render.error === "string"
          ? `render failed: ${render.error}`
          : "render failed",
    };
  }
  return {
    ok: true,
    png_path: render.path,
    symbol: args.symbol,
    interval,
  };
}

export const marketChartPatternsTool: Tool = {
  name: "market_chart_patterns",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "market_chart_patterns",
      description: `Classify a financial chart into a named formation (head & shoulders, triangle, wedge, flag, channel, cup-and-handle, etc.) using a vision-language model.

USE WHEN:
- User asks "¿qué patrón ves en SPY?" / "what pattern is on AAPL?" / "is there a head and shoulders forming?"
- After market_chart_render produced a PNG the operator wants classified
- Building the signal layer for post-F7 RRF ranking fusion

DO NOT USE WHEN:
- You need raw OHLC data (use market_history)
- You need numeric indicators (use market_indicators)
- Chart is non-financial (use a different vision flow)

Two input modes:
1. Provide chart_png_path (absolute, under /tmp/ or /workspace/) — classify that PNG directly.
2. Provide symbol (+ optional interval, lookback_bars) — the tool auto-renders via market_chart_render first, then classifies.

Returns JSON: { pattern, confidence ∈ [0,1], candle_start, candle_end, rationale, pattern_id, png_path }.
Persists to chart_patterns table for later retrieval / RRF fusion.`,
      parameters: {
        type: "object",
        properties: {
          chart_png_path: {
            type: "string",
            description:
              "Absolute path to an existing PNG (must be under /tmp/ or /workspace/). If omitted, symbol is required.",
          },
          symbol: {
            type: "string",
            description: "Equity ticker (required if chart_png_path omitted)",
          },
          interval: {
            type: "string",
            enum: [...INTERVALS],
            description:
              "daily (default) or weekly — only used when auto-rendering",
          },
          lookback_bars: {
            type: "number",
            description: "20–520 (default 90) — only used when auto-rendering",
          },
        },
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const resolved = await renderIfNeeded({
      chart_png_path:
        typeof args.chart_png_path === "string"
          ? args.chart_png_path
          : undefined,
      symbol: typeof args.symbol === "string" ? args.symbol.trim() : undefined,
      interval:
        typeof args.interval === "string" &&
        INTERVALS.includes(args.interval as ChartInterval)
          ? (args.interval as ChartInterval)
          : undefined,
      lookback_bars:
        typeof args.lookback_bars === "number" &&
        Number.isFinite(args.lookback_bars)
          ? args.lookback_bars
          : undefined,
    });
    if (!resolved.ok) return JSON.stringify({ error: resolved.error });

    // Read PNG → base64 data URL
    let dataUrl: string;
    try {
      const bytes = readFileSync(resolved.png_path);
      dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
    } catch (err) {
      return JSON.stringify({
        error: "png_read_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    // Vision LLM call
    let raw: string;
    try {
      raw = await describeImage(dataUrl, PATTERN_PROMPT);
    } catch (err) {
      return JSON.stringify({
        error: "vision_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    const parsed = parseVisionResponse(raw);
    if (!parsed) {
      return JSON.stringify({
        error: "vision_parse_failed",
        raw: raw.slice(0, 500),
      });
    }

    // Persist
    let patternId: number;
    try {
      patternId = persistChartPattern({
        symbol: resolved.symbol || "UNKNOWN",
        interval: resolved.interval,
        pattern_label: parsed.pattern,
        confidence: parsed.confidence,
        candle_start: parsed.candle_start,
        candle_end: parsed.candle_end,
        png_path: resolved.png_path,
        rationale: parsed.rationale,
      });
    } catch (err) {
      return JSON.stringify({
        error: "persist_failed",
        message: err instanceof Error ? err.message : String(err),
        parsed,
      });
    }

    return JSON.stringify({
      ok: true,
      pattern_id: patternId,
      pattern: parsed.pattern,
      confidence: parsed.confidence,
      candle_start: parsed.candle_start,
      candle_end: parsed.candle_end,
      rationale: parsed.rationale,
      symbol: resolved.symbol || "UNKNOWN",
      interval: resolved.interval,
      png_path: resolved.png_path,
    });
  },
};
