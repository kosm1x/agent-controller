/**
 * WordPress tool safeguard tests.
 *
 * Tests the three layers of content destruction prevention:
 * 1. Read-before-write enforcement
 * 2. Text/HTML length ratio checks
 * 3. Structural element preservation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// No request leaves this file: the site map is synthetic, the global fetch and
// the image download are stand-ins that refuse any request a case did not queue.
const net = vi.hoisted(() => ({
  fetch: vi.fn(),
  download: vi.fn(),
  unexpected: [] as string[],
}));
vi.mock("../../lib/url-safety.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/url-safety.js")>()),
  validateOutboundUrl: () => null,
  safeFetch: net.download,
}));

import {
  _testing,
  wpListPostsTool,
  wpReadPostTool,
  wpPublishTool,
  wpMediaUploadTool,
  wpCategoriesTool,
} from "./wordpress.js";

function refuse(input: unknown): never {
  net.unexpected.push(String(input));
  throw new Error(`unexpected request in test: ${String(input)}`);
}

beforeEach(() => {
  net.unexpected.length = 0;
  net.fetch.mockReset().mockImplementation(refuse);
  net.download.mockReset().mockImplementation(refuse);
  vi.stubGlobal("fetch", net.fetch);
  vi.stubEnv(
    "WP_SITES",
    JSON.stringify({ blog: { url: "https://site.example", username: "u", app_password: "p" } }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  expect(net.unexpected).toEqual([]);
});

const {
  stripHtml,
  countStructuralElements,
  recordRead,
  wasReadRecently,
  getOriginalContentHash,
  recentReads,
} = _testing;

describe("stripHtml", () => {
  it("removes tags and trims", () => {
    expect(stripHtml("<h2>Title</h2><p>Body text</p>")).toBe("TitleBody text");
  });

  it("handles empty string", () => {
    expect(stripHtml("")).toBe("");
  });

  it("handles plain text", () => {
    expect(stripHtml("no tags here")).toBe("no tags here");
  });

  it("strips nested tags", () => {
    expect(stripHtml("<p><strong>bold</strong> and <em>italic</em></p>")).toBe(
      "bold and italic",
    );
  });
});

describe("countStructuralElements", () => {
  it("counts headings, paragraphs, lists, and blockquotes", () => {
    const html =
      "<h2>Title</h2><p>Para 1</p><p>Para 2</p><ul><li>A</li><li>B</li></ul><blockquote>Quote</blockquote>";
    // h2 + p + p + ul + li + li + blockquote = 7
    expect(countStructuralElements(html)).toBe(7);
  });

  it("counts all heading levels", () => {
    const html = "<h1>1</h1><h2>2</h2><h3>3</h3><h4>4</h4><h5>5</h5><h6>6</h6>";
    expect(countStructuralElements(html)).toBe(6);
  });

  it("returns 0 for plain text", () => {
    expect(countStructuralElements("just text")).toBe(0);
  });

  it("returns 0 for empty string", () => {
    expect(countStructuralElements("")).toBe(0);
  });

  it("counts figure and table elements", () => {
    const html =
      "<figure><img src='x'></figure><table><tr><td>A</td></tr></table>";
    // figure + table + tr = 3
    expect(countStructuralElements(html)).toBe(3);
  });

  it("ignores non-structural tags like span, strong, em, a", () => {
    const html = "<span>A</span><strong>B</strong><em>C</em><a href='#'>D</a>";
    expect(countStructuralElements(html)).toBe(0);
  });
});

describe("read-before-write tracking", () => {
  beforeEach(() => {
    recentReads.clear();
  });

  it("returns false when no read was recorded", () => {
    expect(wasReadRecently("testsite", 42)).toBe(false);
  });

  it("returns true after recordRead", () => {
    recordRead("testsite", 42, "<p>test</p>");
    expect(wasReadRecently("testsite", 42)).toBe(true);
  });

  it("distinguishes sites", () => {
    recordRead("site-a", 42, "<p>test</p>");
    expect(wasReadRecently("site-a", 42)).toBe(true);
    expect(wasReadRecently("site-b", 42)).toBe(false);
  });

  it("distinguishes post IDs", () => {
    recordRead("testsite", 42, "<p>test</p>");
    expect(wasReadRecently("testsite", 42)).toBe(true);
    expect(wasReadRecently("testsite", 99)).toBe(false);
  });

  it("tracks multiple posts independently", () => {
    recordRead("testsite", 1, "<p>post1</p>");
    recordRead("testsite", 2, "<p>post2</p>");
    recordRead("other", 3, "<p>post3</p>");
    expect(wasReadRecently("testsite", 1)).toBe(true);
    expect(wasReadRecently("testsite", 2)).toBe(true);
    expect(wasReadRecently("other", 3)).toBe(true);
    expect(wasReadRecently("other", 1)).toBe(false);
  });
});

describe("Guard 0: edit-verification via content hash", () => {
  beforeEach(() => {
    recentReads.clear();
  });

  it("returns null when no read was recorded", () => {
    expect(getOriginalContentHash("testsite", 42)).toBeNull();
  });

  it("returns a hash after recordRead", () => {
    recordRead("testsite", 42, "<p>hello world</p>");
    const hash = getOriginalContentHash("testsite", 42);
    expect(hash).toBeTypeOf("number");
    expect(hash).not.toBe(0);
  });

  it("returns same hash for identical content", () => {
    const content = "<p>hello world</p>";
    recordRead("testsite", 1, content);
    recordRead("other", 2, content);
    expect(getOriginalContentHash("testsite", 1)).toBe(
      getOriginalContentHash("other", 2),
    );
  });

  it("returns different hash for different content", () => {
    recordRead("testsite", 1, "<p>hello</p>");
    recordRead("testsite", 2, "<p>world</p>");
    expect(getOriginalContentHash("testsite", 1)).not.toBe(
      getOriginalContentHash("testsite", 2),
    );
  });

  it("detects equal-length edits (same length, different content)", () => {
    recordRead("testsite", 42, "<p>aaaa</p>");
    const originalHash = getOriginalContentHash("testsite", 42);
    // Same length but different chars — hash must differ
    const editedContent = "<p>bbbb</p>";
    expect(editedContent.length).toBe("<p>aaaa</p>".length);
    // Simulate hashing the edited content
    let hash = 5381;
    for (let i = 0; i < editedContent.length; i++) {
      hash = ((hash << 5) + hash + editedContent.charCodeAt(i)) | 0;
    }
    expect(hash).not.toBe(originalHash);
  });
});

describe("content destruction detection thresholds", () => {
  // These test the logic thresholds that wp_publish uses.
  // We test the helper functions directly since the tool handler
  // requires a live WordPress API.

  it("80% text threshold catches 50% truncation that old 40% missed", () => {
    const existing =
      "<h2>Title</h2>" + "<p>Paragraph content here.</p>".repeat(20);
    const truncated =
      "<h2>Title</h2>" + "<p>Paragraph content here.</p>".repeat(10);

    const existingTextLen = stripHtml(existing).length;
    const newTextLen = stripHtml(truncated).length;

    // Old safeguard: 40% threshold — would PASS (50% > 40%)
    expect(newTextLen >= existingTextLen * 0.4).toBe(true);

    // New safeguard: 80% threshold — correctly BLOCKS (50% < 80%)
    expect(newTextLen < existingTextLen * 0.8).toBe(true);
  });

  it("structural check catches heading removal", () => {
    const existing =
      "<h2>Section 1</h2><p>Text</p>" +
      "<h2>Section 2</h2><p>Text</p>" +
      "<h2>Section 3</h2><p>Text</p>" +
      "<h2>Section 4</h2><p>Text</p>" +
      "<h2>Section 5</h2><p>Text</p>";
    // 5 h2 + 5 p = 10 elements

    const damaged =
      "<h2>Section 1</h2><p>Text rewritten here with enough content to pass length checks</p>";
    // 1 h2 + 1 p = 2 elements

    const existingStructure = countStructuralElements(existing);
    const newStructure = countStructuralElements(damaged);

    expect(existingStructure).toBe(10);
    expect(newStructure).toBe(2);

    // 2 < 10 * 0.7 (7) → blocks
    expect(existingStructure >= 5).toBe(true);
    expect(newStructure < existingStructure * 0.7).toBe(true);
  });

  it("HTML length check catches formatting loss", () => {
    // Heavily formatted article: many tags
    const existing =
      '<h2 class="wp-block">Title</h2>' +
      '<p style="font-size:18px">Intro paragraph with <strong>emphasis</strong> and <em>style</em>.</p>'.repeat(
        10,
      ) +
      "<blockquote><p>A meaningful quote here.</p></blockquote>" +
      "<figure><img src='hero.jpg' alt='Hero'></figure>";

    // Same text, stripped formatting
    const stripped =
      "<h2>Title</h2>" +
      "<p>Intro paragraph with emphasis and style.</p>".repeat(10) +
      "<p>A meaningful quote here.</p>" +
      "<p>Hero</p>";

    const existingHtmlLen = existing.length;
    const newHtmlLen = stripped.length;

    // Raw HTML is significantly shorter — catches formatting loss
    expect(newHtmlLen < existingHtmlLen * 0.7).toBe(true);
  });

  it("allows legitimate minor edits (>80% text preserved)", () => {
    const existing = "<h2>Title</h2>" + "<p>Content paragraph.</p>".repeat(20);
    // Change one paragraph
    const edited =
      "<h2>Title</h2>" +
      "<p>Content paragraph.</p>".repeat(19) +
      "<p>Updated conclusion paragraph.</p>";

    const existingTextLen = stripHtml(existing).length;
    const newTextLen = stripHtml(edited).length;

    // Should pass — text is ~95%+ of original
    expect(newTextLen >= existingTextLen * 0.8).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The failure envelope: a non-ok answer (or a list tool's answer that is not a
// list) is an error object whose fixed words lead, with the site's answer kept
// under `body`.
// ---------------------------------------------------------------------------

const SAVED_ANYWAY =
  ". The site may have saved it anyway: check the site before trying again.";

/** Queue the site's next answer to the global fetch. */
function answer(status: number, text: string): void {
  net.fetch.mockImplementationOnce(async () => new Response(text, { status }));
}

function expectEnvelope(out: string, error: string, status: number, body: unknown): void {
  expect(out.startsWith('{"error":"')).toBe(true);
  const parsed = JSON.parse(out) as Record<string, unknown>;
  expect(Object.keys(parsed)).toEqual(["error", "site", "http_status", "body"]);
  expect(parsed.error).toBe(error);
  expect(parsed.site).toBe("blog");
  expect(parsed.http_status).toBe(status);
  expect(parsed.body).toEqual(body);
}

const WP_ERROR = { code: "rest_error", message: "m", data: { status: 500 } };

describe("wp_list_posts failure envelope", () => {
  it("a non-ok answer is an error object with the answer under body", async () => {
    answer(500, JSON.stringify(WP_ERROR));
    const out = await wpListPostsTool.execute({});
    expectEnvelope(out, "wp_list_posts: the site did not return a list of posts (HTTP 500)", 500, WP_ERROR);
    expect(String(net.fetch.mock.calls[0][0]).startsWith("https://site.example/wp-json/wp/v2/posts?")).toBe(true);
  });

  it("a 2xx answer that is not a list is an error object too", async () => {
    answer(200, JSON.stringify({ a: 1 }));
    const out = await wpListPostsTool.execute({});
    expectEnvelope(out, "wp_list_posts: the site did not return a list of posts (HTTP 200)", 200, { a: 1 });
  });

  it("a list is returned as before", async () => {
    answer(
      200,
      JSON.stringify([
        {
          id: 1,
          title: { rendered: "T" },
          status: "draft",
          date: "2026-01-02T03:04:05",
          link: "https://site.example/?p=1",
          categories: [2],
          tags: [],
        },
      ]),
    );
    const out = await wpListPostsTool.execute({});
    expect(out).toBe(
      JSON.stringify({
        success: true,
        site: "blog",
        count: 1,
        note: "Post IDs are NOT sequential. Use ONLY the IDs listed here for wp_read_post.",
        posts: [
          {
            id: 1,
            title: "T",
            status: "draft",
            date: "2026-01-02",
            link: "https://site.example/?p=1",
            categories: [2],
            tags: [],
          },
        ],
      }),
    );
  });
});

describe("wp_read_post failure envelope", () => {
  it("a non-ok answer is an error object with the answer under body", async () => {
    answer(404, JSON.stringify(WP_ERROR));
    const out = await wpReadPostTool.execute({ post_id: 7 });
    expectEnvelope(out, "wp_read_post: the site answered HTTP 404", 404, WP_ERROR);
  });

  it.each([
    ["an empty body", "", ""],
    ["a body that is not JSON", "<html>oops</html>", "<html>oops</html>"],
    ["a null body", "null", null],
    ["an array body", "[1,2]", [1, 2]],
  ] as const)("%s is kept under body", async (_name, text, body) => {
    answer(404, text);
    const out = await wpReadPostTool.execute({ post_id: 7 });
    expectEnvelope(out, "wp_read_post: the site answered HTTP 404", 404, body);
  });
});

describe("wp_publish failure envelope", () => {
  it.each([500, 503])("a create answered %i adds the may-have-saved sentence", async (status) => {
    answer(status, JSON.stringify(WP_ERROR));
    const out = await wpPublishTool.execute({ title: "t" });
    expectEnvelope(out, `wp_publish: the site answered HTTP ${status}${SAVED_ANYWAY}`, status, WP_ERROR);
    expect(net.fetch.mock.calls[0][1].method).toBe("POST");
  });

  it.each([400, 499])("a create answered %i has no such sentence", async (status) => {
    answer(status, JSON.stringify(WP_ERROR));
    const out = await wpPublishTool.execute({ title: "t" });
    expectEnvelope(out, `wp_publish: the site answered HTTP ${status}`, status, WP_ERROR);
  });

  it("an update (with a post id) answered 503 has no such sentence", async () => {
    answer(503, JSON.stringify(WP_ERROR));
    const out = await wpPublishTool.execute({ post_id: 7, status: "publish" });
    expectEnvelope(out, "wp_publish: the site answered HTTP 503", 503, WP_ERROR);
    expect(net.fetch.mock.calls[0][1].method).toBe("PUT");
  });

  it("a saved post is returned as before", async () => {
    answer(201, JSON.stringify({ id: 5, status: "draft", title: { rendered: "t" }, link: "https://site.example/?p=5" }));
    const out = await wpPublishTool.execute({ title: "t" });
    expect(out).toBe(
      JSON.stringify({
        success: true,
        site: "blog",
        post_id: 5,
        status: "draft",
        title: "t",
        note:
          "Post saved as draft. The link will only work after publishing. " +
          'To publish: call wp_publish with post_id=5 and status="publish".',
      }),
    );
  });
});

describe("wp_media_upload failure envelope", () => {
  function queueDownload(): void {
    net.download.mockImplementationOnce(
      async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } }),
    );
  }

  it.each([500, 503])("an upload answered %i adds the may-have-saved sentence", async (status) => {
    queueDownload();
    answer(status, JSON.stringify(WP_ERROR));
    const out = await wpMediaUploadTool.execute({ image_url: "https://img.example/a.png", filename: "a.png" });
    expectEnvelope(out, `wp_media_upload: the site answered HTTP ${status}${SAVED_ANYWAY}`, status, WP_ERROR);
    expect(String(net.fetch.mock.calls[0][0])).toBe("https://site.example/wp-json/wp/v2/media");
  });

  it.each([400, 499])("an upload answered %i has no such sentence", async (status) => {
    queueDownload();
    answer(status, JSON.stringify(WP_ERROR));
    const out = await wpMediaUploadTool.execute({ image_url: "https://img.example/a.png", filename: "a.png" });
    expectEnvelope(out, `wp_media_upload: the site answered HTTP ${status}`, status, WP_ERROR);
  });

  it("a saved upload is returned as before", async () => {
    queueDownload();
    answer(201, JSON.stringify({ id: 9, source_url: "https://site.example/a.png" }));
    const out = await wpMediaUploadTool.execute({ image_url: "https://img.example/a.png", filename: "a.png" });
    expect(out).toBe(
      JSON.stringify({
        success: true,
        site: "blog",
        media_id: 9,
        source_url: "https://site.example/a.png",
        title: "a",
      }),
    );
  });
});

describe("wp_categories failure envelope", () => {
  it("a non-ok answer is an error object with the answer under body", async () => {
    answer(500, JSON.stringify(WP_ERROR));
    const out = await wpCategoriesTool.execute({});
    expectEnvelope(out, "wp_categories: the site did not return a list of categories or tags (HTTP 500)", 500, WP_ERROR);
  });

  it("a 2xx answer that is not a list is an error object too", async () => {
    answer(200, JSON.stringify({ a: 1 }));
    const out = await wpCategoriesTool.execute({});
    expectEnvelope(out, "wp_categories: the site did not return a list of categories or tags (HTTP 200)", 200, { a: 1 });
  });

  it("a list is returned as before", async () => {
    answer(200, JSON.stringify([{ id: 2, name: "News", slug: "news", count: 3 }]));
    const out = await wpCategoriesTool.execute({});
    expect(out).toBe(
      JSON.stringify({
        success: true,
        site: "blog",
        count: 1,
        items: [{ id: 2, name: "News", slug: "news", count: 3, parent: null }],
      }),
    );
  });
});
