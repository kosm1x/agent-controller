/**
 * CoinGecko adapter — crypto prices (Bitcoin, Ethereum).
 * No auth required. Polling: 30 minutes.
 */

import type { CollectorAdapter, Signal } from "../types.js";

const API_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true";
const TIMEOUT_MS = 10_000;

interface CoinGeckoResponse {
  [id: string]: {
    usd: number;
    usd_24h_change?: number;
  };
}

export const coingeckoAdapter: CollectorAdapter = {
  source: "coingecko",
  domain: "financial",
  defaultInterval: 30 * 60_000,

  async collect(): Promise<Signal[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(API_URL, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return [];

      const data = (await res.json()) as CoinGeckoResponse;
      const signals: Signal[] = [];

      for (const [id, info] of Object.entries(data)) {
        signals.push({
          source: "coingecko",
          domain: "financial",
          signalType: "numeric",
          key: id,
          valueNumeric: info.usd,
          metadata: { usd_24h_change: info.usd_24h_change },
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
