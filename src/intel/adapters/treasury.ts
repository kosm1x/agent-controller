/**
 * US Treasury yields adapter — fiscal data API.
 * No auth required. Polling: daily.
 */

import type { CollectorAdapter, Signal } from "../types.js";

const API_URL =
  "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/avg_interest_rates?sort=-record_date&page[size]=10&fields=record_date,avg_interest_rate_amt,security_desc";
const TIMEOUT_MS = 15_000;

interface TreasuryRecord {
  record_date: string;
  avg_interest_rate_amt: string;
  security_desc: string;
}

interface TreasuryResponse {
  data: TreasuryRecord[];
}

export const treasuryAdapter: CollectorAdapter = {
  source: "treasury",
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

      const data = (await res.json()) as TreasuryResponse;
      const signals: Signal[] = [];

      // Look for Treasury Notes (10-year is the key benchmark)
      const tenYear = data.data.find((r) =>
        r.security_desc.includes("Treasury Notes"),
      );

      if (tenYear) {
        const rate = parseFloat(tenYear.avg_interest_rate_amt);
        if (!isNaN(rate)) {
          signals.push({
            source: "treasury",
            domain: "financial",
            signalType: "numeric",
            key: "10Y",
            valueNumeric: rate,
            sourceTimestamp: `${tenYear.record_date}T00:00:00Z`,
            metadata: { description: tenYear.security_desc },
          });
        }
      }

      return signals;
    } catch {
      return [];
    } finally {
      clearTimeout(timeout);
    }
  },
};
