/**
 * Frankfurter adapter — ECB exchange rates.
 * No auth required. Polling: daily.
 */

import type { CollectorAdapter, Signal } from "../types.js";

const API_URL =
  "https://api.frankfurter.dev/v1/latest?base=USD&symbols=MXN,EUR,GBP,JPY,CAD,BRL";
const TIMEOUT_MS = 10_000;

interface FrankfurterResponse {
  base: string;
  date: string;
  rates: Record<string, number>;
}

export const frankfurterAdapter: CollectorAdapter = {
  source: "frankfurter",
  domain: "financial",
  defaultInterval: 24 * 60 * 60_000,

  async collect(): Promise<Signal[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(API_URL, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return [];

      const data = (await res.json()) as FrankfurterResponse;
      const signals: Signal[] = [];

      for (const [currency, rate] of Object.entries(data.rates)) {
        signals.push({
          source: "frankfurter",
          domain: "financial",
          signalType: "numeric",
          key: currency,
          valueNumeric: rate,
          sourceTimestamp: data.date ? `${data.date}T00:00:00Z` : undefined,
          metadata: { base: data.base },
        });
      }

      return signals;
    } catch {
      return [];
    } finally {
      clearTimeout(timeout);
    }
  },
};
