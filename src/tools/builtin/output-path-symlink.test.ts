/**
 * Output-path validators against the real filesystem (the tools' own test
 * files mock node:fs). audit 2026-09-22 R2 sweep: the literal spelling was
 * checked, so a symlink under /tmp/ sent the write elsewhere.
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "fs";
import { resolveOutputPath as diagramOut } from "./diagram-generate.js";
import { resolveOutputPath as infographicOut } from "./infographic-generate.js";
import { validateOutputPath as convertOut } from "./file-convert.js";
import { resolveChartOutputPath as chartOut } from "./market-chart-render.js";
import { resolveSafeOutputPath as driveOut } from "./google-drive.js";

const dir = mkdtempSync("/tmp/out-sym-");
const outside = mkdtempSync("/var/tmp/out-sym-");
symlinkSync(outside, `${dir}/lnk`);
mkdirSync("/tmp/jarvis-downloads", { recursive: true });
const dl = mkdtempSync("/tmp/jarvis-downloads/out-sym-");
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(dl, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("output-path validators follow symlinks", () => {
  it.each([
    ["diagram_generate", () => diagramOut(`${dir}/lnk/x.svg`, "svg")],
    ["infographic_generate", () => infographicOut(`${dir}/lnk/x.svg`, "svg")],
    ["file_convert", () => convertOut(`${dir}/lnk/x.pdf`, "pdf")],
    ["market_chart_render", () => chartOut(`${dir}/lnk/x.svg`, "svg")],
  ])(
    "%s refuses a path through a symlink leaving the allow-list",
    (_n, run) => {
      const r = run();
      expect(r.ok).toBe(false);
      expect(r.ok ? "" : r.error).toMatch(/outside|escapes/);
    },
  );

  it("market_chart_render refuses a dangling leaf link (its parent check passed)", () => {
    symlinkSync(`${outside}/y.svg`, `${dir}/leaf.svg`);
    expect(chartOut(`${dir}/leaf.svg`, "svg").ok).toBe(false);
  });

  it("market_chart_render gates the written path, not the `dir-link/..` spelling (R3)", () => {
    mkdirSync(`${dir}/a/b`, { recursive: true });
    symlinkSync(`${dir}/a/b`, `${dir}/dl`);
    symlinkSync(`${outside}/z.svg`, `${dir}/z.svg`);
    // resolve() writes ${dir}/z.svg (the link); the kernel walk of the
    // spelling lands on the missing ${dir}/a/z.svg.
    const r = chartOut(`${dir}/dl/../z.svg`, "svg");
    expect(r.ok ? "" : r.error).toMatch(/resolves outside/);
  });

  it("google_drive download refuses a symlinked leaf (R3 sweep)", () => {
    symlinkSync(`${outside}/f.pdf`, `${dl}/f.pdf`);
    const r = driveOut(`${dl}/f.pdf`);
    expect(r.safe ? "" : r.reason).toMatch(/symlinks outside the whitelist/);
    expect(driveOut(`${dl}/plain.pdf`).safe).toBe(true);
  });

  it("keeps a plain path under /tmp/", () => {
    expect(diagramOut(`${dir}/x.svg`, "svg").ok).toBe(true);
    expect(convertOut(`${dir}/x.pdf`, "pdf").ok).toBe(true);
    expect(chartOut(`${dir}/x.svg`, "svg").ok).toBe(true);
  });
});
