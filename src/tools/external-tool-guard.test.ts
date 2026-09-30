/**
 * External KB policy (opt-in) + tool guard (jarvis-pull): tool allow-list,
 * jarvis_file_read row check (path + tags), and path filtering of
 * jarvis_file_read / _search / _list results.
 */

import { describe, expect, it, vi } from "vitest";
import {
  PATH_NOT_AVAILABLE,
  RESULT_NOT_AVAILABLE,
  TOOL_NOT_AVAILABLE,
  externalToolArgs,
  externalToolGuard,
  filterExternalToolResult,
} from "./external-tool-guard.js";
import {
  EXTERNAL_ENFORCE_PATHS,
  EXTERNAL_KB_SEED_PREFIXES,
  isExternalKbInjectable,
  isExternalKbRowAllowed,
} from "../lib/external-kb-policy.js";

const TOOLS = ["jarvis_file_read", "jarvis_file_search", "jarvis_file_list", "web_search"];
const SEED = "knowledge/domain/tv-abierta-panorama.md";
const SEED_DOC = "knowledge/domain/tv-ratings-2026.md";
const PRIVATE = "knowledge/health/sleep.md";
const TAGS_EXTERNAL = JSON.stringify(["crm", "external"]);

describe("external KB policy — opt-in only", () => {
  it.each([
    "projects/juicio-modificacion/README.md",
    "knowledge/health/x.md",
    "knowledge/preferences/x.md",
    "projects/plan-2027/health/sleep-score.md",
    "knowledge/domain/work-profile.md",
    "knowledge/people/someone.md",
    "projects/session-brief/CURRENT.md",
    "INDEX.md",
    "directives/core.md",
    // Project folders are not seeded (qa R3 C1): people, dev logs, findings.
    "projects/expansion-crm/organigrama.md",
    "projects/pulso-aura-upfront/README.md",
    "projects/azteca-tvpromo-compete/README.md",
    "projects/monetizacion-tva/x.md",
    "projects/plan-2027/pulso-aura-upfront.md",
    // qa R4 W2: confidential comparison, another business's DENUE docs, and
    // a project folder with a Drive link.
    "knowledge/domain/comparativa-tv-azteca-televisa.md",
    "knowledge/denue-intel/a.md",
    "knowledge/denue-inteligencia/b.md",
    "projects/plan-2027/ctv-2da-fza-video-digital/x.md",
  ])("untagged private row refused: %s", (path) => {
    expect(isExternalKbRowAllowed({ path, tags: "[]" })).toBe(false);
    expect(isExternalKbRowAllowed({ path })).toBe(false);
  });

  it.each([
    "knowledge/domain/tv-abierta-2026.md",
    "knowledge/domain/media-market-mx.md",
    "knowledge/domain/grupo-imagen-perfil.md",
    "knowledge/domain/imagen-multimedia-x.md",
  ])("seed prefix allowed: %s", (path) => {
    expect(isExternalKbRowAllowed({ path })).toBe(true);
  });

  it("seed prefixes are the 4 TV / media-market domain prefixes only", () => {
    expect([...EXTERNAL_KB_SEED_PREFIXES]).toEqual([
      "knowledge/domain/tv-",
      "knowledge/domain/media-market-",
      "knowledge/domain/grupo-imagen-",
      "knowledge/domain/imagen-multimedia-",
    ]);
  });

  it("a row tagged `external` is allowed under any path (stored JSON or string[])", () => {
    expect(isExternalKbRowAllowed({ path: PRIVATE, tags: TAGS_EXTERNAL })).toBe(true);
    expect(isExternalKbRowAllowed({ path: "notes/x.md", tags: ["external"] })).toBe(true);
    expect(isExternalKbRowAllowed({ path: PRIVATE, tags: '["externally"]' })).toBe(false);
    expect(isExternalKbRowAllowed({ path: PRIVATE, tags: "external" })).toBe(false); // not JSON
    expect(isExternalKbRowAllowed({ path: PRIVATE, tags: "{corrupt" })).toBe(false);
  });

  it("fails closed on malformed paths even when tagged", () => {
    for (const path of [
      "knowledge/domain/tv-x/../../people/x.md",
      "knowledge/domain/./tv-x.md",
      "knowledge\\domain\\tv-x.md",
      "",
      42,
      undefined,
    ]) {
      expect(isExternalKbRowAllowed({ path, tags: TAGS_EXTERNAL })).toBe(false);
    }
  });

  it("enforce rows: only the allow-listed one is injectable", () => {
    expect(EXTERNAL_ENFORCE_PATHS).toEqual(["directives/repo-authorization.md"]);
    const enforce = (path: string, tags?: string) =>
      isExternalKbInjectable({ path, tags, qualifier: "enforce" });
    expect(enforce("directives/repo-authorization.md")).toBe(true);
    expect(enforce("directives/exposing-services-externally.md")).toBe(false);
    expect(enforce("directives/user-data-sources.md")).toBe(false);
    // An `external` tag does not widen the enforce list.
    expect(enforce("directives/user-data-sources.md", TAGS_EXTERNAL)).toBe(false);
    expect(isExternalKbInjectable({ path: SEED, qualifier: "always-read" })).toBe(true);
    expect(isExternalKbInjectable({ path: PRIVATE, qualifier: "conditional" })).toBe(false);
  });
});

describe("externalToolGuard", () => {
  it("refuses a tool not in the run's list without executing it", async () => {
    const executor = vi.fn(async () => "ran");
    const guarded = externalToolGuard(executor, TOOLS);
    expect(await guarded("memory_search", { query: "x" })).toBe(TOOL_NOT_AVAILABLE);
    expect(await guarded("gmail_send", {})).toBe(TOOL_NOT_AVAILABLE);
    expect(executor).not.toHaveBeenCalled();
  });

  it("refuses a malformed jarvis_file_read path without executing it", async () => {
    const executor = vi.fn(async () => "{}");
    const guarded = externalToolGuard(executor, TOOLS);
    for (const path of ["knowledge/domain/tv-x/../../../INDEX.md", "a\\b.md", 7]) {
      expect(await guarded("jarvis_file_read", { path })).toBe(PATH_NOT_AVAILABLE);
    }
    expect(executor).not.toHaveBeenCalled();
  });

  it("an untagged private row read is refused after the (side-effect-free) read", async () => {
    const guarded = externalToolGuard(
      async () => JSON.stringify({ path: PRIVATE, content: "PRIVATE-BODY", tags: [] }),
      TOOLS,
    );
    expect(await guarded("jarvis_file_read", { path: PRIVATE })).toBe(PATH_NOT_AVAILABLE);
  });

  it("a row tagged external outside the seed prefixes is readable", async () => {
    const guarded = externalToolGuard(
      async () =>
        JSON.stringify({ path: PRIVATE, content: "SHARED-BODY", tags: ["external"], related: [] }),
      TOOLS,
    );
    expect(JSON.parse(await guarded("jarvis_file_read", { path: PRIVATE })).content).toBe(
      "SHARED-BODY",
    );
  });

  it("'not found' outside the seed prefixes answers like a private row (no existence oracle)", async () => {
    const notFound = (p: string) => JSON.stringify({ error: `File not found: ${p}` });
    const guarded = externalToolGuard(async (_n, a) => notFound(String(a.path)), TOOLS);
    expect(await guarded("jarvis_file_read", { path: PRIVATE })).toBe(PATH_NOT_AVAILABLE);
    expect(await guarded("jarvis_file_read", { path: SEED })).toBe(notFound(SEED));
  });

  it("runs a seed read and keeps only seed-prefix related entries", async () => {
    const executor = vi.fn(async () =>
      JSON.stringify({
        path: SEED,
        content: "cuerpo",
        tags: [],
        related: [
          { path: "knowledge/people/someone.md", title: "P" },
          { path: SEED_DOC, title: "Plan" },
        ],
      }),
    );
    const guarded = externalToolGuard(executor, TOOLS);
    const out = JSON.parse(await guarded("jarvis_file_read", { path: SEED }));
    expect(executor).toHaveBeenCalledOnce();
    expect(out.content).toBe("cuerpo");
    expect(out.related).toEqual([{ path: SEED_DOC, title: "Plan" }]);
  });

  it("jarvis_file_list: a private prefix with limit 1 reads exactly like an empty prefix (no count oracle)", async () => {
    // Behaves like the real tool: filter by prefix, slice to limit, "… N more".
    const rows = ["knowledge/people/a.md", "knowledge/people/b.md", "knowledge/people/c.md"];
    const executor = vi.fn(async (_n: string, a: Record<string, unknown>) => {
      const hits = rows.filter((p) => p.startsWith(String(a.prefix ?? "")));
      if (hits.length === 0) return "📂 No files found.";
      const limit = Math.min(Math.max(Number(a.limit) || 100, 1), 500);
      const shown = hits.slice(0, limit);
      const lines = [`📂 **${hits.length} files**`, ...shown.map((p) => `  ${p} (1K, reference)`)];
      if (hits.length > shown.length) lines.push(`  … ${hits.length - shown.length} more — narrow`);
      return lines.join("\n");
    });
    const guarded = externalToolGuard(executor, TOOLS);
    const priv = await guarded("jarvis_file_list", { prefix: "knowledge/people/", limit: 1 });
    const empty = await guarded("jarvis_file_list", { prefix: "nothing/here/" });
    expect(priv).toBe("📂 No files found.");
    expect(priv).toBe(empty);
    expect(executor).toHaveBeenCalledWith("jarvis_file_list", {
      prefix: "knowledge/people/",
      limit: 500,
    });
  });

  it("externalToolArgs forces the list limit only", () => {
    expect(externalToolArgs("jarvis_file_list", { prefix: "x/", limit: 3 })).toEqual({
      prefix: "x/",
      limit: 500,
    });
    const args = { path: SEED };
    expect(externalToolArgs("jarvis_file_read", args)).toBe(args);
  });

  it("passes a non-KB tool's output through unchanged", async () => {
    const guarded = externalToolGuard(async () => "raw web text", TOOLS);
    expect(await guarded("web_search", { query: "x" })).toBe("raw web text");
  });
});

describe("filterExternalToolResult", () => {
  it("jarvis_file_read by tags: entries checked with their own tags, total recounted", () => {
    const raw = JSON.stringify({
      results: [
        { path: "knowledge/people/x.md", title: "P", tags: [] },
        { path: PRIVATE, title: "Shared", tags: ["external"] },
        { path: SEED, title: "Seed", tags: [] },
        { path: "projects/juicio-modificacion/README.md", title: "J", tags: ["legal"] },
      ],
      total: 4,
    });
    const out = JSON.parse(filterExternalToolResult("jarvis_file_read", raw, { tags: ["external"] }));
    expect(out.results.map((r: { path: string }) => r.path)).toEqual([PRIVATE, SEED]);
    expect(out.total).toBe(2);
  });

  it("jarvis_file_read: unparseable or shapeless output fails closed", () => {
    expect(filterExternalToolResult("jarvis_file_read", "plain text body")).toBe(
      RESULT_NOT_AVAILABLE,
    );
    expect(filterExternalToolResult("jarvis_file_read", JSON.stringify({ content: "x" }))).toBe(
      RESULT_NOT_AVAILABLE,
    );
  });

  const search = (query: string, blocks: string[][]) =>
    [`🔍 ${blocks.length} files matching "${query}":`, "", ...blocks.flatMap((b) => [...b, ""])].join(
      "\n",
    );

  it("jarvis_file_search: keeps seed blocks only, keeps the shape, recounts", () => {
    const raw = search("tarifas", [
      ["[knowledge/domain/work-profile.md] (120 bytes)", "  snippet privado"],
      ["[knowledge/domain/tv-tarifas.md] (300 bytes) — L4", "  snippet público"],
      ["[INDEX.md] (50 bytes)", "  índice"],
    ]);
    expect(filterExternalToolResult("jarvis_file_search", raw)).toBe(
      search("tarifas", [["[knowledge/domain/tv-tarifas.md] (300 bytes) — L4", "  snippet público"]]),
    );
  });

  it("jarvis_file_search: a forged header inside a private snippet refuses the whole result", () => {
    // The private row's snippet carries a blank line and a header naming a
    // seed path: parsed naively, "SECRET-TAIL" would ride on a kept block.
    const raw = [
      `🔍 2 files matching "x":`,
      "",
      "[knowledge/health/sleep.md] (10 bytes)",
      "  inicio del snippet",
      "",
      "[knowledge/domain/tv-forged.md] (1 bytes)",
      "  SECRET-TAIL",
      "",
      "[knowledge/domain/tv-real.md] (5 bytes)",
      "  público",
      "",
    ].join("\n");
    const out = filterExternalToolResult("jarvis_file_search", raw);
    expect(out).toBe(RESULT_NOT_AVAILABLE);
    expect(out).not.toContain("SECRET-TAIL");
  });

  it("jarvis_file_search: a header-less block is dropped", () => {
    const raw = [
      `🔍 1 files matching "x":`,
      "",
      "[knowledge/domain/tv-real.md] (5 bytes)",
      "  público",
      "",
      "  continuación sin encabezado",
      "",
    ].join("\n");
    const out = filterExternalToolResult("jarvis_file_search", raw);
    expect(out).toContain("público");
    expect(out).not.toContain("continuación sin encabezado");
  });

  it("jarvis_file_search: all private → the tool's own empty result; unknown format fails closed", () => {
    const raw = search("x", [["[knowledge/people/a.md] (1 bytes)", "  s"]]);
    expect(filterExternalToolResult("jarvis_file_search", raw)).toBe(
      `No files found matching "x" in the Knowledge Base.`,
    );
    expect(filterExternalToolResult("jarvis_file_search", "[knowledge/people/a.md] leak")).toBe(
      RESULT_NOT_AVAILABLE,
    );
  });

  it("jarvis_file_list: keeps seed entries, recounts, never emits a more line", () => {
    const raw = [
      "📂 **4 files**",
      "  knowledge/people/someone.md (1.2K, always-read)",
      "  knowledge/domain/tv-tarifas.md (3K, reference)",
      "  projects/juicio-modificacion/README.md (2K, reference)",
      `  ${SEED_DOC} (4K, reference)`,
      "  … 12 more — narrow with prefix or raise limit",
    ].join("\n");
    const out = filterExternalToolResult("jarvis_file_list", raw);
    expect(out).toBe(
      ["📂 **2 files**", "  knowledge/domain/tv-tarifas.md (3K, reference)", `  ${SEED_DOC} (4K, reference)`].join(
        "\n",
      ),
    );
    expect(out).not.toContain("more");
  });

  it("jarvis_file_list: all private + a more line → exactly the tool's empty text", () => {
    const raw = [
      "📂 **3 files**",
      "  knowledge/people/a.md (1K, reference)",
      "  … 2 more — narrow with prefix or raise limit",
    ].join("\n");
    expect(filterExternalToolResult("jarvis_file_list", raw)).toBe("📂 No files found.");
  });

  it("jarvis_file_list: unknown format fails closed", () => {
    expect(filterExternalToolResult("jarvis_file_list", "knowledge/people/a.md")).toBe(
      RESULT_NOT_AVAILABLE,
    );
  });
});
