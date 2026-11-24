import { describe, it, expect, vi, beforeEach } from "vitest";

// This file reads the tool's description string and calls no handler. Every
// function export of the file modules ("fs", "node:fs"), the name-lookup modules
// ("dns", "node:dns") and the process modules ("child_process",
// "node:child_process") is replaced for the whole file by a stub that throws.
// The global fetch is replaced by a stub that throws, set before the imports
// and again before each test.
const stubbed = vi.hoisted(() => (real: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(real))
    out[k] =
      typeof v === "function"
        ? vi.fn(() => {
            throw new Error(`${k} is a stub in this file`);
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
vi.mock("dns", async (importOriginal) =>
  stubbed(await importOriginal<Record<string, unknown>>()),
);
vi.mock("node:dns", async (importOriginal) =>
  stubbed(await importOriginal<Record<string, unknown>>()),
);
vi.mock("child_process", async (importOriginal) =>
  stubbed(await importOriginal<Record<string, unknown>>()),
);
vi.mock("node:child_process", async (importOriginal) =>
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
import * as dns from "dns";
import * as nodeDns from "node:dns";
import * as childProcess from "child_process";
import * as nodeChildProcess from "node:child_process";
import { seoPageAuditTool } from "./seo-page-audit.js";

describe("seo_page_audit — the replaced modules", () => {
  it("every function export of the six replaced modules is a throwing mock, and fetch is the throwing stub", () => {
    for (const mod of [fs, nodeFs, dns, nodeDns, childProcess, nodeChildProcess]) {
      const fns = Object.entries(mod).filter(([, v]) => typeof v === "function");
      expect(fns.length).toBeGreaterThan(0);
      for (const [name, fn] of fns) expect(vi.isMockFunction(fn), name).toBe(true);
    }
    expect(() => (fs.writeFileSync as () => unknown)()).toThrow(/is a stub/);
    expect(() => (nodeDns.lookup as unknown as () => unknown)()).toThrow(/is a stub/);
    expect(() => (nodeChildProcess.execFile as unknown as () => unknown)()).toThrow(/is a stub/);
    expect(globalThis.fetch).toBe(fetchStub);
    expect(() => (globalThis.fetch as () => unknown)()).toThrow(/is a stub/);
  });
});

// Description pins: the tool's whole description text as registered.
describe("tool description texts", () => {
  it("seo_page_audit: the whole description", () => {
    expect(seoPageAuditTool.definition.function.description).toBe(`Technical SEO audit of a single URL. Fetches the page, parses title/meta/headings/schema/images/content, and scores 0-100 against a rubric with prioritized findings. Also tries to write the result to the seo_audits table for the operator's records.

USE WHEN:
- User asks to audit/analyze/review the SEO of a specific URL
- Checking technical SEO health after a content update
- Diagnosing why a page isn't ranking
- Preparing a fix list for on-page optimization

DO NOT USE WHEN:
- User wants a full site crawl (Phase 1 is single-page only)
- Need PageSpeed / Core Web Vitals scores (this tool does not measure them)
- User wants to generate new metadata (use seo_meta_generate when it is among your tools)
- User wants schema markup (use seo_schema_generate when it is among your tools)

RUBRIC (100 points):
- Title length 30-60 (10pt)
- Meta description 120-155 (20pt)
- H1 present and unique (10pt)
- JSON-LD structured data present (15pt)
- Image alt text coverage (15pt)
- Content length ≥300 words (10pt)
- H2 section structure for long content (10pt)
- Target keyword in title + H1 (10pt — only if target_keyword provided)

Returns score, prioritized issues (critical first), and a list of what's already good — all in-band in this result, so read them here now. The tool also tries to write the audit to seo_audits for the operator's records, but no tool can fetch that row back, so do not tell the user to "reference it later" or promise a follow-up lookup.`);
  });
});
