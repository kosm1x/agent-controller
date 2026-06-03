/**
 * V8.2 Phase 5 — live intra-brief cache-read verification harness (§10).
 *
 * NOT a unit test: this fires REAL Claude Agent SDK calls and burns tokens, so
 * it is operator-run, never part of CI. It measures whether the shared
 * strategic-voice systemPrompt actually caches under the SDK — the spec's
 * explicit "verify the principle block actually caches under the SDK before
 * trusting the prefix split" ([[gate_target_must_match_cadence]],
 * [[sdk_systemprompt_single_cache_block]]).
 *
 * Usage (from the repo root, with the same ~/.claude credentials the service
 * uses):
 *
 *   npx tsx scripts/verify-v82-cache.ts --run [N=6]
 *
 * It fires N calls seconds apart with a BYTE-IDENTICAL strategic-voice
 * systemPrompt and DISTINCT user prompts (mirroring a brief: stable system,
 * variable user). It then reports the intra-run cache-read ratio vs the ≥70%
 * target and the (N-1)/N ceiling, and PRE-WARNS when the stable prefix is below
 * Anthropic's minimum cacheable length — in which case cacheRead≈0 is EXPECTED,
 * not a bug, and the real cache win only arrives once the judgment pass adds a
 * larger stable prefix.
 *
 * Exit codes: 0 = PASS (≥70%), 1 = below target, 2 = error / no usage data,
 * 3 = dry (no --run).
 */

import { queryClaudeSdk } from "../src/inference/claude-sdk.js";
import {
  strategicVoiceSystemPrompt,
  composeV82UserPrompt,
} from "../src/lib/v8-2/strategic-voice.js";

/** Anthropic minimum cacheable prefix (Sonnet/Opus). Haiku is 2048. */
const MIN_CACHEABLE_TOKENS_SONNET = 1024;
const TARGET = 0.7;
const DEFAULT_N = 6;

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const armed =
    args.includes("--run") || process.env.MC_VERIFY_CACHE_RUN === "1";
  if (!armed) {
    console.log(
      "[verify-v82-cache] DRY — fires no SDK calls. Pass --run (or MC_VERIFY_CACHE_RUN=1) to measure live (burns tokens).",
    );
    console.log("  Usage: npx tsx scripts/verify-v82-cache.ts --run [N=6]");
    return 3;
  }

  const nArg = args.find((a) => /^\d+$/.test(a));
  const N = nArg ? Math.max(2, Number(nArg)) : DEFAULT_N;

  const system = strategicVoiceSystemPrompt();
  const approxTokens = Math.ceil(system.length / 4);
  console.log(
    `[verify-v82-cache] strategic-voice prefix: ${system.length} chars ≈ ${approxTokens} tokens; N=${N}`,
  );
  if (approxTokens < MIN_CACHEABLE_TOKENS_SONNET) {
    console.warn(
      `[verify-v82-cache] WARNING: prefix ≈${approxTokens} tok < Anthropic min cacheable ${MIN_CACHEABLE_TOKENS_SONNET} tok (Sonnet).\n` +
        `  A plain-string systemPrompt REPLACES the SDK scaffold, so this prefix ALONE may not cache — cacheRead≈0 is then EXPECTED.\n` +
        `  This is the §10 caveat: the block caches once the stable prefix crosses the floor (e.g. the larger judgment-pass prefix).`,
    );
  }

  const rows: Array<{
    i: number;
    prompt: number;
    cacheRead: number;
    cacheCreate: number;
  }> = [];

  for (let i = 0; i < N; i++) {
    const res = await queryClaudeSdk({
      // Distinct user turn per call; identical systemPrompt by construction.
      prompt: composeV82UserPrompt(
        `You are probe #${i} in an intra-brief cache test. Answer in ONE short sentence.`,
        `Probe ${i}: name a single risk of shipping a dormant code path.`,
      ),
      systemPrompt: system,
      toolNames: [],
      maxTurns: 1,
    });
    rows.push({
      i,
      prompt: res.usage.promptTokens,
      cacheRead: res.usage.cacheReadTokens,
      cacheCreate: res.usage.cacheCreationTokens,
    });
    console.log(
      `[verify-v82-cache] call ${i}: prompt=${res.usage.promptTokens} ` +
        `cacheRead=${res.usage.cacheReadTokens} cacheCreate=${res.usage.cacheCreationTokens}`,
    );
  }

  const totalPrompt = rows.reduce((s, r) => s + r.prompt, 0);
  const totalRead = rows.reduce((s, r) => s + r.cacheRead, 0);
  if (totalPrompt === 0) {
    console.error(
      "[verify-v82-cache] ERROR: zero prompt tokens recorded — SDK returned no usage. Cannot measure.",
    );
    return 2;
  }
  const ratio = totalRead / totalPrompt;
  const ceiling = (N - 1) / N;
  console.log(
    `\n[verify-v82-cache] intra-run cache-read = ${(ratio * 100).toFixed(1)}% ` +
      `(ceiling (N-1)/N = ${(ceiling * 100).toFixed(0)}%, target ≥${TARGET * 100}%)`,
  );

  if (ratio >= TARGET) {
    console.log(
      "[verify-v82-cache] PASS ✓ — the strategic-voice prefix caches intra-brief under the SDK.",
    );
    return 0;
  }
  console.log(
    `[verify-v82-cache] BELOW TARGET — prefix not caching to ≥${TARGET * 100}% intra-brief. ` +
      "If the pre-warn above fired, this is the documented §10 min-cacheable caveat, not a regression.",
  );
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("[verify-v82-cache] FAILED:", e);
    process.exit(2);
  });
