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
