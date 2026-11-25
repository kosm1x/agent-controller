import { describe, it, expect, vi, beforeEach } from "vitest";

// Every outside effect of the renderer (data layer, file system, child
// process, path resolution) is replaced for the whole file. A call that a case
// did not prime throws, so an unexpected path fails instead of reaching the host.
const h = vi.hoisted(() => {
  const fx: Record<string, (...args: unknown[]) => unknown> = {};
  const call =
    (name: string) =>
    (...args: unknown[]): unknown => {
      const f = fx[name];
      if (!f) throw new Error(`unprimed outside effect: ${name}`);
      return f(...args);
    };
  const fsStub = () => ({
    writeFileSync: call("writeFileSync"),
    mkdirSync: call("mkdirSync"),
    statSync: call("statSync"),
    realpathSync: call("realpathSync"),
    unlinkSync: call("unlinkSync"),
    lstatSync: call("lstatSync"),
    readlinkSync: call("readlinkSync"),
  });
  const cpStub = () => ({ execFile: call("execFile") });
  return { fx, call, fsStub, cpStub };
});

vi.mock("../../finance/data-layer.js", () => ({
  getDataLayer: () => ({
    getDaily: h.call("getDaily"),
    getWeekly: h.call("getWeekly"),
  }),
}));
vi.mock("node:fs", () => h.fsStub());
vi.mock("fs", () => h.fsStub());
vi.mock("node:child_process", () => h.cpStub());
vi.mock("child_process", () => h.cpStub());
vi.mock("./write-guard.js", () => ({ realResolve: h.call("realResolve") }));

import { marketChartRenderTool } from "./market-chart-render.js";

function bars(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    symbol: "SYN",
    timestamp: `2026-03-${String(i + 1).padStart(2, "0")}T00:00:00-04:00`,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100.5 + i,
    volume: 1000,
    provider: "polygon",
    interval: "daily",
  }));
}

/** Primes one SVG render of the default output path; returns what was written. */
function primeRender(answer: Record<string, unknown>): string[] {
  const written: string[] = [];
  h.fx.getDaily = async () => answer;
  h.fx.mkdirSync = () => undefined;
  h.fx.realpathSync = (p) => p;
  h.fx.writeFileSync = (_path, data) => {
    written.push(String(data));
  };
  h.fx.statSync = () => ({ size: 1 });
  return written;
}

beforeEach(() => {
  for (const k of Object.keys(h.fx)) delete h.fx[k];
});

describe("market_chart_render — answers of stored rows (flagged stale)", () => {
  it("a flagged answer adds stale: true after interval and the STALE suffix to the title", async () => {
    const written = primeRender({
      bars: bars(30),
      provider: "polygon",
      stale: true,
    });
    const out = JSON.parse(
      await marketChartRenderTool.execute({ symbol: "SYN" }),
    ) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual([
      "ok",
      "path",
      "filename",
      "format",
      "size_bytes",
      "symbol",
      "interval",
      "stale",
      "bars_rendered",
      "indicators",
      "signals_rendered",
    ]);
    expect(out.stale).toBe(true);
    expect(written).toHaveLength(1);
    expect(written[0]).toContain(
      ">SYN · daily · 30 bars · STALE (providers unreachable)</text>",
    );
  });

  it("an answer that is not flagged has no stale key and no title suffix", async () => {
    const written = primeRender({ bars: bars(30), provider: "alpha_vantage" });
    const out = JSON.parse(
      await marketChartRenderTool.execute({ symbol: "SYN" }),
    ) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual([
      "ok",
      "path",
      "filename",
      "format",
      "size_bytes",
      "symbol",
      "interval",
      "bars_rendered",
      "indicators",
      "signals_rendered",
    ]);
    expect(written).toHaveLength(1);
    expect(written[0]).toContain(">SYN · daily · 30 bars</text>");
    expect(written[0]).not.toContain("STALE");
  });

  it("a flagged weekly answer adds stale: true and the STALE suffix to the title", async () => {
    const written = primeRender({ bars: bars(30), provider: "polygon", stale: true });
    h.fx.getWeekly = h.fx.getDaily;
    delete h.fx.getDaily;
    const out = JSON.parse(
      await marketChartRenderTool.execute({ symbol: "SYN", interval: "weekly" }),
    ) as Record<string, unknown>;
    expect(out.stale).toBe(true);
    expect(written[0]).toContain(
      ">SYN · weekly · 30 bars · STALE (providers unreachable)</text>",
    );
  });
});
