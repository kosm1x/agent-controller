import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../lib/stealth-browser.js", () => ({
  isCloudflareChallenge: (html: string) =>
    html.includes("challenges.cloudflare.com"),
  stealthFetch: vi.fn(async () => ({
    content: "stealth content",
    finalUrl: "https://example.com/",
    solved: true,
  })),
}));

vi.mock("../../lib/eviction.js", () => ({
  evictToFile: vi.fn((content: string, _prefix: string, max: number) => ({
    preview: content.slice(0, max),
    filePath: "/tmp/evicted.txt",
  })),
}));

vi.mock("../../lib/pdf.js", () => ({ extractPdfFromUrl: vi.fn() }));

import { webReadTool } from "./web-read.js";
import { parseTweetId } from "./web-read-tweet.js";
import { evictToFile } from "../../lib/eviction.js";
import { stealthFetch } from "../../lib/stealth-browser.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const TWEET_URL = "https://x.com/nick_zv_/status/2103107942627283120";

function jsonRes(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function textRes(body: string, status = 200, statusText = "OK") {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: new Headers({ "content-type": "text/markdown" }),
    json: async () => JSON.parse(body),
    text: async () => body,
  };
}

const FX_TWEET = {
  code: 200,
  tweet: {
    url: TWEET_URL,
    text: "SEO in 2025: stop paying for tools",
    author: { name: "Nick Z", screen_name: "Nick_zv_" },
    created_at: "Thu Sep 24 13:03:02 +0000 2026",
    likes: 18,
    retweets: 1,
    replies: 3,
    views: 1545,
    quote: { text: "quoted words", author: { name: "Q", screen_name: "qq" } },
    media: {
      all: [{ type: "photo", url: "https://pbs.twimg.com/media/a.jpg" }],
    },
  },
};

beforeEach(() => {
  mockFetch.mockReset();
});

describe("parseTweetId", () => {
  it.each([
    [
      "https://x.com/nick_zv_/status/2103107942627283120",
      "2103107942627283120",
    ],
    ["https://www.x.com/a/status/123?s=20&t=abc", "123"],
    ["https://twitter.com/jack/status/20", "20"],
    ["https://mobile.twitter.com/jack/status/20/photo/1", "20"],
    ["https://x.com/i/web/status/456", "456"],
    ["https://fxtwitter.com/a/status/789", "789"],
  ])("detects %s", (url, id) => {
    expect(parseTweetId(url)).toBe(id);
  });

  it.each([
    "https://x.com/nick_zv_",
    "https://x.com/home",
    "https://x.com/a/status/notanumber",
    "https://example.com/a/status/123",
    "https://notx.com/a/status/123",
    "https://x.com/i/article/2103022595113189376",
    "not a url",
  ])("rejects %s", (url) => {
    expect(parseTweetId(url)).toBeNull();
  });
});

describe("web_read tweets", () => {
  it("renders an fxtwitter tweet without calling Jina", async () => {
    mockFetch.mockResolvedValueOnce(jsonRes(FX_TWEET));
    const r = JSON.parse(await webReadTool.execute({ url: TWEET_URL }));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe(
      "https://api.fxtwitter.com/status/2103107942627283120",
    );
    expect(r.source).toBe("fxtwitter");
    expect(r.url).toBe(TWEET_URL);
    expect(r.truncated).toBe(false);
    expect(r.content).toContain("@Nick_zv_");
    expect(r.content).toContain("SEO in 2025");
    expect(r.content).toContain("> Quoting **Q** (@qq):\n> quoted words");
    expect(r.content).toContain("https://pbs.twimg.com/media/a.jpg");
    expect(r.content).toContain(
      "Likes 18 · Reposts 1 · Replies 3 · Views 1545",
    );
  });

  it("renders an X Article and evicts long bodies", async () => {
    const blocks = [
      { type: "unstyled", text: "Intro paragraph." },
      { type: "header-two", text: "Step 0" },
      { type: "atomic", text: " " },
      { type: "ordered-list-item", text: "first" },
      { type: "ordered-list-item", text: "second" },
      { type: "blockquote", text: "prompt line 1\nprompt line 2" },
      { type: "unstyled", text: "x".repeat(6_000) },
    ];
    mockFetch.mockResolvedValueOnce(
      jsonRes({
        code: 200,
        tweet: {
          ...FX_TWEET.tweet,
          quote: undefined,
          media: undefined,
          text: "https://x.com/i/article/1",
          article: { title: "Automate your SEO", content: { blocks } },
        },
      }),
    );
    const r = JSON.parse(await webReadTool.execute({ url: TWEET_URL }));
    expect(r.source).toBe("fxtwitter");
    expect(r.truncated).toBe(true);
    expect(r.full_content_path).toBe("/tmp/evicted.txt");
    expect(r.chars).toBeGreaterThan(6_000);
    expect(r.content).toContain("## Automate your SEO");
    expect(r.content).toContain(
      "Intro paragraph.\n\n## Step 0\n\n1. first\n\n2. second",
    );
    expect(r.content).toContain("> prompt line 1\n> prompt line 2");
  });

  it("falls back to syndication when fxtwitter fails", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonRes({ code: 404 }, false, 404))
      .mockResolvedValueOnce(
        jsonRes({
          __typename: "Tweet",
          text: "syndicated text",
          created_at: "2026-09-24T13:03:02.000Z",
          favorite_count: 18,
          conversation_count: 3,
          user: { name: "Nick Z", screen_name: "Nick_zv_" },
          mediaDetails: [
            { media_url_https: "https://pbs.twimg.com/media/b.jpg" },
          ],
        }),
      );
    const r = JSON.parse(await webReadTool.execute({ url: TWEET_URL }));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1][0]).toContain(
      "cdn.syndication.twimg.com/tweet-result?id=2103107942627283120",
    );
    expect(r.source).toBe("syndication");
    expect(r.content).toContain("syndicated text");
    expect(r.content).toContain("@Nick_zv_");
    expect(r.content).toContain("https://pbs.twimg.com/media/b.jpg");
  });

  it("falls through to Jina when both tweet endpoints fail", async () => {
    mockFetch
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(jsonRes({}, false, 404))
      .mockResolvedValueOnce(textRes("jina markdown"));
    const r = JSON.parse(await webReadTool.execute({ url: TWEET_URL }));
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[2][0]).toBe(`https://r.jina.ai/${TWEET_URL}`);
    expect(r.content).toBe("jina markdown");
    expect(r.source).toBeUndefined();
  });

  const SYN_OK = {
    __typename: "Tweet",
    text: "syndicated text",
    user: { name: "Nick Z", screen_name: "Nick_zv_" },
  };

  it.each([
    ["media.all not an array", { ...FX_TWEET.tweet, media: { all: {} } }],
    ["quote text not a string", { ...FX_TWEET.tweet, quote: { text: 5 } }],
    [
      "article blocks not iterable",
      { ...FX_TWEET.tweet, article: { content: { blocks: {} } } },
    ],
    [
      "article block text not a string",
      {
        ...FX_TWEET.tweet,
        article: { content: { blocks: [{ type: "unstyled", text: 7 }] } },
      },
    ],
    ["empty tweet object", {}],
  ])(
    "malformed fxtwitter (%s) falls through to syndication",
    async (_label, tweet) => {
      mockFetch
        .mockResolvedValueOnce(jsonRes({ code: 200, tweet }))
        .mockResolvedValueOnce(jsonRes(SYN_OK));
      const r = JSON.parse(await webReadTool.execute({ url: TWEET_URL }));
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(r.source).toBe("syndication");
      expect(r.content).toContain("syndicated text");
      expect(r.content).not.toContain("@unknown");
    },
  );

  it("both sources malformed falls through to Jina", async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonRes({
          code: 200,
          tweet: { ...FX_TWEET.tweet, media: { all: {} } },
        }),
      )
      .mockResolvedValueOnce(jsonRes({ ...SYN_OK, mediaDetails: {} }))
      .mockResolvedValueOnce(textRes("jina markdown"));
    const r = JSON.parse(await webReadTool.execute({ url: TWEET_URL }));
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[2][0]).toBe(`https://r.jina.ai/${TWEET_URL}`);
    expect(r.content).toBe("jina markdown");
  });

  it("a throw on the tweet path (execute-level catch, via evictToFile) falls through to Jina", async () => {
    vi.mocked(evictToFile).mockImplementationOnce(() => {
      throw new Error("disk");
    });
    mockFetch
      .mockResolvedValueOnce(
        jsonRes({
          code: 200,
          tweet: { ...FX_TWEET.tweet, text: "x".repeat(6_000) },
        }),
      )
      .mockResolvedValueOnce(textRes("jina markdown"));
    const r = JSON.parse(await webReadTool.execute({ url: TWEET_URL }));
    expect(r.content).toBe("jina markdown");
  });

  it("flags syndication long posts as truncated", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonRes({ code: 404 }, false, 404))
      .mockResolvedValueOnce(jsonRes({ ...SYN_OK, note_tweet: { id: "abc" } }));
    const r = JSON.parse(await webReadTool.execute({ url: TWEET_URL }));
    expect(r.source).toBe("syndication");
    expect(r.content).toContain("long post — the source truncates the text");
  });

  it("non-tweet URLs go straight to Jina", async () => {
    mockFetch.mockResolvedValueOnce(textRes("page"));
    await webReadTool.execute({ url: "https://example.com/a" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe(
      "https://r.jina.ai/https://example.com/a",
    );
  });
});

describe("web_read Jina errors", () => {
  it("surfaces Jina's AbuseAlleviation reason with a browser hint", async () => {
    const body = JSON.stringify({
      data: null,
      code: 403,
      name: "AbuseAlleviationError",
      status: 40305,
      message: "Anonymous access to domain x.com blocked",
      readableMessage:
        "AbuseAlleviationError: Anonymous access to domain x.com blocked until Fri Sep 25 2026 " +
        "y".repeat(400),
    });
    mockFetch.mockResolvedValueOnce(textRes(body, 403, "Forbidden"));
    const r = JSON.parse(
      await webReadTool.execute({ url: "https://example.com/blocked" }),
    );
    expect(r.url).toBe("https://example.com/blocked");
    expect(r.error).toContain("403 Forbidden");
    expect(r.error).toContain(
      "AbuseAlleviationError: Anonymous access to domain x.com",
    );
    expect(r.error.length).toBeLessThan(400);
    expect(r.hint).toContain("browser__goto");
    expect(r.hint).toContain("browser__markdown");
  });

  it("tolerates a non-JSON 429 body", async () => {
    mockFetch.mockResolvedValueOnce(
      textRes("slow down please", 429, "Too Many Requests"),
    );
    const r = JSON.parse(
      await webReadTool.execute({ url: "https://example.com/r" }),
    );
    expect(r.error).toBe(
      "Failed to read URL: 429 Too Many Requests — slow down please",
    );
    expect(r.hint).toContain("browser__goto");
  });

  it("keeps the plain error for other statuses without reading the body", async () => {
    const res = textRes("oops", 500, "Internal Server Error");
    const text = vi.spyOn(res, "text");
    mockFetch.mockResolvedValueOnce(res);
    const r = JSON.parse(
      await webReadTool.execute({ url: "https://example.com/e" }),
    );
    expect(text).not.toHaveBeenCalled();
    expect(r).toEqual({
      error: "Failed to read URL: 500 Internal Server Error",
      url: "https://example.com/e",
    });
  });

  it("still routes a Cloudflare 403 to the stealth browser", async () => {
    mockFetch.mockResolvedValueOnce(
      textRes(
        '<script src="https://challenges.cloudflare.com/x"></script>',
        403,
        "Forbidden",
      ),
    );
    const r = JSON.parse(
      await webReadTool.execute({ url: "https://example.com/cf" }),
    );
    expect(r.source).toBe("stealth-browser");
    expect(r.content).toBe("stealth content");
    expect(r.hint).toBeUndefined();
  });

  it("still routes a Cloudflare 503 to the stealth browser", async () => {
    mockFetch.mockResolvedValueOnce(
      textRes(
        '<script src="https://challenges.cloudflare.com/x"></script>',
        503,
        "Service Unavailable",
      ),
    );
    const r = JSON.parse(
      await webReadTool.execute({ url: "https://example.com/cf503" }),
    );
    expect(r.source).toBe("stealth-browser");
    expect(r.content).toBe("stealth content");
    expect(r.hint).toBeUndefined();
  });
});

describe("web_read Jina Reader options", () => {
  const URL_A = "https://example.com/opts";
  const call = (i = 0) => mockFetch.mock.calls[i];
  // Real Responses: a body can be read once, like in production
  const realRes = (body: string, status = 200, statusText = "OK") =>
    new Response(body, { status, statusText });

  beforeEach(() => {
    vi.stubEnv("JINA_API_KEY", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("A0: { url } alone sends exactly today's request (no key)", async () => {
    mockFetch.mockResolvedValueOnce(realRes("page"));
    const r = JSON.parse(await webReadTool.execute({ url: URL_A }));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(call()[0]).toBe(`https://r.jina.ai/${URL_A}`);
    expect(call()[1].headers).toEqual({ Accept: "text/markdown" });
    expect(Object.keys(call()[1])).toEqual(["headers", "signal"]);
    expect(r).toEqual({
      url: URL_A,
      content: "page",
      chars: 4,
      truncated: false,
    });
  });

  it("A0: { url } alone with a key adds only Authorization", async () => {
    vi.stubEnv("JINA_API_KEY", "test-key");
    mockFetch.mockResolvedValueOnce(realRes("page"));
    await webReadTool.execute({ url: URL_A });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(call()[1].headers).toEqual({
      Accept: "text/markdown",
      Authorization: "Bearer test-key",
    });
  });

  it("maps every option to its Jina header", async () => {
    vi.stubEnv("JINA_API_KEY", "test-key");
    mockFetch.mockResolvedValueOnce(realRes("page"));
    await webReadTool.execute({
      url: URL_A,
      selector: " article ",
      wait_for: "#content",
      remove_selector: "nav, footer",
      engine: "direct",
      fresh: true,
      format: "markdown",
      links_summary: true,
      images_summary: true,
      strip_images: true,
      timeout_s: 30,
      max_tokens: 4000,
      locale: "es-MX",
      proxy: "mx",
      wait: "network-idle",
    });
    expect(call()[1].headers).toEqual({
      Accept: "text/markdown",
      Authorization: "Bearer test-key",
      "X-Target-Selector": "article",
      "X-Wait-For-Selector": "#content",
      "X-Remove-Selector": "nav, footer",
      "X-Engine": "direct",
      "X-No-Cache": "true",
      "X-With-Links-Summary": "true",
      "X-With-Images-Summary": "true",
      "X-Retain-Images": "none",
      "X-Timeout": "30",
      "X-Max-Tokens": "4000",
      "X-Locale": "es-MX",
      "X-Proxy": "mx",
      "X-Respond-Timing": "network-idle",
    });
  });

  it("omits empty selectors and false booleans", async () => {
    mockFetch.mockResolvedValueOnce(realRes("page"));
    await webReadTool.execute({
      url: URL_A,
      selector: "   ",
      wait_for: "",
      fresh: false,
      links_summary: false,
      strip_images: false,
    });
    expect(call()[1].headers).toEqual({ Accept: "text/markdown" });
  });

  it("format text switches Accept and sends X-Respond-With", async () => {
    mockFetch.mockResolvedValueOnce(realRes("plain page"));
    await webReadTool.execute({ url: URL_A, format: "text" });
    expect(call()[1].headers).toEqual({
      Accept: "text/plain",
      "X-Respond-With": "text",
    });
  });

  it("format html sends X-Respond-With html with text/plain Accept", async () => {
    mockFetch.mockResolvedValueOnce(realRes("<p>x</p>"));
    await webReadTool.execute({ url: URL_A, format: "html" });
    expect(call()[1].headers).toEqual({
      Accept: "text/plain",
      "X-Respond-With": "html",
    });
  });

  it("timeout_s sets X-Timeout and widens the local abort to n + 5 s", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    mockFetch.mockResolvedValueOnce(realRes("page"));
    await webReadTool.execute({ url: URL_A, timeout_s: 40 });
    expect(call()[1].headers["X-Timeout"]).toBe("40");
    expect(setTimeoutSpy.mock.calls.some((c) => c[1] === 45_000)).toBe(true);
    setTimeoutSpy.mockClear();
    mockFetch.mockResolvedValueOnce(realRes("page"));
    await webReadTool.execute({ url: URL_A });
    expect(setTimeoutSpy.mock.calls.some((c) => c[1] === 15_000)).toBe(true);
    setTimeoutSpy.mockRestore();
  });

  it.each([
    [{ engine: "chrome" }, "engine"],
    [{ format: "pdf" }, "format"],
    [{ wait: "load" }, "wait"],
    [{ timeout_s: 4 }, "timeout_s"],
    [{ timeout_s: 61 }, "timeout_s"],
    [{ timeout_s: 10.5 }, "timeout_s"],
    [{ timeout_s: "30" }, "timeout_s"],
    [{ max_tokens: 100 }, "max_tokens"],
    [{ max_tokens: 20_001 }, "max_tokens"],
    [{ locale: "es_MX" }, "locale"],
    [{ locale: "ES" }, "locale"],
    [{ proxy: "MX" }, "proxy"],
    [{ proxy: "usa" }, "proxy"],
    [{ selector: "a".repeat(201) }, "selector"],
    [{ wait_for: 42 }, "wait_for"],
    [{ selector: "a\r\nX-Evil: 1" }, "selector"],
    [{ remove_selector: "[title='日本']" }, "remove_selector"],
    [{ wait_for: ".café" }, "wait_for"],
    [{ selector: "main\n" }, "selector"],
  ])("rejects %o without fetching", async (opt, name) => {
    const r = JSON.parse(await webReadTool.execute({ url: URL_A, ...opt }));
    expect(mockFetch).not.toHaveBeenCalled();
    expect(r.url).toBe(URL_A);
    expect(r.error).toContain(name);
  });

  it("proxy without a key is ignored with a note", async () => {
    mockFetch.mockResolvedValueOnce(realRes("page"));
    const r = JSON.parse(
      await webReadTool.execute({ url: URL_A, proxy: "auto" }),
    );
    expect(call()[1].headers).toEqual({ Accept: "text/markdown" });
    expect(r.note).toBe("proxy ignored: JINA_API_KEY not set");
    expect(r.content).toBe("page");
  });

  it("retries a non-Cloudflare 403 with no-cache + browser + proxy and flags retried", async () => {
    vi.stubEnv("JINA_API_KEY", "test-key");
    mockFetch
      .mockResolvedValueOnce(realRes("blocked", 403, "Forbidden"))
      .mockResolvedValueOnce(realRes("# real page"));
    const r = JSON.parse(
      await webReadTool.execute({ url: URL_A, selector: "main" }),
    );
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(call(1)[0]).toBe(`https://r.jina.ai/${URL_A}`);
    expect(call(1)[1].headers).toEqual({
      Accept: "text/markdown",
      Authorization: "Bearer test-key",
      "X-Target-Selector": "main",
      "X-No-Cache": "true",
      "X-Engine": "browser",
      "X-Proxy": "auto",
    });
    expect(call(1)[1].signal).toBe(call(0)[1].signal);
    expect(r.content).toBe("# real page");
    expect(r.retried).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it("retries a 503 without a key and sends no proxy", async () => {
    mockFetch
      .mockResolvedValueOnce(realRes("busy", 503, "Service Unavailable"))
      .mockResolvedValueOnce(realRes("ok page"));
    const r = JSON.parse(await webReadTool.execute({ url: URL_A }));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(call(1)[1].headers).toEqual({
      Accept: "text/markdown",
      "X-No-Cache": "true",
      "X-Engine": "browser",
    });
    expect(r.retried).toBe(true);
  });

  it("a failed 403 retry keeps the ORIGINAL status, reason and hint", async () => {
    mockFetch
      .mockResolvedValueOnce(realRes("first reason", 403, "Forbidden"))
      .mockResolvedValueOnce(realRes("second reason", 500, "Server Error"));
    const r = JSON.parse(await webReadTool.execute({ url: URL_A }));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(r.error).toBe("Failed to read URL: 403 Forbidden — first reason");
    expect(r.hint).toContain("browser__goto");
    expect(r.retried).toBeUndefined();
  });

  it("a thrown retry keeps the original failure", async () => {
    mockFetch
      .mockResolvedValueOnce(realRes("first reason", 403, "Forbidden"))
      .mockRejectedValueOnce(new Error("aborted"));
    const r = JSON.parse(await webReadTool.execute({ url: URL_A }));
    expect(r.error).toBe("Failed to read URL: 403 Forbidden — first reason");
  });

  it("never retries a 429", async () => {
    mockFetch.mockResolvedValueOnce(
      realRes("slow down", 429, "Too Many Requests"),
    );
    const r = JSON.parse(await webReadTool.execute({ url: URL_A }));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(r.error).toBe(
      "Failed to read URL: 429 Too Many Requests — slow down",
    );
  });

  it("does not retry a Cloudflare 403 (stealth path instead)", async () => {
    mockFetch.mockResolvedValueOnce(
      realRes(
        '<script src="https://challenges.cloudflare.com/x"></script>',
        403,
        "Forbidden",
      ),
    );
    const r = JSON.parse(await webReadTool.execute({ url: URL_A }));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(r.source).toBe("stealth-browser");
  });

  it("does not retry when the first attempt already used the browser engine", async () => {
    mockFetch.mockResolvedValueOnce(realRes("blocked", 403, "Forbidden"));
    const r = JSON.parse(
      await webReadTool.execute({ url: URL_A, engine: "browser" }),
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(r.error).toBe("Failed to read URL: 403 Forbidden — blocked");
  });

  it("does not retry a 451", async () => {
    mockFetch.mockResolvedValueOnce(
      realRes("legal block", 451, "Unavailable For Legal Reasons"),
    );
    const r = JSON.parse(await webReadTool.execute({ url: URL_A }));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(r.error).toContain("451");
  });

  it("format html keeps a normal page that loads challenges.cloudflare.com (no stealth)", async () => {
    const html =
      '<html><head><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script></head><body>contact form</body></html>';
    mockFetch.mockResolvedValueOnce(realRes(html));
    const r = JSON.parse(
      await webReadTool.execute({ url: URL_A, format: "html" }),
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(r.source).toBeUndefined();
    expect(r.content).toBe(html);
  });

  it("403 with a Cloudflare body and format html still goes to stealth", async () => {
    vi.mocked(stealthFetch).mockClear();
    mockFetch.mockResolvedValueOnce(
      realRes(
        '<script src="https://challenges.cloudflare.com/x"></script>',
        403,
        "Forbidden",
      ),
    );
    const r = JSON.parse(
      await webReadTool.execute({ url: URL_A, format: "html" }),
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(stealthFetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(stealthFetch).mock.calls[0][0]).toBe(URL_A);
    expect(r.source).toBe("stealth-browser");
  });

  it("markdown still routes a 200 Cloudflare challenge body to stealth", async () => {
    mockFetch.mockResolvedValueOnce(
      realRes('<script src="https://challenges.cloudflare.com/x"></script>'),
    );
    const r = JSON.parse(await webReadTool.execute({ url: URL_A }));
    expect(r.source).toBe("stealth-browser");
  });
});
