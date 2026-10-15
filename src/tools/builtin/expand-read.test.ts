import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../lib/eviction.js", () => ({
  evictToFile: vi.fn((content: string, _prefix: string, max: number) => ({
    preview: content.slice(0, max),
    filePath: "/tmp/evicted.txt",
  })),
}));

import { expandReadTool } from "./expand-read.js";
import { evictToFile } from "../../lib/eviction.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const PAGE = "https://example.com/article";
const SNAP = "snap123";

function jsonRes(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function meta(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    url: PAGE,
    finalUrl: "https://example.com/article?final=1",
    title: "An Article",
    capturedAt: "2026-10-15T12:00:00Z",
    snapshotId: SNAP,
    lang: "en",
    pageType: "article",
    playground: `https://play.example/s/${SNAP}`,
    ...overrides,
  };
}

function result(extra: Record<string, unknown> = {}) {
  return { meta: meta(), markdown: "# Hello\n\nBody text.", json: {}, ...extra };
}

const run = async (args: Record<string, unknown>) =>
  JSON.parse(await expandReadTool.execute(args));

const sentBody = () =>
  JSON.parse(mockFetch.mock.calls[0][1].body as string) as Record<
    string,
    unknown
  >;

beforeEach(() => {
  mockFetch.mockReset();
  vi.mocked(evictToFile).mockClear();
  vi.stubEnv("EXPAND_API_KEY", "test-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("expand_read guards", () => {
  it("returns an error naming EXPAND_API_KEY when the key is missing, without fetching", async () => {
    vi.stubEnv("EXPAND_API_KEY", "");
    const r = await run({ url: PAGE });
    expect(r.error).toContain("EXPAND_API_KEY");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects a metadata-endpoint URL before any fetch", async () => {
    const r = await run({ url: "http://169.254.169.254/latest/meta-data" });
    expect(typeof r.error).toBe("string");
    expect(r.url).toBe("http://169.254.169.254/latest/meta-data");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("requires url", async () => {
    const r = await run({});
    expect(r.error).toBe("url is required");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects a non-string url before it reaches URL parsing", async () => {
    const r = await run({ url: ["https://example.com/a"] });
    expect(r.error).toBe("url is required");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("expand_read plain fetch", () => {
  it("POSTs to the Markdown-only endpoint with the key header and no highlights", async () => {
    mockFetch.mockResolvedValueOnce(jsonRes(result()));
    const r = await run({ url: PAGE });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = mockFetch.mock.calls[0];
    expect(calledUrl).toBe("https://api.expand.ai/v1/fetch/json?include=");
    expect(init.method).toBe("POST");
    expect(init.headers["x-expand-api-key"]).toBe("test-key");
    const body = sentBody();
    expect(body.url).toBe(PAGE);
    expect("highlights" in body).toBe(false);

    expect(r.url).toBe(PAGE);
    expect(r.final_url).toBe("https://example.com/article?final=1");
    expect(r.title).toBe("An Article");
    expect(r.captured_at).toBe("2026-10-15T12:00:00Z");
    expect(r.snapshot_url).toBe(`https://play.example/s/${SNAP}`);
    expect(r.content).toBe("# Hello\n\nBody text.");
    expect(r.chars).toBe("# Hello\n\nBody text.".length);
    expect(r.truncated).toBe(false);
    expect("highlights" in r).toBe(false);
    expect("full_content_path" in r).toBe(false);
    expect(Object.keys(r)).toEqual([
      "url",
      "final_url",
      "title",
      "captured_at",
      "snapshot_url",
      "content",
      "chars",
      "truncated",
    ]);
    // The key never reaches the output
    expect(JSON.stringify(r)).not.toContain("test-key");
  });

  it("passes a 60 s timeout to the request", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    mockFetch.mockResolvedValueOnce(jsonRes(result()));
    await run({ url: PAGE });
    expect(spy).toHaveBeenCalledWith(60_000);
    spy.mockRestore();
  });

  it("evicts markdown over 5000 chars when there is no query", async () => {
    const long = "x".repeat(7_000);
    mockFetch.mockResolvedValueOnce(jsonRes(result({ markdown: long })));
    const r = await run({ url: PAGE });
    expect(evictToFile).toHaveBeenCalledWith(long, "expand-read", 5000);
    expect(r.truncated).toBe(true);
    expect(r.full_content_path).toBe("/tmp/evicted.txt");
    expect(r.chars).toBe(7_000);
    expect(r.content.length).toBe(5_000);
  });

  it("keeps content and reports origin_status when the origin answered >= 400", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonRes(
        result({
          originError: {
            originStatusCode: 404,
            kind: "NotFound",
            retryable: false,
            contentAvailable: true,
          },
        }),
      ),
    );
    const r = await run({ url: PAGE });
    expect(r.error).toBeUndefined();
    expect(r.origin_status).toBe(404);
    expect(r.content).toBe("# Hello\n\nBody text.");
  });
});

describe("expand_read highlights", () => {
  it("clamps max_results to 20, maps snippets with cite links, caps content at 1500", async () => {
    const long = "y".repeat(3_000);
    mockFetch.mockResolvedValueOnce(
      jsonRes(
        result({
          markdown: long,
          data: {
            highlights: {
              query: "what is it",
              snippets: [
                {
                  source: "markdown",
                  text: "It is a thing.",
                  score: 0.87654,
                  location: { evidenceId: 42 },
                },
                {
                  source: "appendix",
                  text: "Another passage.",
                  score: 0.7,
                  location: { evidenceId: "b7" },
                },
                {
                  source: "markdown",
                  text: "Digit-string id.",
                  score: 0.66,
                  location: { evidenceId: "42" },
                },
                {
                  source: "markdown",
                  text: "Zero id.",
                  score: 0.65,
                  location: { evidenceId: 0 },
                },
              ],
            },
          },
        }),
      ),
    );
    const r = await run({ url: PAGE, query: "what is it", max_results: 99 });

    expect(sentBody().highlights).toEqual({
      query: "what is it",
      maxResults: 20,
      minScore: 0.6,
    });
    expect(r.highlights).toEqual([
      {
        text: "It is a thing.",
        score: 0.88,
        source: "markdown",
        cite: `https://play.example/s/${SNAP}?id=42`,
      },
      {
        text: "Another passage.",
        score: 0.7,
        source: "appendix",
        cite: null,
      },
      {
        text: "Digit-string id.",
        score: 0.66,
        source: "markdown",
        cite: `https://play.example/s/${SNAP}?id=42`,
      },
      {
        text: "Zero id.",
        score: 0.65,
        source: "markdown",
        cite: null,
      },
    ]);
    expect(evictToFile).toHaveBeenCalledWith(long, "expand-read", 1500);
    expect(r.content.length).toBe(1_500);
    expect(r.truncated).toBe(true);
    expect(r.chars).toBe(3_000);
  });

  it("defaults max_results to 5 with a query", async () => {
    mockFetch.mockResolvedValueOnce(jsonRes(result()));
    await run({ url: PAGE, query: "q" });
    expect(sentBody().highlights).toEqual({
      query: "q",
      maxResults: 5,
      minScore: 0.6,
    });
  });

  it("a blank query sends no highlights", async () => {
    mockFetch.mockResolvedValueOnce(jsonRes(result()));
    const r = await run({ url: PAGE, query: "   " });
    expect("highlights" in sentBody()).toBe(false);
    expect("highlights" in r).toBe(false);
  });

  it.each([
    [-5, 1],
    ["2.9", 2],
    [{}, 5],
  ])("max_results %j -> maxResults %i", async (given, expected) => {
    mockFetch.mockResolvedValueOnce(jsonRes(result()));
    await run({ url: PAGE, query: "q", max_results: given });
    expect((sentBody().highlights as { maxResults: number }).maxResults).toBe(
      expected,
    );
  });

  it("caps every snippet at 1500 chars and the total at 6000", async () => {
    const snippets = Array.from({ length: 20 }, (_, i) => ({
      source: "markdown",
      text: "z".repeat(20_000),
      score: 0.9,
      location: { evidenceId: i + 1 },
    }));
    mockFetch.mockResolvedValueOnce(
      jsonRes(result({ data: { highlights: { query: "q", snippets } } })),
    );
    const r = await run({ url: PAGE, query: "q", max_results: 20 });
    // 4 x 1500 = 6000 fits the total budget; the other 16 are dropped.
    expect(r.highlights).toHaveLength(4);
    expect(r.highlights_dropped).toBe(16);
    for (const h of r.highlights) {
      expect(h.text.length).toBe(1_501); // 1500 chars + the cut marker
      expect(h.text.endsWith("…")).toBe(true);
    }
    const total = r.highlights.reduce(
      (n: number, h: { text: string }) => n + h.text.length,
      0,
    );
    expect(total).toBeLessThanOrEqual(6_000 + r.highlights.length);
  });

  it("marks only cut snippets and omits highlights_dropped when nothing is dropped", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonRes(
        result({
          data: {
            highlights: {
              query: "q",
              snippets: [
                { source: "markdown", text: "w".repeat(1_600), score: 0.9 },
                { source: "markdown", text: "short passage", score: 0.8 },
              ],
            },
          },
        }),
      ),
    );
    const r = await run({ url: PAGE, query: "q" });
    expect(r.highlights).toHaveLength(2);
    expect(r.highlights[0].text).toBe("w".repeat(1_500) + "…");
    expect(r.highlights[1].text).toBe("short passage");
    expect("highlights_dropped" in r).toBe(false);
  });

  it("skips null snippets without throwing", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonRes(
        result({
          data: {
            highlights: {
              query: "q",
              snippets: [
                null,
                { source: "markdown", text: "ok", score: 0.9, location: { evidenceId: 2 } },
              ],
            },
          },
        }),
      ),
    );
    const r = await run({ url: PAGE, query: "q" });
    expect(r.error).toBeUndefined();
    expect(r.highlights).toEqual([
      { text: "ok", score: 0.9, source: "markdown", cite: `https://play.example/s/${SNAP}?id=2` },
    ]);
  });

  it("a non-integer evidenceId gets no cite", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonRes(
        result({
          data: {
            highlights: {
              query: "q",
              snippets: [
                { source: "markdown", text: "t", score: 0.9, location: { evidenceId: 1.5 } },
              ],
            },
          },
        }),
      ),
    );
    const r = await run({ url: PAGE, query: "q" });
    expect(r.highlights[0].cite).toBeNull();
  });

  it("treats a non-array snippets field as no highlights", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonRes(result({ data: { highlights: { query: "q", snippets: { a: 1 } } } })),
    );
    const r = await run({ url: PAGE, query: "q" });
    expect(r.error).toBeUndefined();
    expect(r.highlights).toEqual([]);
  });

  it("cite is null without a snapshotId even with a valid evidenceId", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonRes({
        meta: meta({ snapshotId: undefined }),
        markdown: "short",
        json: {},
        data: {
          highlights: {
            query: "q",
            snippets: [
              { source: "markdown", text: "t", score: 0.9, location: { evidenceId: 3 } },
            ],
          },
        },
      }),
    );
    const r = await run({ url: PAGE, query: "q" });
    expect(r.highlights[0].cite).toBeNull();
  });

  it("ignores a non-http(s) playground origin", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonRes({
        meta: meta({ playground: "javascript:alert(1)" }),
        markdown: "short",
        json: {},
        data: {
          highlights: {
            query: "q",
            snippets: [
              { source: "markdown", text: "t", score: 0.9, location: { evidenceId: 5 } },
            ],
          },
        },
      }),
    );
    const r = await run({ url: PAGE, query: "q" });
    expect(r.highlights[0].cite.startsWith("https://expand.land/s/")).toBe(true);
    expect(r.highlights[0].cite).toBe(`https://expand.land/s/${SNAP}?id=5`);
  });

  it("cite is null without an evidenceId, and falls back to expand.land without a playground", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonRes({
        meta: meta({ playground: undefined }),
        markdown: "short",
        json: {},
        data: {
          highlights: {
            query: "q",
            snippets: [
              { source: "markdown", text: "no id", score: 0.9 },
              {
                source: "markdown",
                text: "empty id",
                score: 0.8,
                location: { evidenceId: "" },
              },
              {
                source: "statejson",
                text: "has id",
                score: 0.65,
                location: { evidenceId: 7 },
              },
            ],
          },
        },
      }),
    );
    const r = await run({ url: PAGE, query: "q" });
    expect(r.highlights[0].cite).toBeNull();
    expect(r.highlights[1].cite).toBeNull();
    expect(r.highlights[2].cite).toBe(`https://expand.land/s/${SNAP}?id=7`);
  });
});

describe("expand_read errors", () => {
  it("maps a FetchOriginError body to an error carrying kind and retryable", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonRes({
        _tag: "FetchOriginError",
        url: PAGE,
        kind: "DnsFailure",
        retryable: true,
        markdown: "should never be returned",
      }),
    );
    const r = await run({ url: PAGE });
    expect(r.error).toContain("DnsFailure");
    expect(r.kind).toBe("DnsFailure");
    expect(r.retryable).toBe(true);
    expect(r.url).toBe(PAGE);
    expect(r.content).toBeUndefined();
  });

  it.each([
    [401, "Expand API key rejected (401)", false],
    [403, "Expand refused the URL or the account has no credits (403)", false],
    [429, "Expand busy (429)", true],
    [503, "Expand busy (503)", true],
    [529, "Expand busy (529)", true],
    [404, "Origin not found/gone (404)", false],
    [410, "Origin not found/gone (410)", false],
  ])("maps HTTP %i", async (status, prefix, retryable) => {
    mockFetch.mockResolvedValueOnce(
      jsonRes({ _tag: "Err", message: `server says ${status}` }, status),
    );
    const r = await run({ url: PAGE });
    expect(r.error).toBe(`${prefix}: server says ${status}`);
    expect(r.url).toBe(PAGE);
    if (retryable) expect(r.retryable).toBe(true);
    else expect(r.retryable).not.toBe(true);
  });

  it("falls back to the body excerpt for a non-JSON error body", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Error",
      headers: new Headers(),
      json: async () => ({}),
      text: async () => "upstream   exploded",
    });
    const r = await run({ url: PAGE });
    expect(r.error).toBe("Expand API error: 500 upstream exploded");
  });

  it("caps a long non-JSON error body", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Error",
      headers: new Headers(),
      json: async () => ({}),
      text: async () => "e".repeat(1_000),
    });
    const r = await run({ url: PAGE });
    expect(r.error.length).toBeLessThanOrEqual(340);
  });

  it("caps a long JSON error message", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonRes({ message: "m".repeat(5_000) }, 401),
    );
    const r = await run({ url: PAGE });
    expect(r.error.startsWith("Expand API key rejected (401): ")).toBe(true);
    expect(r.error.length).toBeLessThanOrEqual(340);
  });

  it("reports a timeout as retryable", async () => {
    mockFetch.mockRejectedValueOnce(new DOMException("x", "TimeoutError"));
    const r = await run({ url: PAGE });
    expect(r.error).toContain("timed out");
    expect(r.retryable).toBe(true);
    expect(r.url).toBe(PAGE);
  });

  it("reports any other throw without retryable", async () => {
    mockFetch.mockRejectedValueOnce(new Error("socket hang up"));
    const r = await run({ url: PAGE });
    expect(r.error).toBe("Expand fetch failed: socket hang up");
    expect(r.retryable).toBeUndefined();
  });
});

describe("expand_read definition", () => {
  it("declares read-only MCP hints and a single name", () => {
    expect(expandReadTool.readOnlyHint).toBe(true);
    expect(expandReadTool.destructiveHint).toBe(false);
    expect(expandReadTool.idempotentHint).toBe(true);
    expect(expandReadTool.openWorldHint).toBe(true);
    expect(expandReadTool.deferred).toBeFalsy();
    expect(expandReadTool.name).toBe("expand_read");
    expect(expandReadTool.definition.function.name).toBe("expand_read");
  });
});
