import { describe, it, expect, vi, beforeEach , afterEach } from "vitest";
import { geocodeAddressTool } from "./geocoding.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

describe("geocode_address", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  it("has consistent name", () => {
    expect(geocodeAddressTool.name).toBe("geocode_address");
    expect(geocodeAddressTool.definition.function.name).toBe("geocode_address");
  });

  it("requires query parameter", async () => {
    const result = JSON.parse(await geocodeAddressTool.execute({}));
    expect(result.error).toContain("query is required");
  });

  it("returns geocoding results", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          lat: "19.4326077",
          lon: "-99.133208",
          display_name: "Mexico City, Cuauhtémoc, Mexico City, Mexico",
          type: "city",
          importance: 0.8,
        },
      ],
    });

    const result = JSON.parse(
      await geocodeAddressTool.execute({ query: "Mexico City" }),
    );
    expect(result.results).toHaveLength(1);
    expect(result.results[0].latitude).toBeCloseTo(19.43, 1);
    expect(result.results[0].display_name).toContain("Mexico City");
  });

  it("sends User-Agent header", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    await geocodeAddressTool.execute({ query: "test" });
    const headers = mockFetch.mock.calls[0][1]?.headers as Record<
      string,
      string
    >;
    expect(headers["User-Agent"]).toBe("AgentController/1.0");
  });

  it("handles API error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });
    const result = JSON.parse(
      await geocodeAddressTool.execute({ query: "test" }),
    );
    expect(result.error).toContain("403");
  });
});
