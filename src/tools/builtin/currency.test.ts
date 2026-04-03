import { describe, it, expect, vi, beforeEach , afterEach } from "vitest";
import { currencyConvertTool } from "./currency.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

describe("currency_convert", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  it("has consistent name", () => {
    expect(currencyConvertTool.name).toBe("currency_convert");
    expect(currencyConvertTool.definition.function.name).toBe(
      "currency_convert",
    );
  });

  it("converts USD to MXN by default", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        amount: 1,
        base: "USD",
        date: "2026-03-17",
        rates: { MXN: 17.25, EUR: 0.92 },
      }),
    });

    const result = JSON.parse(await currencyConvertTool.execute({}));
    expect(result.from).toBe("USD");
    expect(result.rates.MXN).toBe(17.25);
    expect(result.source).toBe("ECB/Frankfurter");
  });

  it("supports historical date", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        amount: 100,
        base: "EUR",
        date: "2025-01-15",
        rates: { USD: 103.5 },
      }),
    });

    const result = JSON.parse(
      await currencyConvertTool.execute({
        amount: 100,
        from: "EUR",
        to: "USD",
        date: "2025-01-15",
      }),
    );
    expect(result.date).toBe("2025-01-15");
    expect(result.amount).toBe(100);

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/2025-01-15?");
  });

  it("handles API error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 422 });
    const result = JSON.parse(await currencyConvertTool.execute({}));
    expect(result.error).toContain("422");
  });
});
