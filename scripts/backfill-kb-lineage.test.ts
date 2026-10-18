import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildBackfillPlan,
  deriveManifest,
  formatPlan,
  manifestRow,
  runBackfill,
} from "./backfill-kb-lineage.js";
import { structureMarkdown } from "../src/kb/pdf-structured-ingest.js";

describe("backfill-kb-lineage (4o, operator-run)", () => {
  it("derives the manifest from a chunk path using the row's section_path", () => {
    expect(deriveManifest("pdf-ingest/report/intro/0003", ["Intro"])).toEqual({
      manifestPath: "pdf-ingest/report.manifest.md",
      docSlug: "report",
    });
    expect(deriveManifest("pdf-ingest/report/root/0000", [])).toEqual({
      manifestPath: "pdf-ingest/report.manifest.md",
      docSlug: "report",
    });
    // Multi-segment namespace + nested sections resolve exactly.
    expect(
      deriveManifest("fin/2026/aapl-10k/top/sub-a/0012", ["Top", "Sub A"]),
    ).toEqual({ manifestPath: "fin/2026/aapl-10k.manifest.md", docSlug: "aapl-10k" });
  });

  it("rejects paths that are not the chunk shape", () => {
    expect(deriveManifest("notes/plain.md", [])).toBeNull();
    expect(deriveManifest("report/root/0000", [])).toBeNull(); // no namespace
    expect(deriveManifest("ns/report/intro/0001", ["Other"])).toBeNull(); // section mismatch
    expect(deriveManifest("ns/report.manifest.md", [])).toBeNull();
  });

  it("matches the manifest path the live ingester writes", () => {
    const md = "# Intro\nSome text here.\n\n## Deep Dive\nMore text.";
    const out = structureMarkdown(md, "/tmp/My Report.pdf", { namespace: "a/b" });
    for (const c of out.chunks) {
      expect(deriveManifest(c.path, c.section_path)?.manifestPath).toBe(
        out.manifest.path,
      );
    }
  });

  it("dry-run plan groups lineage-less chunks per document and counts skips", () => {
    const plan = buildBackfillPlan([
      { path: "ns/doc-b/root/0000", related_to: [], section_path: [] },
      { path: "ns/doc-a/intro/0000", related_to: [], section_path: ["Intro"] },
      { path: "ns/doc-a/intro/0001", related_to: null, section_path: ["Intro"] },
      { path: "ns/doc-a/intro/0002", related_to: ["ns/doc-a.manifest.md"], section_path: ["Intro"] },
      { path: "ns/loose-note.md", related_to: [], section_path: [] },
    ]);
    expect(plan.docs).toEqual([
      {
        manifestPath: "ns/doc-a.manifest.md",
        docSlug: "doc-a",
        chunkPaths: ["ns/doc-a/intro/0000", "ns/doc-a/intro/0001"],
      },
      {
        manifestPath: "ns/doc-b.manifest.md",
        docSlug: "doc-b",
        chunkPaths: ["ns/doc-b/root/0000"],
      },
    ]);
    expect(plan.skippedHasLineage).toBe(1);
    expect(plan.skippedNotChunk).toBe(1);
    const text = formatPlan(plan);
    expect(text).toContain("ns/doc-a.manifest.md  2 chunks");
    expect(text).toContain("documents: 2 | chunks: 3");
  });

  it("manifest row is a source (no related_to) with the backfill content", () => {
    const row = manifestRow(
      { manifestPath: "ns/doc-a.manifest.md", docSlug: "doc-a", chunkPaths: ["x"] },
      "backfilled manifest: doc-a, 1 chunks",
    );
    expect(row).not.toHaveProperty("related_to");
    expect(row.path).toBe("ns/doc-a.manifest.md");
    expect(row.type).toBe("ingested");
    expect(row.qualifier).toBe("pdf");
    expect(row.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.stale).toBe(true); // never surfaces in search
  });

  describe("runBackfill with a mocked fetch", () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const rows = [
      { path: "ns/doc-a/intro/0000", related_to: [], section_path: ["Intro"] },
      { path: "ns/doc-a/intro/0001", related_to: [], section_path: ["Intro"] },
    ];

    function stub() {
      calls.length = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          calls.push({
            url,
            method: init?.method ?? "GET",
            body: init?.body as string | undefined,
          });
          return { ok: true, json: async () => rows };
        }),
      );
      vi.spyOn(console, "log").mockImplementation(() => {});
    }

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it("dry run issues GETs only", async () => {
      stub();
      const out = await runBackfill("k", false);
      expect(out.plan.docs).toHaveLength(1);
      expect(out.done).toBe(0);
      expect(calls.map((c) => c.method)).toEqual(["GET"]);
      expect(calls[0].url).toContain("type=eq.ingested");
      expect(calls[0].url).toContain("qualifier=eq.pdf");
    });

    it("--apply: manifest POST (stale:true, no cascade) then PATCH related_to only", async () => {
      stub();
      const out = await runBackfill("k", true);
      expect(out).toMatchObject({ done: 1, failed: 0 });
      expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "PATCH"]);
      const manifest = JSON.parse(calls[1].body ?? "{}");
      expect(manifest.path).toBe("ns/doc-a.manifest.md");
      expect(manifest.stale).toBe(true);
      expect(manifest.content).toBe("backfilled manifest: doc-a, 2 chunks");
      expect(calls[2].body).toBe('{"related_to":["ns/doc-a.manifest.md"]}');
      expect(decodeURIComponent(calls[2].url)).toContain(
        'path=in.("ns/doc-a/intro/0000","ns/doc-a/intro/0001")',
      );
    });
  });
});
