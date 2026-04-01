/**
 * Multi-layer doom-loop detection — replaces simple string-match
 * buildToolSignature with 4 layers of progressively expensive checks.
 *
 * Layer 0: Content-chanting (sliding window hash on LLM text)
 * Layer 1: Canonical JSON fingerprint + outcome-aware tracking
 * Layer 2: Ping-pong cycle detection (period 2-3)
 * Layer 3: N-gram Jaccard similarity on text responses
 *
 * All pure functions, no side effects, fully testable.
 */

import {
  DOOM_CHANTING_THRESHOLD,
  DOOM_CHANTING_CHUNK,
  DOOM_FINGERPRINT_THRESHOLD,
  DOOM_JACCARD_THRESHOLD,
  DOOM_JACCARD_WINDOW,
  DOOM_CYCLE_HISTORY,
} from "../config/constants.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DoomLoopState {
  /** Layer 0: sliding window of text chunk hashes. */
  textHashes: Map<number, number>;
  /** Layer 1: (callHash:resultHash) → occurrence count. */
  callResultPairs: Map<string, number>;
  /** Layer 2: recent canonical call signatures for cycle detection. */
  signatureHistory: string[];
  /** Layer 3: recent LLM text responses for Jaccard comparison. */
  recentTexts: string[];
}

export interface DoomLoopSignal {
  layer: 0 | 1 | 2 | 3;
  severity: "low" | "medium" | "high";
  description: string;
}

export interface RoundData {
  toolCalls: Array<{
    function: { name: string; arguments: string };
  }>;
  toolResults: Array<{ content: string | unknown }>;
  llmText: string;
}

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

export function createDoomLoopState(): DoomLoopState {
  return {
    textHashes: new Map(),
    callResultPairs: new Map(),
    signatureHistory: [],
    recentTexts: [],
  };
}

// ---------------------------------------------------------------------------
// Hash utility (FNV-1a 32-bit — fast, no deps)
// ---------------------------------------------------------------------------

export function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}

// ---------------------------------------------------------------------------
// Layer 0: Content chanting
// ---------------------------------------------------------------------------

/**
 * Detect repetitive text by hashing fixed-size chunks and counting repeats.
 * Fires when any single hash appears >= threshold times.
 */
export function detectContentChanting(
  state: DoomLoopState,
  text: string,
  chunkSize = DOOM_CHANTING_CHUNK,
  threshold = DOOM_CHANTING_THRESHOLD,
): DoomLoopSignal | null {
  if (text.length < chunkSize) return null;

  for (let i = 0; i <= text.length - chunkSize; i += chunkSize) {
    const h = fnv1a(text.slice(i, i + chunkSize));
    const count = (state.textHashes.get(h) ?? 0) + 1;
    state.textHashes.set(h, count);
    if (count >= threshold) {
      return {
        layer: 0,
        severity: "high",
        description: `Content chanting: text chunk repeated ${count}x`,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Layer 1: Canonical JSON fingerprint + outcome-aware
// ---------------------------------------------------------------------------

/** Recursively sort object keys for canonical JSON representation. */
export function canonicalize(obj: unknown): string {
  if (obj === null || obj === undefined) return "null";
  if (typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalize).join(",") + "]";
  }
  const sorted = Object.keys(obj as Record<string, unknown>).sort();
  return (
    "{" +
    sorted
      .map(
        (k) =>
          JSON.stringify(k) +
          ":" +
          canonicalize((obj as Record<string, unknown>)[k]),
      )
      .join(",") +
    "}"
  );
}

/** Build a canonical signature for a set of tool calls. */
export function fingerprintCalls(
  toolCalls: Array<{ function: { name: string; arguments: string } }>,
): string {
  const parts = toolCalls
    .map((tc) => {
      let args: unknown;
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        args = tc.function.arguments;
      }
      return `${tc.function.name}:${canonicalize(args)}`;
    })
    .sort();
  return String(fnv1a(parts.join("|")));
}

/** Build a hash of the tool results (first 500 chars each). */
function fingerprintResults(
  results: Array<{ content: string | unknown }>,
): string {
  const parts = results
    .map((r) => (typeof r.content === "string" ? r.content.slice(0, 500) : ""))
    .join("|");
  return String(fnv1a(parts));
}

/**
 * Track (callHash, resultHash) pairs. Same call + same result = definitely stuck.
 */
export function detectFingerprint(
  state: DoomLoopState,
  toolCalls: RoundData["toolCalls"],
  toolResults: RoundData["toolResults"],
  threshold = DOOM_FINGERPRINT_THRESHOLD,
): { signal: DoomLoopSignal | null; callSig: string } {
  const callSig = fingerprintCalls(toolCalls);
  const resultSig = fingerprintResults(toolResults);
  const pairKey = `${callSig}:${resultSig}`;

  const count = (state.callResultPairs.get(pairKey) ?? 0) + 1;
  state.callResultPairs.set(pairKey, count);

  if (count >= threshold) {
    return {
      signal: {
        layer: 1,
        severity: "medium",
        description: `Identical call+result pair repeated ${count}x`,
      },
      callSig,
    };
  }
  return { signal: null, callSig };
}

// ---------------------------------------------------------------------------
// Layer 2: Ping-pong cycle detection
// ---------------------------------------------------------------------------

/**
 * Detect period-N cycles in the signature history.
 * Checks period 2 (A-B-A-B) and period 3 (A-B-C-A-B-C).
 */
export function detectCycle(
  state: DoomLoopState,
  callSig: string,
  maxHistory = DOOM_CYCLE_HISTORY,
): DoomLoopSignal | null {
  state.signatureHistory.push(callSig);
  if (state.signatureHistory.length > maxHistory) {
    state.signatureHistory.shift();
  }

  const sigs = state.signatureHistory;
  for (let period = 2; period <= 3; period++) {
    if (sigs.length < period * 2) continue;
    const tail = sigs.slice(-period * 2);
    const first = tail.slice(0, period);
    const second = tail.slice(period);
    if (first.every((f, i) => f === second[i])) {
      return {
        layer: 2,
        severity: "high",
        description: `Ping-pong cycle detected: period-${period}`,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Layer 3: N-gram Jaccard similarity
// ---------------------------------------------------------------------------

/** Build a set of character n-grams from a string. */
function ngrams(str: string, n = 3): Set<string> {
  const set = new Set<string>();
  const lower = str.toLowerCase();
  for (let i = 0; i <= lower.length - n; i++) {
    set.add(lower.slice(i, i + n));
  }
  return set;
}

/** Jaccard similarity between two n-gram sets. */
export function jaccardSimilarity(a: string, b: string, n = 3): number {
  const setA = ngrams(a, n);
  const setB = ngrams(b, n);
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const g of setA) {
    if (setB.has(g)) intersection++;
  }
  return intersection / (setA.size + setB.size - intersection);
}

/**
 * Check if recent LLM text responses are suspiciously similar.
 * All pairwise comparisons in the window must exceed threshold.
 */
export function detectTextStalled(
  state: DoomLoopState,
  text: string,
  window = DOOM_JACCARD_WINDOW,
  threshold = DOOM_JACCARD_THRESHOLD,
): DoomLoopSignal | null {
  if (text.length < 50) return null; // skip very short responses

  state.recentTexts.push(text);
  if (state.recentTexts.length > window) {
    state.recentTexts.shift();
  }

  if (state.recentTexts.length < window) return null;

  // All pairs must exceed threshold
  for (let i = 0; i < state.recentTexts.length; i++) {
    for (let j = i + 1; j < state.recentTexts.length; j++) {
      if (
        jaccardSimilarity(state.recentTexts[i], state.recentTexts[j]) <
        threshold
      ) {
        return null; // at least one pair is different enough
      }
    }
  }

  return {
    layer: 3,
    severity: "medium",
    description: `Text stalled: ${window} responses with Jaccard > ${threshold}`,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run all 4 detection layers (cheapest first). Returns the first signal
 * that fires, or null if no doom loop detected.
 */
export function updateDoomLoop(
  state: DoomLoopState,
  round: RoundData,
): DoomLoopSignal | null {
  // Layer 0: content chanting (cheapest)
  if (round.llmText) {
    const chanting = detectContentChanting(state, round.llmText);
    if (chanting) return chanting;
  }

  // Layer 1: canonical fingerprint + outcome-aware
  const { signal: fpSignal, callSig } = detectFingerprint(
    state,
    round.toolCalls,
    round.toolResults,
  );
  if (fpSignal) return fpSignal;

  // Layer 2: ping-pong cycle
  const cycle = detectCycle(state, callSig);
  if (cycle) return cycle;

  // Layer 3: n-gram Jaccard (most expensive)
  if (round.llmText) {
    const stalled = detectTextStalled(state, round.llmText);
    if (stalled) return stalled;
  }

  return null;
}
