/**
 * FRED adapter tests — mock fetch + DB, verify request/response shape.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const mockDb = {
  prepare: vi.fn(() => ({
    run: vi.fn(),
    all: vi.fn(() => []),
  })),
};

vi.mock("../../db/index.js", () => ({
  getDatabase: () => mockDb,
}));

vi.mock("../../config.js", () => ({
  getConfig: () => ({ fredApiKey: "test-fred-key" }),
}));

import { FredAdapter } from "./fred.js";
import { RateLimitedError } from "../types.js";
import { __resetForTests } from "../rate-limit.js";

const vixclsFixture = JSON.parse(
  readFileSync(resolve(__dirname, "../__fixtures__/fred-vixcls.json"), "utf8"),
);

describe("FredAdapter", () => {
  beforeEach(() => {
    __resetForTests();
    mockDb.prepare.mockClear();
  });

  it("fetches VIXCLS series and parses observations", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(vixclsFixture), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const adapter = new FredAdapter("test-key", fakeFetch);
    const result = await adapter.fetchMacro("VIXCLS");

    // 4 observations in fixture, 1 missing ("."); expect 3 back
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({
      series: "VIXCLS",
      date: "2026-04-14",
      value: 15.82,
      provider: "fred",
    });
    expect(result[2].value).toBe(17.05);
  });

  it("throws informative error on missing API key", () => {
    expect(() => new FredAdapter("")).toThrow(/FRED_API_KEY is required/);
  });

  it("throws RateLimitedError on 429", async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValue(
        new Response("rate limited", { status: 429 }),
      ) as unknown as typeof fetch;

    const adapter = new FredAdapter("test-key", fakeFetch);
    await expect(adapter.fetchMacro("VIXCLS")).rejects.toBeInstanceOf(
      RateLimitedError,
    );
  });

  it("surfaces FRED API error_code in message", async () => {
    const errBody = {
      error_code: 400,
      error_message: "Bad series ID",
      observations: [],
    };
    const fakeFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(errBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const adapter = new FredAdapter("test-key", fakeFetch);
    await expect(adapter.fetchMacro("BOGUS")).rejects.toThrow(
      /FRED error 400: Bad series ID/,
    );
  });
});
