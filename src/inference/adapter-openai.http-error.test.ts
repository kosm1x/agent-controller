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
});
