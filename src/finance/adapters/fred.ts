/**
 * FRED adapter — Federal Reserve Economic Data.
 *
 * Wraps fred.stlouisfed.org REST API. Used for the 3 macro series that
 * Alpha Vantage doesn't expose: VIXCLS, ICSA, M2SL. Free tier: 120 req/min.
 *
 * Endpoint shape: https://api.stlouisfed.org/fred/series/observations
 *   ?series_id=VIXCLS&api_key=<key>&file_type=json
 */

import { getConfig } from "../../config.js";
import {
  RateLimitedError,
  redactApiKeys,
  type MacroAdapter,
  type MacroPoint,
} from "../types.js";
import { fromFredDate } from "../timezone.js";
import { canCall, recordCall } from "../rate-limit.js";
import { recordBudget } from "../budget.js";

const BASE_URL = "https://api.stlouisfed.org/fred/series/observations";

interface FredObservation {
  date: string; // YYYY-MM-DD
  value: string; // stringified number, "." for missing
}

interface FredResponse {
  observations: FredObservation[];
  error_code?: number;
  error_message?: string;
}

export class FredAdapter implements MacroAdapter {
  readonly provider = "fred" as const;

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!apiKey) {
      throw new Error(
        "FRED_API_KEY is required for the FRED adapter (get one at https://fred.stlouisfed.org/docs/api/api_key.html)",
      );
    }
  }

  static fromConfig(fetchImpl: typeof fetch = fetch): FredAdapter {
    const key = getConfig().fredApiKey;
    if (!key) {
      throw new Error(
        "FRED_API_KEY is not set in the environment. Finance macro tools require this credential.",
      );
    }
    return new FredAdapter(key, fetchImpl);
  }

  async fetchMacro(series: string): Promise<MacroPoint[]> {
    if (!canCall("fred")) {
      throw new RateLimitedError("fred");
    }
    const start = Date.now();
    recordCall("fred");

    const url = new URL(BASE_URL);
    url.searchParams.set("series_id", series);
    url.searchParams.set("api_key", this.apiKey);
    url.searchParams.set("file_type", "json");

    let res: Response;
    try {
      res = await this.fetchImpl(url.toString());
    } catch (err) {
      recordBudget({
        provider: "fred",
        endpoint: `series/${series}`,
        status: "error",
        responseTimeMs: Date.now() - start,
      });
      throw new Error(
        redactApiKeys(err instanceof Error ? err.message : String(err)),
      );
    }

    const responseTimeMs = Date.now() - start;

    if (res.status === 429) {
      recordBudget({
        provider: "fred",
        endpoint: `series/${series}`,
        status: "rate_limited",
        responseTimeMs,
      });
      throw new RateLimitedError("fred");
    }

    if (!res.ok) {
      recordBudget({
        provider: "fred",
        endpoint: `series/${series}`,
        status: "error",
        responseTimeMs,
      });
      throw new Error(redactApiKeys(`FRED ${res.status}: ${await res.text()}`));
    }

    // W4: guard JSON parse so parse errors still record budget
    let body: FredResponse;
    try {
      body = (await res.json()) as FredResponse;
    } catch (err) {
      recordBudget({
        provider: "fred",
        endpoint: `series/${series}`,
        status: "error",
        responseTimeMs,
      });
      throw new Error(
        `FRED: unparseable JSON (${err instanceof Error ? err.message : "unknown"})`,
      );
    }
    if (body.error_code) {
      recordBudget({
        provider: "fred",
        endpoint: `series/${series}`,
        status: "error",
        responseTimeMs,
      });
      throw new Error(`FRED error ${body.error_code}: ${body.error_message}`);
    }

    recordBudget({
      provider: "fred",
      endpoint: `series/${series}`,
      status: "success",
      responseTimeMs,
    });

    return body.observations
      .filter((o) => o.value !== "." && !Number.isNaN(parseFloat(o.value)))
      .map((o) => ({
        series,
        date: fromFredDate(o.date),
        value: parseFloat(o.value),
        provider: "fred" as const,
      }));
  }
}
