/**
 * v7.1 — pure-TS SVG candlestick renderer.
 *
 * Produces a self-contained SVG string for a financial chart (candlestick +
 * line overlays + signal markers) without a browser, canvas, or any native
 * dependency. Used by `market_chart_render`. Optional PNG conversion is
 * handled downstream via ImageMagick (same pattern as v7.14.1 infographic).
 *
 * Design rationale (2026-04-20 pivot): headless Chromium on this VPS
 * crashes the renderer process on non-trivial HTML (same class as v7.12's
 * mermaid-cli hang). Switching to pure string-builder SVG eliminates the
 * browser dependency entirely — the output is simpler (no interactivity,
 * no hover) but that's exactly what a PNG snapshot needs.
 */

export interface SvgBar {
  time: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface SvgLineSeries {
  label: string;
  color?: string;
  data: Array<{ time: string; value: number }>;
}

export interface SvgSignalMarker {
  time: string;
  position: "aboveBar" | "belowBar" | "inBar";
  color?: string;
  shape: "arrowUp" | "arrowDown" | "circle" | "square";
  text?: string;
}

export interface ChartSvgOptions {
  symbol: string;
  bars: SvgBar[];
  overlays?: SvgLineSeries[];
  signals?: SvgSignalMarker[];
  width?: number;
  height?: number;
  theme?: "dark" | "light";
  title?: string;
}

const DEFAULTS = {
  width: 1280,
  height: 720,
  padding: { top: 48, right: 72, bottom: 48, left: 16 },
} as const;

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Format a price for the Y-axis ticks. */
function fmtPrice(v: number): string {
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 10) return v.toFixed(2);
  return v.toFixed(3);
}

/** Produce 4 tick positions (min, 1/3, 2/3, max) evenly spaced in price space. */
function priceTicks(min: number, max: number): number[] {
  if (max === min) return [min];
  const range = max - min;
  return [min, min + range / 3, min + (2 * range) / 3, max];
}

export function chartSvg(opts: ChartSvgOptions): string {
  const {
    symbol,
    bars,
    overlays = [],
    signals = [],
    width = DEFAULTS.width,
    height = DEFAULTS.height,
    theme = "dark",
    title,
  } = opts;

  if (bars.length === 0) throw new Error("chartSvg: bars array is empty");
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error("chartSvg: width and height must be finite numbers");
  }
  if (width <= 0 || height <= 0 || width > 4096 || height > 4096) {
    throw new Error("chartSvg: width/height must be in (0, 4096]");
  }

  const bg = theme === "dark" ? "#0f172a" : "#ffffff";
  const fg = theme === "dark" ? "#e2e8f0" : "#0f172a";
  const grid = theme === "dark" ? "#1e293b" : "#e2e8f0";
  const mutedFg = theme === "dark" ? "#94a3b8" : "#475569";
  const up = "#4ade80";
  const down = "#f87171";

  const { top, right, bottom, left } = DEFAULTS.padding;
  const plotW = width - left - right;
  const plotH = height - top - bottom;

  // Price range across bars + overlays (so overlay lines don't get clipped).
  let minPrice = Infinity;
  let maxPrice = -Infinity;
  for (const b of bars) {
    if (b.low < minPrice) minPrice = b.low;
    if (b.high > maxPrice) maxPrice = b.high;
  }
  for (const ov of overlays) {
    for (const pt of ov.data) {
      if (Number.isFinite(pt.value)) {
        if (pt.value < minPrice) minPrice = pt.value;
        if (pt.value > maxPrice) maxPrice = pt.value;
      }
    }
  }
  if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice)) {
    throw new Error("chartSvg: non-finite price data");
  }
  // Pad the y-range 2% top/bottom so candles don't touch the frame.
  const pad = (maxPrice - minPrice) * 0.02 || 0.5;
  minPrice -= pad;
  maxPrice += pad;
  const priceRange = maxPrice - minPrice;

  // Bar indexing: bar i maps to x = left + (i + 0.5) * (plotW / bars.length)
  const barW = plotW / bars.length;
  const candleW = Math.max(1, Math.min(24, barW * 0.7));

  const yFromPrice = (p: number): number =>
    top + ((maxPrice - p) / priceRange) * plotH;
  const xFromIndex = (i: number): number => left + (i + 0.5) * barW;

  // Build candlesticks.
  const candleEls: string[] = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const x = xFromIndex(i);
    const yHigh = yFromPrice(b.high);
    const yLow = yFromPrice(b.low);
    const yOpen = yFromPrice(b.open);
    const yClose = yFromPrice(b.close);
    const color = b.close >= b.open ? up : down;
    const bodyTop = Math.min(yOpen, yClose);
    const bodyBottom = Math.max(yOpen, yClose);
    const bodyH = Math.max(1, bodyBottom - bodyTop);
    // Wick
    candleEls.push(
      `<line x1="${x.toFixed(1)}" y1="${yHigh.toFixed(1)}" x2="${x.toFixed(1)}" y2="${yLow.toFixed(1)}" stroke="${color}" stroke-width="1"/>`,
    );
    // Body
    candleEls.push(
      `<rect x="${(x - candleW / 2).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${candleW.toFixed(1)}" height="${bodyH.toFixed(1)}" fill="${color}" stroke="${color}" stroke-width="0.5"/>`,
    );
  }

  // Overlay lines.
  const overlayEls: string[] = [];
  const timeIndex = new Map<string, number>();
  for (let i = 0; i < bars.length; i++) timeIndex.set(bars[i].time, i);
  for (const ov of overlays) {
    const pts: string[] = [];
    for (const pt of ov.data) {
      const idx = timeIndex.get(pt.time);
      if (idx === undefined || !Number.isFinite(pt.value)) continue;
      const x = xFromIndex(idx);
      const y = yFromPrice(pt.value);
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    if (pts.length >= 2) {
      const color = ov.color ?? "#60a5fa";
      overlayEls.push(
        `<polyline fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" points="${pts.join(" ")}"/>`,
      );
    }
  }

  // Signal markers.
  const markerEls: string[] = [];
  for (const s of signals) {
    const idx = timeIndex.get(s.time);
    if (idx === undefined) continue;
    const bar = bars[idx];
    const x = xFromIndex(idx);
    const color = s.color ?? "#fbbf24";
    const offset =
      s.position === "aboveBar" ? -10 : s.position === "belowBar" ? 10 : 0;
    const anchorY =
      s.position === "aboveBar"
        ? yFromPrice(bar.high)
        : s.position === "belowBar"
          ? yFromPrice(bar.low)
          : yFromPrice((bar.high + bar.low) / 2);
    const y = anchorY + offset;
    if (s.shape === "arrowUp") {
      markerEls.push(
        `<polygon points="${x.toFixed(1)},${(y + 6).toFixed(1)} ${(x - 5).toFixed(1)},${(y + 14).toFixed(1)} ${(x + 5).toFixed(1)},${(y + 14).toFixed(1)}" fill="${color}"/>`,
      );
    } else if (s.shape === "arrowDown") {
      markerEls.push(
        `<polygon points="${x.toFixed(1)},${(y - 6).toFixed(1)} ${(x - 5).toFixed(1)},${(y - 14).toFixed(1)} ${(x + 5).toFixed(1)},${(y - 14).toFixed(1)}" fill="${color}"/>`,
      );
    } else if (s.shape === "circle") {
      markerEls.push(
        `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="${color}"/>`,
      );
    } else {
      markerEls.push(
        `<rect x="${(x - 4).toFixed(1)}" y="${(y - 4).toFixed(1)}" width="8" height="8" fill="${color}"/>`,
      );
    }
    if (s.text) {
      const textY = s.position === "aboveBar" ? y - 18 : y + 26;
      markerEls.push(
        `<text x="${x.toFixed(1)}" y="${textY.toFixed(1)}" fill="${color}" font-size="11" text-anchor="middle" font-family="monospace">${escapeXml(s.text)}</text>`,
      );
    }
  }

  // Grid + axis ticks.
  const gridEls: string[] = [];
  const ticks = priceTicks(minPrice, maxPrice);
  for (const p of ticks) {
    const y = yFromPrice(p);
    gridEls.push(
      `<line x1="${left}" y1="${y.toFixed(1)}" x2="${(left + plotW).toFixed(1)}" y2="${y.toFixed(1)}" stroke="${grid}" stroke-width="0.5"/>`,
      `<text x="${(left + plotW + 6).toFixed(1)}" y="${(y + 4).toFixed(1)}" fill="${mutedFg}" font-size="11" font-family="monospace">${escapeXml(fmtPrice(p))}</text>`,
    );
  }
  // X-axis: first + last + middle date labels.
  const xLabels: Array<{ i: number; label: string }> = [];
  if (bars.length > 0) {
    xLabels.push({ i: 0, label: bars[0].time });
    if (bars.length > 2) {
      xLabels.push({
        i: Math.floor(bars.length / 2),
        label: bars[Math.floor(bars.length / 2)].time,
      });
    }
    if (bars.length > 1) {
      xLabels.push({ i: bars.length - 1, label: bars[bars.length - 1].time });
    }
  }
  for (const { i, label } of xLabels) {
    const x = xFromIndex(i);
    gridEls.push(
      `<text x="${x.toFixed(1)}" y="${(top + plotH + 24).toFixed(1)}" fill="${mutedFg}" font-size="11" text-anchor="middle" font-family="monospace">${escapeXml(label)}</text>`,
    );
  }

  // Overlay legend (top-left of plot area).
  const legendEls: string[] = [];
  let legendX = left + 8;
  const legendY = top - 16;
  for (const ov of overlays) {
    const color = ov.color ?? "#60a5fa";
    legendEls.push(
      `<rect x="${legendX.toFixed(1)}" y="${(legendY - 8).toFixed(1)}" width="10" height="10" fill="${color}"/>`,
      `<text x="${(legendX + 14).toFixed(1)}" y="${legendY.toFixed(1)}" fill="${mutedFg}" font-size="11" font-family="monospace">${escapeXml(ov.label)}</text>`,
    );
    legendX += 14 + ov.label.length * 7 + 16;
  }

  const safeSymbol = escapeXml(symbol);
  const safeTitle = escapeXml(title ?? symbol);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<title>${safeSymbol}</title>
<rect x="0" y="0" width="${width}" height="${height}" fill="${bg}"/>
<text x="16" y="22" fill="${fg}" font-size="14" font-family="sans-serif" font-weight="600">${safeTitle}</text>
${gridEls.join("\n")}
${candleEls.join("\n")}
${overlayEls.join("\n")}
${markerEls.join("\n")}
${legendEls.join("\n")}
</svg>`;
}
