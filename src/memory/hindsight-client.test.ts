/**
 * Hindsight client tests — mock global fetch to verify REST calls.
 * Aligned with Hindsight API v2 (2026-03).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { HindsightClient } from "./hindsight-client.js";

const BASE_URL = "http://localhost:8888";

let client: HindsightClient;

beforeEach(() => {
  vi.restoreAllMocks();
  client = new HindsightClient(BASE_URL, "test-key");
});

function mockFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    }),
  );
}

describe("HindsightClient", () => {
  describe("health", () => {
    it("should return health status", async () => {
      mockFetch(200, { status: "healthy" });
      const result = await client.health();
      expect(result.status).toBe("healthy");

      const call = vi.mocked(fetch).mock.calls[0];
      expect(call[0]).toBe(`${BASE_URL}/health`);
      expect(call[1]?.method).toBe("GET");
    });
  });

  describe("retain", () => {
    it("should POST items array to bank memories endpoint", async () => {
      mockFetch(200, {});
      await client.retain("test-bank", {
        content: "learned something",
        tags: ["test"],
        async: true,
      });

      const call = vi.mocked(fetch).mock.calls[0];
      expect(call[0]).toBe(`${BASE_URL}/v1/default/banks/test-bank/memories`);
      expect(call[1]?.method).toBe("POST");
      const body = JSON.parse(call[1]?.body as string);
      expect(body.items).toHaveLength(1);
      expect(body.items[0].content).toBe("learned something");
      expect(body.items[0].tags).toEqual(["test"]);
      expect(body.async).toBe(true);
    });

    it("should default async to true", async () => {
      mockFetch(200, {});
      await client.retain("test-bank", { content: "test" });

      const body = JSON.parse(
        vi.mocked(fetch).mock.calls[0][1]?.body as string,
      );
      expect(body.async).toBe(true);
    });
  });

  describe("recall", () => {
    it("should POST query and return results", async () => {
      mockFetch(200, {
        results: [
          { id: "m1", text: "memory 1", type: "world" },
          { id: "m2", text: "memory 2", type: "experience" },
        ],
      });

      const result = await client.recall("test-bank", {
        query: "what happened",
        budget: "low",
      });

      expect(result.results).toHaveLength(2);
      expect(result.results[0].text).toBe("memory 1");

      const call = vi.mocked(fetch).mock.calls[0];
      expect(call[0]).toBe(
        `${BASE_URL}/v1/default/banks/test-bank/memories/recall`,
      );
      const body = JSON.parse(call[1]?.body as string);
      expect(body.query).toBe("what happened");
      expect(body.budget).toBe("low");
    });
  });

  describe("reflect", () => {
    it("should POST query and return text", async () => {
      mockFetch(200, { text: "synthesized insight" });
      const result = await client.reflect("test-bank", {
        query: "patterns in deployments",
        budget: "mid",
      });
      expect(result.text).toBe("synthesized insight");
    });
  });

  describe("upsertBank", () => {
    it("should PUT bank config", async () => {
      mockFetch(200, {});
      await client.upsertBank("my-bank", {
        reflect_mission: "track stuff",
        retain_mission: "be helpful",
      });

      const call = vi.mocked(fetch).mock.calls[0];
      expect(call[0]).toBe(`${BASE_URL}/v1/default/banks/my-bank`);
      expect(call[1]?.method).toBe("PUT");
    });
  });

  describe("error handling", () => {
    it("should throw on non-OK response", async () => {
      mockFetch(500, "Internal Server Error");
      await expect(client.health()).rejects.toThrow("Hindsight GET");
    });

    it("should include auth header when API key provided", async () => {
      mockFetch(200, { status: "healthy" });
      await client.health();

      const call = vi.mocked(fetch).mock.calls[0];
      const headers = call[1]?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer test-key");
    });

    it("should not include auth header without API key", async () => {
      const noAuthClient = new HindsightClient(BASE_URL);
      mockFetch(200, { status: "healthy" });
      await noAuthClient.health();

      const call = vi.mocked(fetch).mock.calls[0];
      const headers = call[1]?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBeUndefined();
    });
  });
});
