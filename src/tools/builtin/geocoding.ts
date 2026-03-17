/**
 * Geocoding tool — Nominatim / OpenStreetMap (free, no auth).
 *
 * Forward geocoding: address/place name → coordinates.
 * Required User-Agent header per Nominatim ToS.
 */

import type { Tool } from "../types.js";

const API_URL = "https://nominatim.openstreetmap.org/search";
const TIMEOUT_MS = 10_000;
const USER_AGENT = "AgentController/1.0";

export const geocodeAddressTool: Tool = {
  name: "geocode_address",
  definition: {
    type: "function",
    function: {
      name: "geocode_address",
      description: `Look up geographic coordinates and address details for a location.

USE WHEN:
- Need latitude/longitude for a place name or address
- User asks "where is X" and you need coordinates
- Before calling weather_forecast when you only have a city name
- Verifying or standardizing an address

DO NOT USE WHEN:
- You already have coordinates
- Looking for business reviews or details (use web_search)
- Need driving directions or routes (use web_search)

Uses OpenStreetMap Nominatim. Returns up to 5 matches with coordinates, display name, and type.`,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Address or place name to geocode (e.g., 'Mexico City', '1600 Pennsylvania Ave, Washington DC')",
          },
          limit: {
            type: "number",
            description: "Max results (1-5, default: 3)",
          },
        },
        required: ["query"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const query = args.query as string;
    if (!query) {
      return JSON.stringify({ error: "query is required" });
    }

    const limit = Math.min(Math.max((args.limit as number) ?? 3, 1), 5);
    const params = new URLSearchParams({
      q: query,
      format: "json",
      limit: String(limit),
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(`${API_URL}?${params}`, {
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        return JSON.stringify({
          error: `Nominatim API error: ${response.status}`,
        });
      }

      const data = (await response.json()) as NominatimResult[];

      const results = data.map((r) => ({
        latitude: parseFloat(r.lat),
        longitude: parseFloat(r.lon),
        display_name: r.display_name,
        type: r.type,
        importance: r.importance,
      }));

      return JSON.stringify({
        query,
        results,
        total: results.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: `Geocoding failed: ${message}` });
    } finally {
      clearTimeout(timeout);
    }
  },
};

interface NominatimResult {
  lat: string;
  lon: string;
  display_name: string;
  type: string;
  importance: number;
}
