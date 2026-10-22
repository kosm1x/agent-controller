import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../lib/eviction.js", () => ({
  evictToFile: vi.fn((content: string, _prefix: string, max: number) => ({
    preview: content.slice(0, max),
    filePath: "/tmp/evicted-search.txt",
  })),
}));

import { jinaSearchTool } from "./jina-search.js";
import { evictToFile } from "../../lib/eviction.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonRes(body: unknown, status = 200, statusText = "OK") {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const ROWS = [
  {
    title: "Example one",
    url: "https://example.com/one",
    description: "First synthetic snippet",
    date: "2026-01-02",
    content: "Body one",
  },
  {
    title: "Example two",
    url: "https://example.org/two",
    description: "Second synthetic snippet",
  },
];

const run = async (args: Record<string, unknown>) =>
  JSON.parse(await jinaSearchTool.execute(args));
const call = (i = 0) => mockFetch.mock.calls[i];
const params = (i = 0) => new URL(call(i)[0] as string).searchParams;

beforeEach(() => {
  mockFetch.mockReset();
  vi.mocked(evictToFile).mockClear();
  vi.stubEnv("JINA_API_KEY", "test-key");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("jina_search", () => {
  it("has the read-only hints", () => {
    expect(jinaSearchTool.readOnlyHint).toBe(true);
    expect(jinaSearchTool.destructiveHint).toBe(false);
    expect(jinaSearchTool.idempotentHint).toBe(true);
    expect(jinaSearchTool.openWorldHint).toBe(true);
  });

  it("returns the configured-key error without fetching when the key is missing", async () => {
    vi.stubEnv("JINA_API_KEY", "");
    const r = await run({ query: "synthetic query" });
    expect(r).toEqual({
      error: "JINA_API_KEY not configured. Get one at https://jina.ai",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("defaults: num=5, page=1, no-content header, Bearer + JSON accept", async () => {
    mockFetch.mockResolvedValueOnce(jsonRes({ code: 200, data: ROWS }));
    await run({ query: "synthetic query" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(call()[0]).toBe(
      "https://s.jina.ai/?q=synthetic+query&num=5&page=1",
    );
    expect(call()[1].headers).toEqual({
      Authorization: "Bearer test-key",
      Accept: "application/json",
      "X-Respond-With": "no-content",
    });
    expect(call()[1].signal).toBeInstanceOf(AbortSignal);
  });

  it("parses results without content when with_content is false", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonRes({ code: 200, data: ROWS, usage: { tokens: 10000 } }),
    );
    const r = await run({ query: "synthetic query" });
    expect(r).toEqual({
      query: "synthetic query",
      results: [
        {
          title: "Example one",
          url: "https://example.com/one",
          description: "First synthetic snippet",
          date: "2026-01-02",
        },
        {
          title: "Example two",
          url: "https://example.org/two",
          description: "Second synthetic snippet",
        },
      ],
      count: 2,
      page: 1,
      tokens_used: 10000,
    });
  });

  it("with_content drops the no-content header and caps each body at 1,500 chars", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonRes({
        code: 200,
        data: [
          {
            title: "Long",
            url: "https://example.com/l",
            content: "z".repeat(4000),
          },
        ],
      }),
    );
    const r = await run({ query: "synthetic query", with_content: true });
    expect(call()[1].headers["X-Respond-With"]).toBeUndefined();
    expect(r.results[0].content).toBe("z".repeat(1500));
    expect(r.truncated).toBeUndefined();
  });

  it("maps site, country, language, num and page to query params", async () => {
    mockFetch.mockResolvedValueOnce(jsonRes({ data: [] }));
    const r = await run({
      query: "synthetic query",
      num: 3,
      page: 2,
      site: "docs.example.com",
      country: "mx",
      language: "es",
    });
    const p = params();
    expect(p.get("q")).toBe("synthetic query");
    expect(p.get("num")).toBe("3");
    expect(p.get("page")).toBe("2");
    expect(p.get("site")).toBe("docs.example.com");
    expect(p.get("gl")).toBe("mx");
    expect(p.get("hl")).toBe("es");
    expect(r).toEqual({
      query: "synthetic query",
      results: [],
      count: 0,
      page: 2,
    });
  });

  it.each([
    [{ query: "x" }, "query"],
    [{ query: "q".repeat(401) }, "query"],
    [{ query: "synthetic", num: 0 }, "num"],
    [{ query: "synthetic", num: 11 }, "num"],
    [{ query: "synthetic", num: 2.5 }, "num"],
    [{ query: "synthetic", page: 0 }, "page"],
    [{ query: "synthetic", site: "https://example.com" }, "site"],
    [{ query: "synthetic", site: "example.com/path" }, "site"],
    [{ query: "synthetic", site: "localhost" }, "site"],
    [{ query: "synthetic", country: "MX" }, "country"],
    [{ query: "synthetic", language: "spa" }, "language"],
  ])("rejects %o without fetching", async (args, name) => {
    const r = await run(args);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(r.error).toContain(name);
  });

  it("parses tolerantly: missing fields omitted, junk rows and missing data never throw", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonRes({
        code: 200,
        data: [
          { url: "https://example.com/only-url" },
          null,
          "junk",
          { title: 7 },
        ],
      }),
    );
    const r = await run({ query: "synthetic query" });
    expect(r.results).toEqual([{ url: "https://example.com/only-url" }, {}]);
    expect(r.count).toBe(2);
    expect(r.tokens_used).toBeUndefined();

    mockFetch.mockResolvedValueOnce(jsonRes({ code: 200 }));
    expect((await run({ query: "synthetic query" })).results).toEqual([]);
  });

  it.each(["<html>gateway</html>", "[]", "null", '"text"', ""])(
    "a 200 whose body is not a JSON object (%j) is an error, never zero results",
    async (body) => {
      mockFetch.mockResolvedValueOnce(new Response(body, { status: 200 }));
      const r = await run({ query: "synthetic query" });
      expect(r).toEqual({
        error: "Jina search returned a non-JSON response",
        hint: "the search did not complete; retry once or use web_search",
      });
    },
  );

  it("caps every description at 300 chars, evicted or not", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonRes({
        data: Array.from({ length: 10 }, (_, i) => ({
          title: `Result ${i}`,
          url: `https://example.com/${i}`,
          description: "d".repeat(900),
        })),
      }),
    );
    const raw = await jinaSearchTool.execute({
      query: "synthetic query",
      num: 10,
    });
    expect(raw.length).toBeLessThanOrEqual(5_000);
    const r = JSON.parse(raw);
    expect(r.count).toBe(10);
    expect(r.results[0].description).toBe("d".repeat(300));
    expect(r.truncated).toBeUndefined();
    expect(evictToFile).not.toHaveBeenCalled();
  });

  it("caps title at 300 and url at 2,000 so one huge title cannot drop a row", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonRes({
        data: [
          {
            title: "t".repeat(6_000),
            url: `https://example.com/${"u".repeat(3_000)}`,
            description: "Synthetic snippet",
          },
        ],
      }),
    );
    const raw = await jinaSearchTool.execute({ query: "synthetic query" });
    expect(raw.length).toBeLessThanOrEqual(5_000);
    const r = JSON.parse(raw);
    expect(r.count).toBe(1);
    expect(r.dropped).toBeUndefined();
    expect(r.results[0].title).toHaveLength(300);
    expect(r.results[0].url).toHaveLength(2_000);
    expect(r.results[0].description).toBe("Synthetic snippet");
  });

  it("drops trailing rows when the rows alone exceed the cap (no content)", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonRes({
        data: Array.from({ length: 10 }, (_, i) => ({
          title: `T${i} ${"t".repeat(600)}`,
          url: `https://example.com/${i}`,
          description: "d".repeat(900),
        })),
      }),
    );
    const raw = await jinaSearchTool.execute({
      query: "synthetic query",
      num: 10,
    });
    expect(raw.length).toBeLessThanOrEqual(5_000);
    const r = JSON.parse(raw);
    expect(r.truncated).toBe(true);
    expect(r.dropped).toBeGreaterThan(0);
    expect(r.count + r.dropped).toBe(10);
    expect(r.results).toHaveLength(r.count);
    expect(r.results[r.count - 1].url).toBe(
      `https://example.com/${r.count - 1}`,
    );
    expect(r.full_content_path).toBe("/tmp/evicted-search.txt");
  });

  it("with content and 800-char descriptions drops rows before cutting bodies to nothing", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonRes({
        data: Array.from({ length: 10 }, (_, i) => ({
          title: `Result ${i}`,
          url: `https://example.com/${i}`,
          description: "d".repeat(800),
          content: "c".repeat(3000),
        })),
      }),
    );
    const raw = await jinaSearchTool.execute({
      query: "synthetic query",
      num: 10,
      with_content: true,
    });
    expect(raw.length).toBeLessThanOrEqual(5_000);
    const r = JSON.parse(raw);
    expect(r.dropped).toBeGreaterThan(0);
    expect(r.count + r.dropped).toBe(10);
    for (const row of r.results) {
      expect(row.description).toHaveLength(300);
      expect(row.content.length).toBeGreaterThanOrEqual(200);
    }
  });

  it("measures bodies JSON-escaped: quote-heavy content stays under the cap and is not cut to nothing", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonRes({
        data: Array.from({ length: 5 }, (_, i) => ({
          url: `https://example.com/${i}`,
          content: '"\n'.repeat(1000),
        })),
      }),
    );
    const raw = await jinaSearchTool.execute({
      query: "synthetic query",
      with_content: true,
    });
    expect(raw.length).toBeLessThanOrEqual(5_000);
    expect(raw.length).toBeGreaterThan(4_000);
    const r = JSON.parse(raw);
    expect(r.count).toBe(5);
    expect(r.dropped).toBeUndefined();
    for (const row of r.results) expect(row.content.length).toBeGreaterThan(0);
  });

  it("402 carries Jina's reason and the key hint", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonRes(
        {
          code: 402,
          readableMessage: "InsufficientBalanceError: out of tokens",
        },
        402,
        "Payment Required",
      ),
    );
    const r = await run({ query: "synthetic query" });
    expect(r.error).toBe(
      "Jina search failed: 402 Payment Required — InsufficientBalanceError: out of tokens",
    );
    expect(r.hint).toBe(
      "key invalid or out of tokens; check the Jina dashboard",
    );
  });

  it("401 gets the key hint too", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonRes({ message: "bad key" }, 401, "Unauthorized"),
    );
    const r = await run({ query: "synthetic query" });
    expect(r.error).toBe("Jina search failed: 401 Unauthorized — bad key");
    expect(r.hint).toContain("key invalid");
  });

  it("429 points at web_search", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonRes("slow down", 429, "Too Many Requests"),
    );
    const r = await run({ query: "synthetic query" });
    expect(r.error).toContain("429 Too Many Requests");
    expect(r.hint).toBe("rate limited; use web_search");
  });

  it("other failures have no hint; a thrown fetch is an error JSON", async () => {
    mockFetch.mockResolvedValueOnce({
      ...jsonRes(null, 500, "Server Error"),
      text: async () => "<html>oops</html>",
    });
    expect(await run({ query: "synthetic query" })).toEqual({
      error: "Jina search failed: 500 Server Error",
    });
    mockFetch.mockRejectedValueOnce(new Error("network down"));
    expect((await run({ query: "synthetic query" })).error).toBe(
      "Jina search failed: network down",
    );
  });

  it("evicts an oversized result and returns parseable JSON near the cap", async () => {
    const data = Array.from({ length: 10 }, (_, i) => ({
      title: `Result ${i}`,
      url: `https://example.com/${i}`,
      description: "snippet",
      content: "c".repeat(3000),
    }));
    mockFetch.mockResolvedValueOnce(jsonRes({ code: 200, data }));
    const raw = await jinaSearchTool.execute({
      query: "synthetic query",
      num: 10,
      with_content: true,
    });
    expect(raw.length).toBeLessThanOrEqual(5_000);
    const r = JSON.parse(raw);
    expect(evictToFile).toHaveBeenCalledTimes(1);
    const [full, prefix, max] = vi.mocked(evictToFile).mock.calls[0];
    expect(prefix).toBe("jina-search");
    expect(max).toBe(5_000);
    expect(JSON.parse(full).results[0].content).toHaveLength(1500);
    expect(r.truncated).toBe(true);
    expect(r.full_content_path).toBe("/tmp/evicted-search.txt");
    expect(r.count).toBe(10);
    expect(r.results[9].url).toBe("https://example.com/9");
    expect(r.results[0].content.length).toBeGreaterThan(0);
    expect(r.results[0].content.length).toBeLessThan(1500);
  });
});
