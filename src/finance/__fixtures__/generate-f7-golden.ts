/**
 * Golden-fixture generator for the F7 alpha combination pipeline.
 *
 * Run once: `npx tsx src/finance/__fixtures__/generate-f7-golden.ts`
 * This captures the current pipeline's output for a deterministic 3-signal
 * case and writes it to `f7-golden-3x10.json`. The committed JSON acts as a
 * regression guard — any math change that alters outputs will fail the
 * golden-fixture test, forcing an explicit commit-time update.
 *
 * NOT part of the test suite. Invoked manually when intentional math changes
 * land (and the change is reviewed + the new golden values are re-committed).
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runAlphaCombination } from "../alpha-combination.js";
import type { BarRow, FiringRow } from "../alpha-matrix.js";

function makeDays(asOf: string, count: number): string[] {
  const base = new Date(asOf + "T12:00:00Z");
  const days: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(base.getTime() - i * 86400000);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

const ASOF = "2026-04-17";
const M = 20; // window length
const days = makeDays(ASOF, M);

// Three deterministic synthetic signals. Each fires on a distinct symbol.
const symbols = ["AAPL", "TSLA", "NVDA"];
const bars: BarRow[] = [];
for (let symIdx = 0; symIdx < symbols.length; symIdx++) {
  const sym = symbols[symIdx]!;
  for (let i = 0; i < days.length; i++) {
    // Deterministic closes — mix of linear trend + per-symbol phase-shifted sine
    bars.push({
      symbol: sym,
      timestamp: days[i]!,
      close:
        100 + i * (0.3 + symIdx * 0.15) + Math.sin(i * (1 + symIdx) + symIdx),
    });
  }
}

// Firings: each symbol has its own firing pattern so signals are distinct.
// AAPL fires mostly long, TSLA mixed long/short, NVDA only long in second half.
const firings: FiringRow[] = [];
// AAPL — 12 long firings in first 12 days
for (let i = 0; i < 12; i++) {
  firings.push({
    symbol: "AAPL",
    signal_type: "ma_crossover",
    direction: "long",
    strength: 0.7,
    triggered_at: days[i]!,
  });
}
// TSLA — 10 mixed firings (alternating long/short)
for (let i = 0; i < 10; i++) {
  firings.push({
    symbol: "TSLA",
    signal_type: "ma_crossover",
    direction: i % 2 === 0 ? "long" : "short",
    strength: 0.6,
    triggered_at: days[i + 2]!,
  });
}
// NVDA — 8 long firings in days 6..13
for (let i = 0; i < 8; i++) {
  firings.push({
    symbol: "NVDA",
    signal_type: "ma_crossover",
    direction: "long",
    strength: 0.8,
    triggered_at: days[i + 6]!,
  });
}

const result = runAlphaCombination({
  mode: "returns",
  firings,
  bars,
  watchlistSize: 10,
  regime: "bull",
  asOf: ASOF,
  windowM: M,
  windowD: 12, // wide enough that the tail of R contains actual firing days
  horizon: 1,
  minFiringsForIc: 5,
  runId: "fixed-golden",
  now: new Date("2026-04-17T15:00:00Z"),
});

const golden = {
  description:
    "F7 alpha combination golden fixture. Do NOT edit by hand — regenerate via generate-f7-golden.ts if the pipeline math changes intentionally.",
  generatedAt: new Date().toISOString(),
  inputs: {
    asOf: ASOF,
    windowM: M,
    windowD: 12,
    horizon: 1,
    minFiringsForIc: 5,
    watchlistSize: 10,
    regime: "bull",
    symbols,
    firingsCount: firings.length,
    barsCount: bars.length,
  },
  expected: {
    N: result.N,
    NExcluded: result.NExcluded,
    NEffective: result.NEffective,
    mode: result.mode,
    regime: result.regime,
    signals: result.signals.map((s) => ({
      signalKey: s.signalKey,
      weight: s.weight,
      epsilon: s.epsilon,
      sigma: s.sigma,
      eNorm: s.eNorm,
      ic30d: s.ic30d,
      excluded: s.excluded,
      excludeReason: s.excludeReason,
    })),
  },
};

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "f7-golden-3x10.json");
writeFileSync(out, JSON.stringify(golden, null, 2) + "\n");
console.log("Wrote", out);
console.log(
  "Summary: N=",
  result.N,
  "NExcluded=",
  result.NExcluded,
  "NEffective=",
  result.NEffective.toFixed(4),
);
for (const s of result.signals) {
  console.log(
    "  ",
    s.signalKey,
    "w=",
    s.weight.toFixed(4),
    "excluded=",
    s.excluded,
    s.excludeReason ?? "",
  );
}
