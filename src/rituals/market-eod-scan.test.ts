import { describe, it, expect, vi } from "vitest";
import { createMarketEodScan } from "./market-eod-scan.js";
import type { MarketBar } from "../finance/types.js";

// 2026-11-21: 21 of 22 runs ended with concerns, for two reasons present in
// every run. Step 5 asked market_history for today's close at 16:30 ET, but
// the daily bar for day D only arrives on D+1. The Paper line asked for a
// daily equity %, but paper_portfolio marks at the latest weekly close and
// returns no previous-day equity. These tests pin the fix: today's close and
// its change come from market_quote with its trading day checked, history is
// only the fallback for a quote without a change, the signals are dated by
// their newest bars, every missing or old close stays a reported concern, and
// the Paper line asks for no daily %. The tool replies the steps describe are
// built through the tools' own code, not copied.

const mockLayer = {
  getQuote: vi.fn(),
  getDaily: vi.fn(),
  listWatchlist: vi.fn(),
};
vi.mock("../finance/data-layer.js", () => ({
  getDataLayer: () => mockLayer,
}));

vi.mock("../finance/signals.js", async () => {
  const actual = await vi.importActual<typeof import("../finance/signals.js")>(
    "../finance/signals.js",
  );
  return { ...actual, persistSignals: () => 0 };
});

const DATE = "2026-11-20";
const tpl = (): ReturnType<typeof createMarketEodScan> =>
  createMarketEodScan(DATE);

function step(n: number): string {
  const m = new RegExp(`^${n}\\. ([^\\n]*)`, "m").exec(tpl().description);
  expect(m, `step ${n}`).not.toBeNull();
  return m![1]!;
}

const STEP5_SENTENCES = [
  "Call market_quote with symbol=SPY to get today's close as market context.",
  // market_signals can fall back to Alpha Vantage and fill the limiter's
  // per-minute window; a quote made after that is refused before any network
  // call, so the quote runs alone, before the tools that fan out.
  "Make this call on its own and wait for its reply before you call market_history or market_signals: market_signals can fall back to the same Alpha Vantage source and fill its per-minute limit, and a quote made after that is refused.",
  `The quote's trading day is the date inside its "(OHLC <YYYY-MM-DD>: …)" part; check that it is ${DATE}.`,
  'When the line carries a "change" part, that is the day\'s %Δ against the "prev close" the line gives: use it as is, compute nothing, and do not call market_history.',
  `Only when the line has no "change" part, call market_history for SPY with lookback=5 and compute %Δ = the market_quote close against the close of the row dated prev_trading from the step 1 market_calendar reply; at this hour the history normally has no ${DATE} row yet, which is not a gap.`,
  'If the prev_trading row is missing, if the market_history reply is marked "STALE (providers unreachable)", or if market_history fails, write the date of the prior close you used (or that you have none) in the Mercado line and report the old or missing prior close as a concern.',
  'If market_quote fails (an {"error": …} reply), call market_history for SPY with lookback=5 and write its latest close, with its date, in the Mercado line.',
  `If the quote's date is not ${DATE}, write that quote's close with its date in the Mercado line; its "change" belongs to that date, not to ${DATE}.`,
  `In both cases today's close is missing: report the missing close for ${DATE} as a concern.`,
];

const STEP6_SENTENCES = [
  "Call market_signals with lookback=3 to surface any technical firings triggered today.",
  `Each firing line starts with the date of the bar it fired on: call a firing today's only if that date is ${DATE}, and give the date of any other firing you report.`,
  // No marker does not mean fresh: the data layer reuses a marked answer ten
  // minutes, an unmarked one a day, or an hour if its newest bar is before the
  // previous trading day, and answers a full stored set under a day old without it.
  'The reply\'s second line, "Newest bar: <SYM> <DATE>, …", gives the newest bar each symbol\'s signals are computed on; judge age by that DATE alone, not by the "(fallback)" marker, since a symbol without it can still be old.',
  `A newest bar dated ${DATE} or prev_trading is the normal state at this hour, not a concern.`,
  // The status line that carries a concern is stripped from the broadcast,
  // so the symbols behind are also written where the reader sees them.
  'In the Highlights heading write the date the signals are computed through and, after it, each symbol whose newest bar is older than prev_trading or shows "none", with its date or "none"; when no symbol is behind, add nothing.',
  'Report as a concern every symbol whose newest bar is older than prev_trading or shows "none", naming each symbol and its date, or that it has none.',
  'If the reply has no "Newest bar:" line, say so and report it as a concern.',
];

/** Every double-quoted span in the template's own step `n`, in the sentence that starts with `prefix`. */
function quotedIn(n: number, prefix: string): string[] {
  const s = step(n);
  const at = s.indexOf(prefix);
  expect(at, `step ${n} contains: ${prefix}`).toBeGreaterThanOrEqual(0);
  const end = s.indexOf(". ", at);
  const sentence = s.slice(at, end === -1 ? undefined : end);
  const spans = [...sentence.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  expect(spans.length, `quoted spans after: ${prefix}`).toBeGreaterThan(0);
  return spans;
}

const escapeRe = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const quoteBar = (extra: Partial<MarketBar> = {}): MarketBar => ({
  symbol: "SPY",
  timestamp: "2026-11-19T16:00:00-05:00",
  open: 521.5,
  high: 524.2,
  low: 520.1,
  close: 523.45,
  volume: 52345678,
  provider: "alpha_vantage",
  interval: "daily",
  ...extra,
});

const dailyBars = (symbol: string, n: number, last: string): MarketBar[] =>
  Array.from({ length: n }, (_, i) => ({
    symbol,
    timestamp: `${i === n - 1 ? last : "2026-09-01"}T00:00:00-04:00`,
    open: 90,
    high: 91,
    low: 89,
    close: 90,
    volume: 10,
    provider: "polygon",
    interval: "daily",
  }));

describe("createMarketEodScan — today's close and paper equity (2026-11-21)", () => {
  it.each(STEP5_SENTENCES)("step 5 says: %s", (sentence) => {
    expect(step(5)).toContain(sentence);
  });

  it("step 5 is exactly those sentences, nothing added", () => {
    expect(step(5)).toBe(STEP5_SENTENCES.join(" "));
  });

  it.each(STEP6_SENTENCES)("step 6 says: %s", (sentence) => {
    expect(step(6)).toContain(sentence);
  });

  it("step 6 is exactly those sentences, nothing added", () => {
    expect(step(6)).toBe(STEP6_SENTENCES.join(" "));
  });

  it("the prompt no longer describes the old quote stamp or a fixed 'today' label", async () => {
    const d = tpl().description;
    for (const gone of ["@ <YYYY-MM-DD>", "T16:00:00", "OHLC today"]) {
      expect(d).not.toContain(gone);
    }
    const { marketQuoteTool } = await import("../tools/builtin/market.js");
    mockLayer.getQuote.mockResolvedValueOnce(quoteBar());
    const reply = await marketQuoteTool.execute({ symbol: "SPY" });
    expect(reply).not.toContain("OHLC today");
    expect(reply).not.toContain(" @ ");
  });

  it("the OHLC part step 5 names carries the source's trading day, which can be earlier than today", async () => {
    const { marketQuoteTool } = await import("../tools/builtin/market.js");
    const [ohlc] = quotedIn(5, "The quote's trading day");
    const described = new RegExp(
      escapeRe(ohlc!)
        .replace("<YYYY-MM-DD>", "(\\d{4}-\\d{2}-\\d{2})")
        .replace("…", "[^)]+"),
    );
    mockLayer.getQuote.mockResolvedValueOnce(quoteBar());
    const reply = await marketQuoteTool.execute({ symbol: "SPY" });
    const m = described.exec(reply);
    expect(m, `described OHLC part vs reply: ${reply}`).not.toBeNull();
    expect(m![1]).toBe("2026-11-19");
  });

  it('the "change" and "prev close" parts step 5 names are printed only when the source gives them', async () => {
    const { marketQuoteTool } = await import("../tools/builtin/market.js");
    const parts = quotedIn(5, "When the line carries");
    expect(parts).toEqual(["change", "prev close"]);
    mockLayer.getQuote.mockResolvedValueOnce(
      quoteBar({ changePercent: -0.4567, previousClose: 525.85 }),
    );
    const withChange = await marketQuoteTool.execute({ symbol: "SPY" });
    expect(withChange).toContain(" · change -0.46% · prev close $525.85 ");
    mockLayer.getQuote.mockResolvedValueOnce(quoteBar());
    const without = await marketQuoteTool.execute({ symbol: "SPY" });
    for (const p of parts) expect(without).not.toContain(` · ${p} `);
  });

  it("a failed quote is the error object step 5 names", async () => {
    const { marketQuoteTool } = await import("../tools/builtin/market.js");
    expect(step(5)).toContain('If market_quote fails (an {"error": …} reply)');
    mockLayer.getQuote.mockRejectedValueOnce(
      new Error("Rate limited by alpha_vantage"),
    );
    const refused = await marketQuoteTool.execute({ symbol: "SPY" });
    expect(refused.startsWith('{"error":')).toBe(true);
    expect(Object.keys(JSON.parse(refused) as object)).toEqual(["error"]);
    mockLayer.getQuote.mockResolvedValueOnce(quoteBar({ close: Number.NaN }));
    const noPrice = await marketQuoteTool.execute({ symbol: "SPY" });
    expect(JSON.parse(noPrice)).toEqual({
      error: "market_quote: la fuente no dio precio para SPY",
    });
  });

  it("the STALE marker step 5 quotes is the one market_history prints for stored rows", async () => {
    const { marketHistoryTool } = await import("../tools/builtin/market.js");
    const [marker] = quotedIn(5, "If the prev_trading row is missing");
    const bars = dailyBars("SPY", 1, "2026-11-17");
    mockLayer.getDaily.mockResolvedValueOnce({
      bars,
      provider: "polygon",
      stale: true,
    });
    expect(
      await marketHistoryTool.execute({ symbol: "SPY", lookback: 5 }),
    ).toContain(marker);
    mockLayer.getDaily.mockResolvedValueOnce({ bars, provider: "polygon" });
    expect(
      await marketHistoryTool.execute({ symbol: "SPY", lookback: 5 }),
    ).not.toContain(marker);
  });

  it("step 1's market_calendar reply carries the prev_trading date steps 5 and 6 refer to", async () => {
    expect(step(1)).toMatch(/^Call market_calendar with today's date\./);
    expect(tpl().tools).toContain("market_calendar");
    const { marketCalendarTool } =
      await import("../tools/builtin/market-ritual.js");
    // A Monday and the day after a holiday: the previous trading day is not
    // the previous calendar day, so a calendar-day answer fails here.
    for (const [date, prev] of [
      ["2026-11-23", "2026-11-20"],
      ["2026-11-27", "2026-11-25"],
    ]) {
      expect(await marketCalendarTool.execute({ date })).toContain(
        `prev_trading=${prev}`,
      );
    }
  });

  it("market_signals' second line is the Newest bar line step 6 names, with a date, the fallback marker and none", async () => {
    const { marketSignalsTool } = await import("../tools/builtin/market.js");
    const [line, fallback] = quotedIn(6, "The reply's second line");
    const [none] = quotedIn(6, "Report as a concern every symbol");
    const prefix = line!.slice(0, line!.indexOf("<SYM>"));
    mockLayer.listWatchlist.mockReturnValueOnce(
      ["AAA", "BBB", "CCC"].map((symbol) => ({ symbol, tags: [] })),
    );
    mockLayer.getDaily
      .mockResolvedValueOnce({
        bars: dailyBars("AAA", 45, "2026-11-19"),
        provider: "polygon",
      })
      .mockResolvedValueOnce({
        bars: dailyBars("BBB", 45, "2026-10-08"),
        provider: "polygon",
        stale: true,
      })
      .mockRejectedValueOnce(new Error("no bars"));
    const reply = await marketSignalsTool.execute({ lookback: 3 });
    expect(reply.split("\n")[1]).toBe(
      `  ${prefix}AAA 2026-11-19, BBB 2026-10-08 ${fallback}, CCC ${none}`,
    );
  });

  it('an early market_signals return has no "Newest bar:" line', async () => {
    const { marketSignalsTool } = await import("../tools/builtin/market.js");
    const [marker] = quotedIn(6, "If the reply has no");
    mockLayer.listWatchlist.mockReturnValueOnce([]);
    const reply = await marketSignalsTool.execute({ lookback: 3 });
    expect(reply).toBe(
      "market_signals: no symbol provided and watchlist is empty.",
    );
    expect(reply).not.toContain(marker);
    // The marker is the one a scanning reply does carry.
    mockLayer.getDaily.mockResolvedValueOnce({
      bars: dailyBars("SPY", 45, "2026-11-19"),
      provider: "polygon",
    });
    const scanned = await marketSignalsTool.execute({
      symbol: "SPY",
      lookback: 3,
    });
    expect(scanned.split("\n")[1]).toContain(marker);
  });

  it("each market_signals firing line starts with the date of the bar it fired on", async () => {
    const { marketSignalsTool } = await import("../tools/builtin/market.js");
    const day = (i: number): string =>
      new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10);
    const bars: MarketBar[] = Array.from({ length: 45 }, (_, i) => ({
      symbol: "SPY",
      timestamp: `${day(i)}T00:00:00-04:00`,
      open: 90,
      high: 91,
      low: 89,
      close: i === 44 ? 101 : 90,
      volume: 10,
      provider: "polygon",
      interval: "daily",
    }));
    mockLayer.getDaily.mockResolvedValueOnce({ bars, provider: "polygon" });
    const reply = await marketSignalsTool.execute({
      symbol: "SPY",
      lookback: 3,
      types: ["price_threshold"],
      price_thresholds: [100],
    });
    const line = /^ +(\d{4}-\d{2}-\d{2})T\S* \| price_threshold \|/m.exec(
      reply,
    );
    expect(line, `firing line in: ${reply}`).not.toBeNull();
    expect(line![1]).toBe(day(44));
  });

  // Pinned whole, like steps 5 and 6, so no instruction that narrows what
  // counts as a concern can enter the closing step or the IMPORTANT list
  // unnoticed: any edit to either must change this test on purpose.
  it("step 9 is exactly the compose step", () => {
    expect(step(9)).toBe(
      "Compose EOD recap in Spanish (Mexican tone) using the format below and emit it as your final output. The messaging router broadcasts it to Telegram automatically on task completion.",
    );
  });

  it("the IMPORTANT list is exactly these bullets, in order", () => {
    const d = tpl().description;
    const start = d.indexOf("IMPORTANT:\n");
    const end = d.indexOf("\n\n## Final-output format");
    expect(start, "IMPORTANT heading").toBeGreaterThanOrEqual(0);
    expect(d.slice(start, end).split("\n")).toEqual([
      "IMPORTANT:",
      "- There is NO `telegram_send` tool. Your final text output IS the Telegram message — the messaging router broadcasts it on task completion.",
      "- Do NOT call paper_rebalance — this ritual is read-only intelligence.",
      "- Empty fills today is the norm under weekly-only cadence; do not treat it as an anomaly.",
      "- paper_portfolio marks positions at the latest weekly close by design, so there is no daily equity change to report.",
    ]);
  });

  it("market_quote is in the tools list, and market_history stays for the fallback branch", () => {
    expect(tpl().tools).toContain("market_quote");
    expect(tpl().tools).toContain("market_history");
  });

  it("the Highlights heading carries the date the signals are computed through and the symbols behind", () => {
    const lines = tpl().description.split("\n");
    expect(lines.filter((l) => l.startsWith("**🗞️ Highlights"))).toEqual([
      "**🗞️ Highlights del día** (señales con cierres hasta [fecha]; atrasados: [símbolo fecha, …] si aplica)",
    ]);
  });

  it("the Mercado line is exactly the close line, with a slot for the close's date", () => {
    const lines = tpl().description.split("\n");
    expect(lines.filter((l) => l.startsWith("**📈 Mercado**"))).toEqual([
      "**📈 Mercado**: SPY $[close] ([+/-X%] vs ayer) · cierre del [fecha] si no es de hoy",
    ]);
  });

  it("the Paper line is exactly the weekly-mark line, with no daily change", () => {
    const line = tpl()
      .description.split("\n")
      .find((l) => l.startsWith("**💼 Paper**"));
    expect(line).toBe(
      "**💼 Paper**: equity=$[equity] (marcado al último cierre semanal)",
    );
  });
});
