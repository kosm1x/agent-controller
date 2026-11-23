/**
 * WordPress admin tools: the failure envelope and the successes it sits next to.
 *
 * No request leaves this file: the site map is synthetic and the global fetch
 * is a stand-in that refuses any request a case did not queue.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  wpPagesTool,
  wpPluginsTool,
  wpSettingsTool,
  wpDeleteTool,
  wpRawApiTool,
} from "./wordpress-admin.js";

const net = { fetch: vi.fn(), unexpected: [] as string[] };

function refuse(input: unknown): never {
  net.unexpected.push(String(input));
  throw new Error(`unexpected request in test: ${String(input)}`);
}

beforeEach(() => {
  net.unexpected.length = 0;
  net.fetch.mockReset().mockImplementation(refuse);
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

const SAVED_ANYWAY =
  ". The site may have saved it anyway: check the site before trying again.";

const WP_ERROR = { code: "rest_error", message: "m", data: { status: 500 } };

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

describe("wp_pages", () => {
  it("a non-ok answer is an error object with the answer under body", async () => {
    answer(500, JSON.stringify(WP_ERROR));
    const out = await wpPagesTool.execute({});
    expectEnvelope(out, "wp_pages: the site did not return a list of pages (HTTP 500)", 500, WP_ERROR);
    expect(String(net.fetch.mock.calls[0][0]).startsWith("https://site.example/wp-json/wp/v2/pages?")).toBe(true);
  });

  it("a 2xx answer that is not a list is an error object too", async () => {
    answer(200, JSON.stringify({ a: 1 }));
    const out = await wpPagesTool.execute({});
    expectEnvelope(out, "wp_pages: the site did not return a list of pages (HTTP 200)", 200, { a: 1 });
  });

  it("a list is returned as before", async () => {
    answer(
      200,
      JSON.stringify([
        { id: 3, title: { rendered: "About" }, status: "publish", slug: "about", link: "https://site.example/about", parent: 0, menu_order: 1 },
      ]),
    );
    const out = await wpPagesTool.execute({});
    expect(out).toBe(
      JSON.stringify({
        success: true,
        site: "blog",
        count: 1,
        pages: [
          { id: 3, title: "About", status: "publish", slug: "about", link: "https://site.example/about", parent: 0, menu_order: 1 },
        ],
      }),
    );
  });
});

describe("wp_plugins", () => {
  it("list: a non-ok answer is an error object with the answer under body", async () => {
    answer(500, JSON.stringify(WP_ERROR));
    const out = await wpPluginsTool.execute({ action: "list" });
    expectEnvelope(out, "wp_plugins list: the site did not return a list of plugins (HTTP 500)", 500, WP_ERROR);
  });

  it("list: a 2xx answer that is not a list is an error object too", async () => {
    answer(200, JSON.stringify({ a: 1 }));
    const out = await wpPluginsTool.execute({ action: "list" });
    expectEnvelope(out, "wp_plugins list: the site did not return a list of plugins (HTTP 200)", 200, { a: 1 });
  });

  it("list: a list is returned as before", async () => {
    answer(
      200,
      JSON.stringify([{ plugin: "a/a.php", name: "A", status: "active", version: "1.0", description: { raw: "d" } }]),
    );
    const out = await wpPluginsTool.execute({ action: "list" });
    expect(out).toBe(
      JSON.stringify({
        success: true,
        site: "blog",
        count: 1,
        plugins: [{ plugin: "a/a.php", name: "A", status: "active", version: "1.0", description: "d" }],
      }),
    );
  });

  it.each(["activate", "deactivate"] as const)("%s: a non-ok answer names the action", async (action) => {
    answer(503, JSON.stringify(WP_ERROR));
    const out = await wpPluginsTool.execute({ action, plugin: "a/a.php" });
    expectEnvelope(out, `wp_plugins ${action}: the site answered HTTP 503`, 503, WP_ERROR);
    expect(net.fetch.mock.calls[0][1].method).toBe("PUT");
  });

  it("activate: a done change is returned as before", async () => {
    answer(200, JSON.stringify({ plugin: "a/a.php", status: "active" }));
    const out = await wpPluginsTool.execute({ action: "activate", plugin: "a/a.php" });
    expect(out).toBe(JSON.stringify({ success: true, site: "blog", plugin: "a/a.php", status: "active" }));
  });

  it("install: a non-ok answer at 503 has no may-have-saved sentence", async () => {
    answer(503, JSON.stringify(WP_ERROR));
    const out = await wpPluginsTool.execute({ action: "install", slug: "a" });
    expectEnvelope(out, "wp_plugins install: the site answered HTTP 503", 503, WP_ERROR);
  });

  it("install: a done install is returned as before", async () => {
    answer(201, JSON.stringify({ plugin: "a/a.php", status: "active", name: "A" }));
    const out = await wpPluginsTool.execute({ action: "install", slug: "a" });
    expect(out).toBe(JSON.stringify({ success: true, site: "blog", plugin: "a/a.php", status: "active", name: "A" }));
  });
});

describe("wp_settings", () => {
  it("read: a non-ok answer is an error object with the answer under body", async () => {
    answer(500, JSON.stringify(WP_ERROR));
    const out = await wpSettingsTool.execute({});
    expectEnvelope(out, "wp_settings read: the site answered HTTP 500", 500, WP_ERROR);
  });

  it("update: a non-ok answer at 503 says update and has no may-have-saved sentence", async () => {
    answer(503, JSON.stringify(WP_ERROR));
    const out = await wpSettingsTool.execute({ title: "New" });
    expectEnvelope(out, "wp_settings update: the site answered HTTP 503", 503, WP_ERROR);
    expect(net.fetch.mock.calls[0][1].method).toBe("POST");
  });

  it("read: the settings are returned as before", async () => {
    answer(
      200,
      JSON.stringify({
        title: "T",
        description: "D",
        url: "https://site.example",
        email: "a@site.example",
        timezone_string: "UTC",
        date_format: "Y-m-d",
        time_format: "H:i",
        language: "en",
        posts_per_page: 10,
      }),
    );
    const out = await wpSettingsTool.execute({});
    expect(out).toBe(
      JSON.stringify({
        success: true,
        site: "blog",
        action: "read",
        settings: {
          title: "T",
          description: "D",
          url: "https://site.example",
          email: "a@site.example",
          timezone: "UTC",
          date_format: "Y-m-d",
          time_format: "H:i",
          language: "en",
          posts_per_page: 10,
        },
      }),
    );
  });
});

describe("wp_delete", () => {
  it("a non-ok answer is an error object with the answer under body", async () => {
    answer(404, JSON.stringify(WP_ERROR));
    const out = await wpDeleteTool.execute({ id: 7 });
    expectEnvelope(out, "wp_delete: the site answered HTTP 404", 404, WP_ERROR);
    expect(net.fetch.mock.calls[0][1].method).toBe("DELETE");
  });

  it("a delete answered 503 has no may-have-saved sentence", async () => {
    answer(503, JSON.stringify(WP_ERROR));
    const out = await wpDeleteTool.execute({ id: 7 });
    expectEnvelope(out, "wp_delete: the site answered HTTP 503", 503, WP_ERROR);
  });

  it.each([
    ["an empty body", "", ""],
    ["a body that is not JSON", "<html>oops</html>", "<html>oops</html>"],
    ["a null body", "null", null],
    ["an array body", "[1,2]", [1, 2]],
  ] as const)("%s is kept under body", async (_name, text, body) => {
    answer(404, text);
    const out = await wpDeleteTool.execute({ id: 7 });
    expectEnvelope(out, "wp_delete: the site answered HTTP 404", 404, body);
  });

  it("a done delete is returned as before", async () => {
    answer(200, JSON.stringify({ id: 7, title: { rendered: "T" } }));
    const out = await wpDeleteTool.execute({ id: 7 });
    expect(out).toBe(
      JSON.stringify({ success: true, site: "blog", deleted_id: 7, type: "posts", trashed: true, title: "T" }),
    );
  });
});

describe("wp_raw_api", () => {
  it.each([500, 503])("a POST answered %i adds the may-have-saved sentence", async (status) => {
    answer(status, JSON.stringify(WP_ERROR));
    const out = await wpRawApiTool.execute({ method: "POST", path: "/wp/v2/widgets", body: { a: 1 } });
    expectEnvelope(out, `wp_raw_api: the site answered HTTP ${status}${SAVED_ANYWAY}`, status, WP_ERROR);
    expect(String(net.fetch.mock.calls[0][0])).toBe("https://site.example/wp-json/wp/v2/widgets");
  });

  it("a lower-case post answered 503 adds the sentence too", async () => {
    answer(503, JSON.stringify(WP_ERROR));
    const out = await wpRawApiTool.execute({ method: "post", path: "/wp/v2/widgets" });
    expectEnvelope(out, `wp_raw_api: the site answered HTTP 503${SAVED_ANYWAY}`, 503, WP_ERROR);
  });

  it.each([400, 499])("a POST answered %i has no such sentence", async (status) => {
    answer(status, JSON.stringify(WP_ERROR));
    const out = await wpRawApiTool.execute({ method: "POST", path: "/wp/v2/widgets" });
    expectEnvelope(out, `wp_raw_api: the site answered HTTP ${status}`, status, WP_ERROR);
  });

  it.each(["GET", "PUT", "PATCH", "DELETE"] as const)("a %s answered 503 has no such sentence", async (method) => {
    answer(503, JSON.stringify(WP_ERROR));
    const out = await wpRawApiTool.execute({ method, path: "/wp/v2/widgets" });
    expectEnvelope(out, "wp_raw_api: the site answered HTTP 503", 503, WP_ERROR);
  });

  it("a text body over the cut length is kept cut under body", async () => {
    answer(500, "x".repeat(3500));
    const out = await wpRawApiTool.execute({ path: "/wp/v2/widgets" });
    expectEnvelope(out, "wp_raw_api: the site answered HTTP 500", 500, "x".repeat(3000));
  });

  it("a JSON body over the cut length is kept cut and marked under body", async () => {
    const big = { v: "y".repeat(3500) };
    answer(500, JSON.stringify(big));
    const out = await wpRawApiTool.execute({ path: "/wp/v2/widgets" });
    expectEnvelope(
      out,
      "wp_raw_api: the site answered HTTP 500",
      500,
      JSON.stringify(big).slice(0, 3000) + "...(truncated)",
    );
  });

  it("a success is returned as before", async () => {
    answer(200, JSON.stringify([{ id: "w1" }]));
    const out = await wpRawApiTool.execute({ path: "/wp/v2/widgets" });
    expect(out).toBe(JSON.stringify({ success: true, site: "blog", http_status: 200, data: [{ id: "w1" }] }));
  });
});

describe("site tool descriptions (exact text)", () => {
  // The model reads these texts when it chooses a tool: a change is deliberate, never incidental.
  it("wp_pages", () => {
    expect(wpPagesTool.definition.function.description).toBe(`List WordPress pages. Returns page IDs, titles, statuses, and links.

USE WHEN:
- To find pages on a site (About, Contact, etc.)
- To get a page ID before changing or removing the page
- To check what pages exist

DO NOT USE WHEN:
- You want to create or change a page: this tool only lists, and wp_publish writes posts only — use wp_raw_api when it is among your tools (path "/wp/v2/pages" to create, "/wp/v2/pages/<id>" to change).
- You want blog posts: this tool lists pages only — use wp_list_posts when it is among your tools.
- You need more than one batch: this tool has no page parameter and returns only the first per_page results (20 by default).`);
  });
  it("wp_plugins", () => {
    expect(wpPluginsTool.definition.function.description).toBe(`Manage WordPress plugins — list, activate, deactivate, or install.

USE WHEN:
- To check what plugins are installed on a site
- To activate/deactivate a plugin
- To install a plugin from the WordPress.org repository (by slug)

WORKFLOW for GA4 / script injection:
1. Call wp_plugins action="list" to check if a header scripts plugin exists
2. If not: wp_plugins action="install" slug="insert-headers-and-footers" (or "wpcode-insert-headers-and-footers")
3. wp_plugins action="activate" plugin="<plugin_file>" (use the "plugin" field from the list)
4. Use wp_raw_api when it is among your tools to configure the plugin's settings (each plugin stores its options differently)

COMMON PLUGINS for script injection:
- "insert-headers-and-footers" (WPCode) — stores header scripts in wp_option "ihaf_insert_header"
- "header-footer-code-manager" — stores in custom post type

DO NOT USE WHEN:
- You want a plugin installed but left off: install here also activates it — run deactivate afterwards if it must stay off.
- You want a plugin removed or updated: this tool has no delete, uninstall or update action; deactivate only turns it off.`);
  });
  it("wp_settings", () => {
    expect(wpSettingsTool.definition.function.description).toBe(`Read WordPress site settings (title, tagline, URL, timezone, etc.) or update the title and tagline.

USE WHEN:
- To check or change the site title, tagline, or description
- To verify the site URL or admin email
- To check the timezone or date/time format

For reading, call without any update fields. For updating, include the fields to change.

DO NOT USE WHEN:
- You want to change the URL, admin email, timezone, date format or language: this tool updates only the title and tagline — use wp_raw_api when it is among your tools (path "/wp/v2/settings").
- You need a setting outside title, tagline, URL, email, timezone, date and time format, language and posts per page: this tool returns only those.`);
  });
  it("wp_raw_api", () => {
    expect(wpRawApiTool.definition.function.description).toBe(`Call any WordPress REST API endpoint directly. This is the escape hatch for
operations not covered by specific wp_* tools.

USE WHEN:
- You need to call a plugin's custom REST endpoint
- You need to read/write wp_options (via a plugin that exposes them)
- You need to manage widgets, menus, or other less-common resources
- You need to configure a plugin's settings after installing it

EXAMPLES:
- List widgets: method="GET" path="/wp/v2/widgets"
- List widget areas: method="GET" path="/wp/v2/sidebars"
- Create widget: method="POST" path="/wp/v2/widgets" body={"sidebar":"wp_head","instance":{"content":"<script>...</script>"}}
- Read options (if exposed): method="GET" path="/wp/v2/settings"
- Call plugin endpoint: method="POST" path="/wpcode/v1/snippet" body={...}

The path is appended to the site's /wp-json/ base URL.

Any other tool named in this description or its parameters is usable only when it is among your tools.

DO NOT USE WHEN:
- You want to create or update a post: this tool skips wp_publish's read-before-write and content-loss checks — use wp_publish.
- You want to upload an image: this tool sends JSON bodies only, never a file — use wp_media_upload.
- You need a post's full HTML: answers over 3000 characters are cut here — use wp_read_post.`);
  });
});
