import { describe, it, expect, vi, beforeEach , afterEach } from "vitest";
import { chartGenerateTool } from "./chart.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

describe("chart_generate", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  it("has consistent name", () => {
    expect(chartGenerateTool.name).toBe("chart_generate");
    expect(chartGenerateTool.definition.function.name).toBe("chart_generate");
  });

  it("generates chart URL", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const result = JSON.parse(
      await chartGenerateTool.execute({
        type: "bar",
        title: "Sales Q1",
        labels: ["Jan", "Feb", "Mar"],
        datasets: [{ label: "Revenue", data: [100, 150, 200] }],
      }),
    );

    expect(result.chart_url).toContain("quickchart.io");
    expect(result.type).toBe("bar");
    expect(result.width).toBe(500);
    expect(result.height).toBe(300);
  });

  it("rejects empty labels", async () => {
    const result = JSON.parse(
      await chartGenerateTool.execute({
        type: "bar",
        labels: [],
        datasets: [],
      }),
    );
    expect(result.error).toContain("labels");
  });

  it("handles API error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const result = JSON.parse(
      await chartGenerateTool.execute({
        type: "pie",
        labels: ["A"],
        datasets: [{ data: [1] }],
      }),
    );
    expect(result.error).toContain("500");
  });
});
