/**
 * Currency conversion tool — Frankfurter API (free, no auth).
 *
 * European Central Bank reference rates. 150+ currencies.
 * Supports latest and historical rates.
 */

import type { Tool } from "../types.js";

const API_URL = "https://api.frankfurter.app";
const TIMEOUT_MS = 10_000;

export const currencyConvertTool: Tool = {
  name: "currency_convert",
  definition: {
    type: "function",
    function: {
      name: "currency_convert",
      description: `Convert currencies using European Central Bank reference rates.

USE WHEN:
- User asks to convert money between currencies
- Need current or historical exchange rates
- Comparing prices across different currencies
- Working with international budgets or invoices

DO NOT USE WHEN:
- Need cryptocurrency rates (ECB doesn't track crypto — use web_search)
- Need intraday trading rates (ECB publishes daily reference rates)

Supports all major currencies (USD, EUR, MXN, GBP, JPY, BRL, etc.).
Default: 1 USD to MXN.`,
      parameters: {
        type: "object",
        properties: {
          amount: {
            type: "number",
            description: "Amount to convert (default: 1)",
          },
          from: {
            type: "string",
            description: "Source currency ISO code (default: USD)",
          },
          to: {
            type: "string",
            description:
              "Target currency codes, comma-separated (default: MXN,EUR)",
          },
          date: {
            type: "string",
            description:
              "Historical date YYYY-MM-DD (optional, default: latest rates)",
          },
        },
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const amount = (args.amount as number) ?? 1;
    const from = ((args.from as string) ?? "USD").toUpperCase();
    const to = ((args.to as string) ?? "MXN,EUR").toUpperCase();
    const date = (args.date as string) ?? null;

    const path = date ?? "latest";
    const params = new URLSearchParams({
      from,
      to,
      amount: String(amount),
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(`${API_URL}/${path}?${params}`, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });

      if (!response.ok) {
        return JSON.stringify({
          error: `Frankfurter API error: ${response.status}`,
        });
      }

      const data = (await response.json()) as FrankfurterResponse;

      return JSON.stringify({
        amount: data.amount ?? amount,
        from: data.base ?? from,
        rates: data.rates ?? {},
        date: data.date ?? date ?? "latest",
        source: "ECB/Frankfurter",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({
        error: `Currency conversion failed: ${message}`,
      });
    } finally {
      clearTimeout(timeout);
    }
  },
};

interface FrankfurterResponse {
  amount?: number;
  base?: string;
  date?: string;
  rates?: Record<string, number>;
}
