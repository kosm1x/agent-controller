import { describe, it, expect, vi, beforeEach } from "vitest";

// This file reads the tool's description string and calls no handler. Every
// function export of both file-module specifiers ("fs" and "node:fs") is
// replaced for the whole file by a stub that throws; other exports stay real.
// The global fetch is replaced by a stub that throws, set before the imports
// and again before each test.
const stubbed = vi.hoisted(() => (real: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(real))
    out[k] =
      typeof v === "function"
        ? vi.fn(() => {
            throw new Error(`fs ${k} is a stub in this file`);
          })
        : v;
  out.default = out;
  return out;
});
vi.mock("fs", async (importOriginal) =>
  stubbed(await importOriginal<Record<string, unknown>>()),
);
vi.mock("node:fs", async (importOriginal) =>
  stubbed(await importOriginal<Record<string, unknown>>()),
);
const fetchStub = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("fetch is a stub in this file");
  }),
);
vi.hoisted(() => vi.stubGlobal("fetch", fetchStub));
beforeEach(() => {
  vi.stubGlobal("fetch", fetchStub);
});

import * as fs from "fs";
import * as nodeFs from "node:fs";
import { hfSpacesTool } from "./huggingface.js";

const DESCRIPTION = `Search and discover running HuggingFace Spaces. By default only shows running Gradio Spaces compatible with Pro subscription (ZeroGPU/GPU/CPU).

USE WHEN:
- The user asks to find a specific type of AI tool (image editor, video generator, music maker, etc.)
- You need to discover what Spaces are available for a task
- The user says "busca un space para...", "find a space for...", "qué herramientas hay en HuggingFace"

DO NOT USE WHEN:
- You want media made: this tool only lists Spaces and runs none of them — use hf_generate when it is among your tools.
- You want models or datasets: this tool searches only the HuggingFace Spaces listing.

Returns: name, likes, hardware, created date, and URL for each matching Space.`;

describe("hf_spaces — description text", () => {
  it("every function export of both fs specifiers is a throwing mock, and fetch is the throwing stub", () => {
    for (const mod of [fs, nodeFs]) {
      const fns = Object.entries(mod).filter(([, v]) => typeof v === "function");
      expect(fns.length).toBeGreaterThan(0);
      for (const [name, fn] of fns) expect(vi.isMockFunction(fn), name).toBe(true);
      expect(() => (mod.writeFileSync as () => unknown)()).toThrow(/is a stub/);
    }
    expect(globalThis.fetch).toBe(fetchStub);
    expect(() => (globalThis.fetch as () => unknown)()).toThrow(/is a stub/);
  });

  it("the whole description, with its not-for block", () => {
    expect(hfSpacesTool.definition.function.description).toBe(DESCRIPTION);
  });
});
