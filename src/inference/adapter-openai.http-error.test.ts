/**
 * Non-2xx provider responses: the body excerpt in the HttpError message is
 * credential-redacted BEFORE its 200-char cut (the message reaches runs.error /
 * tasks.error via the runner), while status + rate-limit headers stay
 * structural. Never a real endpoint — fetch is stubbed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cfg = vi.hoisted(() => ({
  inferencePrimaryUrl: "http://127.0.0.1:9/v1",
  inferencePrimaryKey: "test",
  inferencePrimaryModel: "test-model",
  inferenceFallbackUrl: "",
  inferenceFallbackKey: "",
  inferenceFallbackModel: "",
  inferenceTimeoutMs: 5000,
  inferenceMaxTokens: 256,
  inferenceMaxRetries: 1,
}));
vi.mock("../config.js", () => ({ getConfig: () => cfg }));

import { inferViaOpenAi } from "./adapter-openai.js";
import { circuitRegistry } from "../lib/circuit-breaker.js";

// Built at runtime — no key-shaped literal in the (public) repo. The body's
// key spans chars 182..220, so it straddles the 200-char excerpt cut.
const straddleBody = () =>
  '{"error":{"message":"' +
  "x".repeat(160) +
  " " +
  "AIza" +
  "b".repeat(35) +
  '"}}';

const request = { messages: [{ role: "user" as const, content: "hi" }] };

beforeEach(() => {
  circuitRegistry.reset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  cfg.inferencePrimaryModel = "test-model";
  cfg.inferenceFallbackUrl = "";
  cfg.inferenceFallbackModel = "";
});

async function failWith(status: number, body: string, headers = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status, headers })),
  );
  const err = await inferViaOpenAi(request).then(
    () => null,
    (e: unknown) => e as Error,
  );
  expect(err).toBeInstanceOf(Error);
  return err!;
}

describe("inferViaOpenAi — HTTP error body excerpt", () => {
  // inferViaOpenAi re-wraps the last HttpError as
  // "All inference providers failed. Last error: <HttpError message>".
  it.each([
    ["OpenAI-compatible", "test-model"],
    ["Anthropic-shaped", "claude-test"],
  ])(
    "%s: redacts BEFORE the 200-char cut — no key fragment survives",
    async (_label, model) => {
      cfg.inferencePrimaryModel = model;
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const err = await failWith(401, straddleBody());
      expect(err.message).toMatch(/Last error: HTTP 401: /);
      expect(err.message).toContain("[REDACTED");
      expect(err.message).not.toMatch(/AIza|bbbbb/);
    },
  );

  it("429 + retry-after: status and rateLimit survive on the HttpError", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = await failWith(429, straddleBody(), { "retry-after": "1" });
    expect(err.message).toMatch(/Last error: HTTP 429: /);
    expect(err.message).not.toMatch(/AIza|bbbbb/);
    // The rate_limit_hit line and the backoff source are built from
    // httpErr.status / httpErr.rateLimit.retryAfterMs (structural fields).
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines).toContainEqual(
      expect.stringMatching(
        /rate_limit_hit provider=primary status=429 retryAfterMs=1000/,
      ),
    );
    expect(lines).toContainEqual(
      expect.stringMatching(/backoff 1000ms before retry \(source=retry-after\)/),
    );
  });
});

describe("inferViaOpenAi — circuit-breaker probe", () => {
  it("a tool-paralysis skip after the HALF_OPEN probe was granted hands the probe back", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    cfg.inferencePrimaryModel = "kimi-test";
    cfg.inferenceFallbackUrl = "http://127.0.0.1:9/v1";
    cfg.inferenceFallbackModel = "test-model";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad", { status: 400 })),
    );
    const primary = circuitRegistry.get("primary", {
      failureThreshold: 1,
      cooldownMs: 0,
    });
    primary.recordFailure();
    const tools = Array.from({ length: 16 }, (_, i) => ({
      type: "function" as const,
      function: { name: `t${i}`, description: "d", parameters: {} },
    }));
    await expect(inferViaOpenAi({ ...request, tools })).rejects.toThrow();
    // Skipped without a call: neither success nor failure was recorded.
    expect(primary.getStatus().state).toBe("OPEN");
    expect(primary.allowRequest()).toBe(true);
  });

  it("every eligible provider's breaker OPEN: the error names the breaker and the first skipped provider, never 'undefined'", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    cfg.inferenceFallbackUrl = "http://127.0.0.1:9/v1";
    cfg.inferenceFallbackModel = "test-model";
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    for (const name of ["primary", "fallback"]) {
      circuitRegistry
        .get(name, { failureThreshold: 1, cooldownMs: 60_000 })
        .recordFailure();
    }
    const err = await inferViaOpenAi(request).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toBe(
      "All inference providers failed. Last error: Circuit breaker OPEN for primary — refusing call until cooldown elapses",
    );
    expect(err!.message).not.toContain("undefined");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a breaker-OPEN skip before a provider that fails keeps the real failure as the last error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    cfg.inferenceFallbackUrl = "http://127.0.0.1:9/v1";
    cfg.inferenceFallbackModel = "test-model";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad", { status: 400 })),
    );
    circuitRegistry
      .get("primary", { failureThreshold: 1, cooldownMs: 60_000 })
      .recordFailure();
    await expect(inferViaOpenAi(request)).rejects.toThrow(
      /^All inference providers failed\. Last error: HTTP 400: bad$/,
    );
  });

  it("a real failure on an earlier provider is kept when a LATER provider's breaker is OPEN", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    cfg.inferenceFallbackUrl = "http://127.0.0.1:9/v1";
    cfg.inferenceFallbackModel = "test-model";
    const fetchMock = vi.fn(async () => new Response("bad", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    circuitRegistry
      .get("fallback", { failureThreshold: 1, cooldownMs: 60_000 })
      .recordFailure();
    await expect(inferViaOpenAi(request)).rejects.toThrow(
      /^All inference providers failed\. Last error: HTTP 400: bad$/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1); // primary only
  });
});

/** A body that delivers each string as its own network chunk. */
function chunkedBody(parts: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(enc.encode(p));
      controller.close();
    },
  });
}

/** One SSE event in the standard OpenAI-compatible framing. */
const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

describe("inferViaOpenAi — streamed response (SSE parser)", () => {
  // Synthetic fixture written to the public OpenAI-compatible streaming
  // format: no recorded provider output.
  const usageChunk = {
    choices: [],
    usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 },
  };
  const secondDelta = sse({
    choices: [{ index: 0, delta: { content: ", mundo" } }],
  });
  const splitAt = secondDelta.indexOf('"content"') + 4; // mid-JSON
  const fixture = [
    sse({ choices: [{ index: 0, delta: { role: "assistant", content: "Hola" } }] }),
    secondDelta.slice(0, splitAt),
    secondDelta.slice(splitAt),
    sse({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_a",
                type: "function",
                function: { name: "web_search", arguments: '{"q":' },
              },
            ],
          },
        },
      ],
    }),
    sse({
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '"clima' } }] },
        },
      ],
    }),
    'data: {"choices":[{"delta":\n\n', // malformed: skipped, stream goes on
    sse({
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: ' hoy"}' } }] },
        },
      ],
    }),
    sse({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 1,
                id: "call_b",
                type: "function",
                function: { name: "file_read", arguments: '{"path":"/tmp/x"}' },
              },
            ],
          },
        },
      ],
    }),
    sse({ choices: [{ index: 0, delta: { content: "!" }, finish_reason: "tool_calls" }] }),
    sse(usageChunk),
    "data: [DONE]\n\n",
  ];

  it("full text, both tool calls with intact arguments, and the usage of the empty-choices final chunk", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(chunkedBody(fixture), { status: 200 })),
    );
    const pieces: string[] = [];
    const result = await inferViaOpenAi(request, {
      onTextChunk: (t: string) => pieces.push(t),
    });
    expect(result.content).toBe("Hola, mundo!");
    expect(pieces).toEqual(["Hola", ", mundo", "!"]);
    expect(result.tool_calls).toEqual([
      {
        id: "call_a",
        type: "function",
        function: { name: "web_search", arguments: '{"q":"clima hoy"}' },
      },
      {
        id: "call_b",
        type: "function",
        function: { name: "file_read", arguments: '{"path":"/tmp/x"}' },
      },
    ]);
    expect(result.usage).toEqual(usageChunk.usage);
  });

  it("a text-chunk callback makes the call a streamed request; pieces arrive in order and the result carries the usage", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(
          chunkedBody([
            sse({ choices: [{ index: 0, delta: { content: "uno " } }] }),
            sse({ choices: [{ index: 0, delta: { content: "dos" } }] }),
            sse({
              choices: [],
              usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
            }),
            "data: [DONE]\n\n",
          ]),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const pieces: string[] = [];
    const result = await inferViaOpenAi(request, {
      onTextChunk: (t: string) => pieces.push(t),
    });
    expect(pieces).toEqual(["uno ", "dos"]);
    expect(result.content).toBe("uno dos");
    expect(result.usage).toEqual({
      prompt_tokens: 5,
      completion_tokens: 2,
      total_tokens: 7,
    });
    expect(result.provider).toBe("primary");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:9/v1/chat/completions");
    expect(Object.keys(init.headers as Record<string, string>).sort()).toEqual([
      "Authorization",
      "Content-Type",
    ]);
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      model: "test-model",
      messages: request.messages,
      max_tokens: 256,
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it("a stream with NO usage chunk returns the zero-usage default", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            chunkedBody([
              sse({ choices: [{ index: 0, delta: { content: "solo texto" } }] }),
              "data: [DONE]\n\n",
            ]),
            { status: 200 },
          ),
      ),
    );
    const result = await inferViaOpenAi(request, { onTextChunk: () => {} });
    expect(result.content).toBe("solo texto");
    expect(result.usage).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
  });

  it("content chunks carrying usage: null do not hide the real usage of the final empty-choices chunk", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            chunkedBody([
              sse({ choices: [{ index: 0, delta: { content: "a" } }], usage: null }),
              sse({ choices: [{ index: 0, delta: { content: "b" } }], usage: null }),
              sse({
                choices: [],
                usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
              }),
              "data: [DONE]\n\n",
            ]),
            { status: 200 },
          ),
      ),
    );
    const result = await inferViaOpenAi(request, { onTextChunk: () => {} });
    expect(result.content).toBe("ab");
    expect(result.usage).toEqual({
      prompt_tokens: 9,
      completion_tokens: 4,
      total_tokens: 13,
    });
  });
});

describe("inferViaOpenAi — Anthropic-format provider (model name claude-*)", () => {
  it("sends a Messages API request and maps the response back to the OpenAI shape", async () => {
    cfg.inferencePrimaryModel = "claude-test";
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(
          JSON.stringify({
            content: [
              { type: "text", text: "hola" },
              { type: "tool_use", id: "tu_1", name: "web_search", input: { q: "x" } },
            ],
            usage: { input_tokens: 11, output_tokens: 3 },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const tool = {
      type: "function" as const,
      function: {
        name: "web_search",
        description: "busca",
        parameters: { type: "object", properties: { q: { type: "string" } } },
      },
    };
    const result = await inferViaOpenAi({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      tools: [tool],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    // The provider base URL is used as configured, then `/v1/messages`.
    expect(url).toBe("http://127.0.0.1:9/v1/v1/messages");
    expect(init.method).toBe("POST");
    expect(Object.keys(init.headers as Record<string, string>).sort()).toEqual([
      "Content-Type",
      "anthropic-version",
      "x-api-key",
    ]);
    expect(JSON.parse(String(init.body))).toEqual({
      model: "claude-test",
      max_tokens: 256,
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      system: "sys",
      tools: [
        {
          name: "web_search",
          description: "busca",
          input_schema: tool.function.parameters,
        },
      ],
      tool_choice: { type: "auto" },
    });

    expect(result).toEqual({
      content: "hola",
      tool_calls: [
        {
          id: "tu_1",
          type: "function",
          function: { name: "web_search", arguments: '{"q":"x"}' },
        },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
      provider: "primary",
      latency_ms: expect.any(Number),
    });
  });
});
