import { describe, it, expect, vi, beforeEach , afterEach } from "vitest";
import { weatherForecastTool } from "./weather.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

describe("weather_forecast", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  it("has consistent name", () => {
    expect(weatherForecastTool.name).toBe("weather_forecast");
    expect(weatherForecastTool.definition.function.name).toBe(
      "weather_forecast",
    );
  });

  it("returns weather for default coords", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        timezone: "America/Mexico_City",
        current_weather: {
          temperature: 22,
          windspeed: 10,
          winddirection: 180,
          weathercode: 1,
        },
        daily: {
          time: ["2026-03-17", "2026-03-18"],
          temperature_2m_max: [25, 26],
          temperature_2m_min: [12, 13],
          precipitation_sum: [0, 2],
          weathercode: [1, 3],
        },
      }),
    });

    const result = JSON.parse(await weatherForecastTool.execute({}));
    expect(result.location.latitude).toBe(19.4326);
    expect(result.current.temperature).toBe(22);
    expect(result.forecast).toHaveLength(2);
  });

  it("handles HTTP error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const result = JSON.parse(await weatherForecastTool.execute({}));
    expect(result.error).toContain("500");
  });

  it("handles timeout", async () => {
    mockFetch.mockRejectedValueOnce(new Error("aborted"));
    const result = JSON.parse(await weatherForecastTool.execute({}));
    expect(result.error).toContain("aborted");
  });
});
