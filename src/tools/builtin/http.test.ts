/**
 * http_fetch tests — SSRF redirect-follow guard (H3).
 *
 * The tool validates the initial URL, but undici would follow a 3xx Location
 * UNCHECKED. These tests mock global fetch and assert every redirect hop is
 * re-validated against the outbound SSRF guard before it is followed.
 *
 * Start URLs use PUBLIC IP literals so validateOutboundUrlResolved takes the
 * sync path (no DNS lookup) — deterministic and offline-safe.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { httpTool } from "./http.js";

// Ruling 3c fold F2: one synthetic stored value stands in for the store.
const SCRUB_SYN = vi.hoisted(() => "cut-" + "h".repeat(20));
vi.mock("../../lib/secret-refs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/secret-refs.js")>()),
  scrubSecrets: (t: string) => t.replaceAll(SCRUB_SYN, "[oculto]"),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("http_fetch — redirect SSRF guard", () => {
  it("rejects a redirect whose Location resolves to a private IP", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1:8100/admin" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await httpTool.execute({ url: "http://93.184.216.34/" });
    const parsed = JSON.parse(out) as { error?: string; url?: string };

    expect(parsed.error).toMatch(/redirect/i);
    expect(parsed.url).toContain("127.0.0.1");
    // The 302 was inspected but NEVER followed to the internal target.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows a safe redirect and returns the final body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "http://93.184.216.35/next" },
        }),
      )
      .mockResolvedValueOnce(new Response("final body", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await httpTool.execute({ url: "http://93.184.216.34/" });
    const parsed = JSON.parse(out) as {
      status?: number;
      body?: string;
      finalUrl?: string;
    };

    expect(parsed.status).toBe(200);
    expect(parsed.body).toBe("final body");
    expect(parsed.finalUrl).toBe("http://93.184.216.35/next");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns a plain 200 body when there is no redirect", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await httpTool.execute({ url: "http://93.184.216.34/" });
    const parsed = JSON.parse(out) as { status?: number; body?: string };

    expect(parsed.status).toBe(200);
    expect(parsed.body).toBe("ok");
  });

  it("caps the redirect chain", async () => {
    // Always redirect to another safe public IP literal — the loop must give
    // up after MAX_REDIRECTS rather than spin forever.
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://93.184.216.35/loop" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await httpTool.execute({ url: "http://93.184.216.34/" });
    const parsed = JSON.parse(out) as { error?: string };

    expect(parsed.error).toMatch(/too many redirects/i);
  });

  it("still rejects the initial URL when it is private (unchanged)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const out = await httpTool.execute({ url: "http://127.0.0.1:8080/" });
    const parsed = JSON.parse(out) as { error?: string };

    expect(parsed.error).toBeTruthy();
    // Blocked before any network call.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("http_fetch — stored secrets (ruling 3c)", () => {
  it("a stored value straddling the 20,000-char body cap is scrubbed before the cut", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("x".repeat(19_995) + SCRUB_SYN, { status: 200 }),
      ),
    );
    const out = await httpTool.execute({ url: "http://93.184.216.34/" });
    const { body } = JSON.parse(out) as { body: string };
    expect(body.slice(19_995)).toMatch(/^\[ocul\n\.\.\. \(truncated/);
    expect(body).not.toContain(SCRUB_SYN.slice(0, 5));
  });
});

// Description pins: the tool's whole description text as registered.
describe("tool description texts", () => {
  it("http_fetch: the whole description", () => {
    expect(httpTool.definition.function.description).toBe(`Make an HTTP request to a public URL and return the response (status + headers + truncated body).

Any other tool named in this description or its parameters is usable only when it is among your tools.

DO NOT USE WHEN:
- You want the readable text of a web page → use web_read (clean Markdown, no headers noise).
- A dedicated tool covers the service (gmail_*, gdocs_*, crm_query, wp_*) → use it (it handles auth).

WHEN TO USE:
- Calling a JSON API without a dedicated tool (small internal service, webhook test, an ad-hoc REST endpoint)
- POSTing to a form or webhook the user supplies
- Fetching a raw file that is NOT an HTML page (PDF → pdf_read, HTML → web_read instead)

WHEN NOT TO USE:
- Search → use web_search / exa_search
- Google Workspace APIs → use the gdocs/gsheets/gdrive/gmail/calendar tools (they handle OAuth)
- Creating a GitHub repository or pull request → use gh_repo_create or gh_create_pr
- WordPress → use wp_* tools (auth, media handling)

STORED CREDENTIALS:
- Write {{SECRET_<NAME>}} in the url, a header or the body (e.g. "Authorization": "Bearer {{SECRET_<NAME>}}"); the saved value is substituted at execution and never shown to you. Never type the value or a hidden-value placeholder.

BOUNDARIES:
- Body is truncated to 20,000 chars.
- Timeout is 15s. Slow endpoints will fail — don't retry in a loop.
- SSRF-protected: private IPs (10.x, 192.168.x, 169.254.x), localhost, metadata endpoints all rejected.
- Supports GET, POST, PUT, DELETE, PATCH.`);
  });
});
