import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJson, HttpStatusError } from "./fetch-json.js";

describe("fetchJson", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns parsed JSON on 2xx", async () => {
    const mock = vi
      .fn()
      .mockResolvedValue(new Response('{"a":1}', { status: 200 }));
    vi.stubGlobal("fetch", mock);

    const data = await fetchJson("https://example.com/api");
    expect(data).toEqual({ a: 1 });
  });

  it("sends Accept: application/json by default and merges custom headers", async () => {
    const mock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", mock);

    await fetchJson("https://example.com/api", {
      headers: { "X-Api-Key": "k" },
    });

    const init = mock.mock.calls[0][1] as RequestInit;
    expect(init.headers).toEqual({
      Accept: "application/json",
      "X-Api-Key": "k",
    });
  });

  it("passes method and body through", async () => {
    const mock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", mock);

    await fetchJson("https://example.com/api", {
      method: "POST",
      body: '{"q":"x"}',
    });

    const init = mock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"q":"x"}');
  });

  it("throws HttpStatusError with status + bodyText on non-2xx", async () => {
    const mock = vi
      .fn()
      .mockResolvedValue(new Response("rate limited", { status: 429 }));
    vi.stubGlobal("fetch", mock);

    const err = await fetchJson("https://example.com/api", {
      label: "Exa API",
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpStatusError);
    const httpErr = err as HttpStatusError;
    expect(httpErr.status).toBe(429);
    expect(httpErr.bodyText).toBe("rate limited");
    expect(httpErr.message).toBe("Exa API error: 429 rate limited");
  });

  it("throws HttpStatusError with empty bodyText when the error body is unreadable", async () => {
    const response = new Response(null, { status: 500 });
    vi.spyOn(response, "text").mockRejectedValue(new Error("stream broke"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const err = await fetchJson("https://example.com/api").catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(HttpStatusError);
    expect((err as HttpStatusError).bodyText).toBe("");
    expect((err as HttpStatusError).message).toBe("HTTP error: 500");
  });

  it("aborts with a TimeoutError when timeoutMs elapses", async () => {
    const mock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    );
    vi.stubGlobal("fetch", mock);

    const err = await fetchJson("https://example.com/slow", {
      timeoutMs: 10,
    }).catch((e: unknown) => e);

    expect((err as DOMException).name).toBe("TimeoutError");
  });

  it("propagates the JSON parse error when the 2xx body is not JSON", async () => {
    const mock = vi
      .fn()
      .mockResolvedValue(new Response("<html>oops</html>", { status: 200 }));
    vi.stubGlobal("fetch", mock);

    await expect(fetchJson("https://example.com/api")).rejects.toThrow(
      SyntaxError,
    );
  });
});
