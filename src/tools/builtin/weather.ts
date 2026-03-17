/**
 * Weather forecast tool — Open-Meteo API (free, no auth).
 *
 * Current conditions + multi-day forecast for any location.
 * Default: Mexico City. Use geocode_address first if you only have a city name.
 */

import type { Tool } from "../types.js";

const API_URL = "https://api.open-meteo.com/v1/forecast";
const TIMEOUT_MS = 10_000;
const DEFAULT_LAT = 19.4326;
const DEFAULT_LON = -99.1332;

export const weatherForecastTool: Tool = {
  name: "weather_forecast",
  definition: {
    type: "function",
    function: {
      name: "weather_forecast",
      description: `Get current weather and multi-day forecast for a location.

USE WHEN:
- User asks about weather, temperature, or precipitation anywhere in the world
- Planning outdoor activities, travel, or events
- Need climate context for a location

DO NOT USE WHEN:
- Need historical weather data beyond 7 days (use web_search)
- Need hyper-local radar or satellite imagery (use web_search)

Accepts latitude/longitude. Default: Mexico City (19.43, -99.13).
If you only have a city name, call geocode_address first to get coordinates.
Returns current conditions + daily forecast (temperature, precipitation, wind).`,
      parameters: {
        type: "object",
        properties: {
          latitude: {
            type: "number",
            description: "Latitude (-90 to 90). Default: 19.4326 (Mexico City)",
          },
          longitude: {
            type: "number",
            description:
              "Longitude (-180 to 180). Default: -99.1332 (Mexico City)",
          },
          days: {
            type: "number",
            description: "Forecast days (1-7, default: 3)",
          },
        },
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const lat = (args.latitude as number) ?? DEFAULT_LAT;
    const lon = (args.longitude as number) ?? DEFAULT_LON;
    const days = Math.min(Math.max((args.days as number) ?? 3, 1), 7);

    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      current_weather: "true",
      daily:
        "temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode",
      timezone: "auto",
      forecast_days: String(days),
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(`${API_URL}?${params}`, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });

      if (!response.ok) {
        return JSON.stringify({
          error: `Open-Meteo API error: ${response.status}`,
        });
      }

      const data = (await response.json()) as OpenMeteoResponse;

      const forecast = (data.daily?.time ?? []).map((date, i) => ({
        date,
        temp_max: data.daily?.temperature_2m_max?.[i] ?? null,
        temp_min: data.daily?.temperature_2m_min?.[i] ?? null,
        precipitation_mm: data.daily?.precipitation_sum?.[i] ?? null,
        weather_code: data.daily?.weathercode?.[i] ?? null,
      }));

      return JSON.stringify({
        location: { latitude: lat, longitude: lon, timezone: data.timezone },
        current: data.current_weather
          ? {
              temperature: data.current_weather.temperature,
              wind_kmh: data.current_weather.windspeed,
              wind_direction: data.current_weather.winddirection,
              weather_code: data.current_weather.weathercode,
            }
          : null,
        forecast,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: `Weather fetch failed: ${message}` });
    } finally {
      clearTimeout(timeout);
    }
  },
};

interface OpenMeteoResponse {
  timezone?: string;
  current_weather?: {
    temperature: number;
    windspeed: number;
    winddirection: number;
    weathercode: number;
  };
  daily?: {
    time?: string[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_sum?: number[];
    weathercode?: number[];
  };
}
