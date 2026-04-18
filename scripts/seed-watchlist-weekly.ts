/**
 * One-shot seed script: populate 10-symbol watchlist + weekly history.
 *
 * Runs once (idempotent). Each symbol is added to the watchlist (active=1)
 * and then seedSymbol() fetches ~520 weekly bars + detects signals.
 *
 * Usage: npx tsx scripts/seed-watchlist-weekly.ts
 */

import { initDatabase } from "../src/db/index.js";
import { getDataLayer } from "../src/finance/data-layer.js";
import { seedSymbol, formatSeedResult } from "../src/finance/watchlist-seed.js";
import type { AssetClass } from "../src/finance/types.js";

interface SeedTarget {
  symbol: string;
  assetClass: AssetClass;
  name: string;
  tags: string[];
}

const TARGETS: SeedTarget[] = [
  {
    symbol: "SPY",
    assetClass: "etf",
    name: "S&P 500 ETF",
    tags: ["broad", "market"],
  },
  {
    symbol: "QQQ",
    assetClass: "etf",
    name: "Nasdaq 100 ETF",
    tags: ["tech", "index"],
  },
  {
    symbol: "AAPL",
    assetClass: "equity",
    name: "Apple Inc",
    tags: ["mega", "tech"],
  },
  {
    symbol: "MSFT",
    assetClass: "equity",
    name: "Microsoft",
    tags: ["mega", "tech"],
  },
  {
    symbol: "NVDA",
    assetClass: "equity",
    name: "NVIDIA",
    tags: ["semi", "ai"],
  },
  {
    symbol: "TSLA",
    assetClass: "equity",
    name: "Tesla",
    tags: ["ev", "growth"],
  },
  {
    symbol: "GLD",
    assetClass: "etf",
    name: "SPDR Gold",
    tags: ["commodity", "safe-haven"],
  },
  {
    symbol: "TLT",
    assetClass: "etf",
    name: "20+ Yr Treasury",
    tags: ["bond", "duration"],
  },
  {
    symbol: "JPM",
    assetClass: "equity",
    name: "JPMorgan",
    tags: ["financials"],
  },
  {
    symbol: "XLE",
    assetClass: "etf",
    name: "Energy Sector",
    tags: ["sector", "energy"],
  },
];

async function main() {
  initDatabase("./data/mc.db");
  const layer = getDataLayer();
  const started = Date.now();
  console.log(
    `[seed] Starting 10-symbol weekly seed at ${new Date().toISOString()}`,
  );

  const results: Array<{
    symbol: string;
    addOk: boolean;
    seed: ReturnType<typeof formatSeedResult>;
  }> = [];

  for (const t of TARGETS) {
    let addOk = false;
    try {
      layer.addToWatchlist({
        symbol: t.symbol,
        assetClass: t.assetClass,
        name: t.name,
        tags: t.tags,
      });
      addOk = true;
    } catch (err) {
      console.log(
        `[seed] ${t.symbol} watchlist insert failed: ${err instanceof Error ? err.message : err}`,
      );
    }

    const seed = await seedSymbol(t.symbol, { minBars: 300 });
    const line = formatSeedResult(seed);
    console.log(`[seed] ${line}`);
    results.push({ symbol: t.symbol, addOk, seed: line });

    // Small delay between symbols to keep AV rate limiter happy (75/min ceiling).
    await new Promise((r) => setTimeout(r, 900));
  }

  const elapsedSec = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n[seed] Finished in ${elapsedSec}s`);
  console.log(`[seed] Summary:`);
  for (const r of results)
    console.log(
      `  ${r.symbol}: add=${r.addOk ? "ok" : "fail"}  ${r.seed.trim()}`,
    );
}

main().catch((err) => {
  console.error(`[seed] FATAL:`, err);
  process.exit(1);
});
