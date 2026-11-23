import { describe, it, expect, vi } from "vitest";

// This file only reads the dashboard tools' strings and calls no handler.
// For the whole file, every top-level function export of fs, node:fs,
// fs/promises, node:fs/promises, child_process and node:child_process is
// replaced by a stub that throws. Top-level exports that are not functions
// (objects such as fs.promises, constants) stay real, and the default export
// is the stub object itself, not the real module. The model adapter module is
// replaced by one that holds only infer and inferWithTools, both stubs that
// throw.
const stubbed = vi.hoisted(() => (label: string, real: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(real))
    out[k] =
      typeof v === "function"
        ? vi.fn(() => {
            throw new Error(`${label} ${k} is a stub in this file`);
          })
        : v;
  out.default = out;
  return out;
});
vi.mock("fs", async (importOriginal) =>
  stubbed("fs", await importOriginal<Record<string, unknown>>()),
);
vi.mock("node:fs", async (importOriginal) =>
  stubbed("node:fs", await importOriginal<Record<string, unknown>>()),
);
vi.mock("fs/promises", async (importOriginal) =>
  stubbed("fs/promises", await importOriginal<Record<string, unknown>>()),
);
vi.mock("node:fs/promises", async (importOriginal) =>
  stubbed("node:fs/promises", await importOriginal<Record<string, unknown>>()),
);
vi.mock("child_process", async (importOriginal) =>
  stubbed("child_process", await importOriginal<Record<string, unknown>>()),
);
vi.mock("node:child_process", async (importOriginal) =>
  stubbed("node:child_process", await importOriginal<Record<string, unknown>>()),
);
vi.mock("../../inference/adapter.js", () => ({
  infer: vi.fn(() => {
    throw new Error("adapter infer is a stub in this file");
  }),
  inferWithTools: vi.fn(() => {
    throw new Error("adapter inferWithTools is a stub in this file");
  }),
}));

import * as fs from "fs";
import * as nodeFs from "node:fs";
import * as fsPromises from "fs/promises";
import * as nodeFsPromises from "node:fs/promises";
import * as childProcess from "child_process";
import * as nodeChildProcess from "node:child_process";
import * as adapter from "../../inference/adapter.js";
import { dashboardGenerateTool, dashboardListTool } from "./dashboard.js";

describe("host safety of this file: every replaced function is a mock", () => {
  it("every function export of the six file and process specifiers (checked without calling one)", () => {
    const mods = { fs, nodeFs, fsPromises, nodeFsPromises, childProcess, nodeChildProcess };
    for (const [label, mod] of Object.entries(mods)) {
      const fns = Object.entries(mod).filter(([, v]) => typeof v === "function");
      expect(fns.length, label).toBeGreaterThan(0);
      for (const [name, fn] of fns) expect(vi.isMockFunction(fn), `${label}.${name}`).toBe(true);
    }
  });

  it("the writers dashboard_generate uses throw instead of touching the disk", () => {
    expect(() => (fs.writeFileSync as () => unknown)()).toThrow(/is a stub/);
    expect(() => (fs.mkdirSync as () => unknown)()).toThrow(/is a stub/);
  });

  it("the two model entry points are throwing mocks", () => {
    for (const fn of [adapter.infer, adapter.inferWithTools]) {
      expect(vi.isMockFunction(fn)).toBe(true);
      expect(() => (fn as () => unknown)()).toThrow(/is a stub/);
    }
  });
});

describe("model-visible descriptions (dashboard_generate, dashboard_list)", () => {
  it("dashboard_generate: the whole description", () => {
    expect(dashboardGenerateTool.definition.function.description).toBe(`Generate an interactive ECharts dashboard from data.

USE WHEN:
- User asks to visualize data, create a chart, or build a dashboard
- After querying data from sheets, CRM, or databases
- Creating reports with KPI cards + charts

DO NOT USE WHEN:
- You need an image to attach or send in a message: this tool returns a link to a web page that draws the charts in a browser, not an image — use chart_generate when it is among your tools.
- Your data is longer than about 5,000 characters: only the first 5,000 characters reach the model call that builds the charts, so later rows are left out.
- You need exact figures: the KPI cards and chart values are written by a model call from the data, not calculated by code.

Input: data (CSV/JSON string) + question (what to visualize).
Output: HTML file with interactive ECharts charts.
Serve via: GET /dashboard/{id}`);
  });
  it("dashboard_list: the whole description", () => {
    expect(dashboardListTool.definition.function.description).toBe(`List generated dashboards.

USE WHEN:
- User wants to see previously generated dashboards
- Looking up a dashboard URL

DO NOT USE WHEN:
- You want to know what a dashboard shows or when it was made: this tool returns only each dashboard's id, link and file path.
- You want a new or changed dashboard: this tool only lists — use dashboard_generate when it is among your tools; each dashboard it makes gets a new id.`);
  });
});
