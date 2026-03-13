/**
 * Hindsight client tests — mock global fetch to verify REST calls.
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
      mockFetch(200, { status: "ok" });
      const result = await client.health();
      expect(result.status).toBe("ok");

      const call = vi.mocked(fetch).mock.calls[0];
      expect(call[0]).toBe(`${BASE_URL}/v1/default/health`);
      expect(call[1]?.method).toBe("GET");
    });
  });

  describe("retain", () => {
    it("should POST observation to bank", async () => {
      mockFetch(200, {});
      await client.retain("test-bank", {
        observation: "learned something",
        tags: ["test"],
        async: true,
      });

      const call = vi.mocked(fetch).mock.calls[0];
      expect(call[0]).toBe(
        `${BASE_URL}/v1/default/banks/test-bank/memories/retain`,
      );
      expect(call[1]?.method).toBe("POST");
      const body = JSON.parse(call[1]?.body as string);
      expect(body.observation).toBe("learned something");
      expect(body.tags).toEqual(["test"]);
      expect(body.async).toBe(true);
    });
  });

  describe("recall", () => {
    it("should POST query and return memories", async () => {
      mockFetch(200, {
        memories: [
          { content: "memory 1", relevance: 0.95 },
          { content: "memory 2", relevance: 0.8 },
        ],
      });

      const result = await client.recall("test-bank", {
        query: "what happened",
        budget: "low",
        max_results: 5,
      });

      expect(result.memories).toHaveLength(2);
      expect(result.memories[0].content).toBe("memory 1");
      expect(result.memories[0].relevance).toBe(0.95);

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
    it("should POST query and return reflection", async () => {
      mockFetch(200, { reflection: "synthesized insight" });
      const result = await client.reflect("test-bank", {
        query: "patterns in deployments",
        budget: "mid",
      });
      expect(result.reflection).toBe("synthesized insight");
    });
  });

  describe("upsertBank", () => {
    it("should PUT bank config", async () => {
      mockFetch(200, {});
      await client.upsertBank("my-bank", {
        mission: "track stuff",
        disposition: "be helpful",
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
      mockFetch(200, { status: "ok" });
      await client.health();

      const call = vi.mocked(fetch).mock.calls[0];
      const headers = call[1]?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer test-key");
    });

    it("should not include auth header without API key", async () => {
      const noAuthClient = new HindsightClient(BASE_URL);
      mockFetch(200, { status: "ok" });
      await noAuthClient.health();

      const call = vi.mocked(fetch).mock.calls[0];
      const headers = call[1]?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBeUndefined();
    });
  });
});
