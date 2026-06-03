/**
 * V8.2 Phase 5 — strategic-voice prompt module + stable cache prefix.
 *
 * Every V8.2 LLM call (decompose, the three RAPID-D perspectives, the
 * synthesizer, and the later judgment / critic passes) uses the SAME
 * systemPrompt — the strategic-voice principle block — so the Claude Agent
 * SDK's single end-of-systemPrompt cache breakpoint reuses ONE prefix across
 * the 10-22 calls within a brief (intra-brief cache-read; §10). Per-call
 * role/task instructions move to the HEAD of the USER prompt via
 * `composeV82UserPrompt`, so byte-drift there can never invalidate the cached
 * systemPrompt ([[cache_prefix_variability]] — mirrors `flattenMessagesForSdk`'s
 * `cacheable:false` routing in claude-sdk.ts).
 *
 * CAVEAT (verify, do NOT assume — §10 + [[sdk_systemprompt_single_cache_block]]):
 * a ~250-word block is ~330 tokens, below Anthropic's ~1024-token minimum
 * cacheable prefix, and a plain-string `systemPrompt` REPLACES the SDK's own
 * scaffold rather than appending to it. The structural guarantee this module
 * provides is "all V8.2 calls share one byte-identical prefix" (proved by the
 * cache-prefix invariant test). Whether that prefix actually caches under the
 * SDK — and the real intra-brief cache-read ratio — is MEASURED by
 * `scripts/verify-v82-cache.ts`, not asserted here.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * File id for the active principle version. Judgments record this string in
 * `judgments.strategic_voice_principle_id` (a file id — there is NO DB table,
 * per the R2 cleanup). Bumping the principle = a new `..._vN.md` file + a new
 * id here + a sycophancy-probe baseline re-run before activation (§10).
 */
export const STRATEGIC_VOICE_PRINCIPLE_ID = "strategic_voice_principle_v1";

/**
 * Absolute path to the active principle file. Resolved at CALL time (not at
 * import) so tests can redirect via `MC_PROMPT_MODULES_DIR` and re-read after
 * `__resetStrategicVoiceCacheForTest()`. Defaults cwd-relative to the repo root
 * (mirrors `DECISIONS_DIR` in decompose.ts): the markdown asset is NOT compiled
 * into `dist/`, so it must resolve against the service's working directory
 * (the repo root under systemd), never against the compiled module location.
 */
export function principleFilePath(): string {
  const dir = process.env.MC_PROMPT_MODULES_DIR ?? resolve("prompt_modules");
  return join(dir, `${STRATEGIC_VOICE_PRINCIPLE_ID}.md`);
}

let cachedPrinciple: string | null = null;

/**
 * Load + memoize the canonical strategic-voice principle block.
 *
 * Read ONCE: the identical string must be reused on every call for the SDK
 * cache prefix to match (a fresh read that produced even a 1-byte difference
 * would fragment the cache). Fails LOUD if the file is missing or empty rather
 * than silently shipping a degraded/empty system prompt (poka-yoke) — an empty
 * strategic-voice prefix would strip Jarvis's identity from every V8.2 call.
 */
export function loadStrategicVoicePrinciple(): string {
  if (cachedPrinciple !== null) return cachedPrinciple;
  const path = principleFilePath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(
      `strategic-voice: cannot read principle file at ${path} — ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  // trimEnd only: a trailing newline in the file must not drift the cache key,
  // but leading content is identity-load-bearing and preserved exactly.
  const trimmed = raw.trimEnd();
  if (trimmed.length === 0) {
    throw new Error(`strategic-voice: principle file at ${path} is empty`);
  }
  cachedPrinciple = trimmed;
  return cachedPrinciple;
}

/**
 * TEST-ONLY: clear the memoized principle so a subsequent load re-reads from
 * `MC_PROMPT_MODULES_DIR`. Never call in production — the whole point of the
 * memo is one stable string per process.
 */
export function __resetStrategicVoiceCacheForTest(): void {
  cachedPrinciple = null;
}

/**
 * The stable systemPrompt for EVERY V8.2 SDK call. Byte-identical across calls
 * by construction — this IS the shared cache prefix (§10). Never interpolate
 * per-call content here; per-call content belongs in the user prompt via
 * `composeV82UserPrompt`.
 */
export function strategicVoiceSystemPrompt(): string {
  return loadStrategicVoicePrinciple();
}

/**
 * Compose a V8.2 user prompt: per-call role/task instructions FIRST, then the
 * variable task body. Both live in the user turn (not the systemPrompt) so they
 * sit AFTER the cached strategic-voice prefix and never invalidate it
 * ([[cache_prefix_variability]]). The model still sees the role framing as the
 * lead of its turn — the strategic-voice block is Jarvis's identity, the role
 * instructions are the hat he wears for this sub-call.
 */
export function composeV82UserPrompt(
  roleInstructions: string,
  taskBody: string,
): string {
  const role = roleInstructions.trim();
  if (role.length === 0) return taskBody;
  return `${role}\n\n---\n\n${taskBody}`;
}

/**
 * §9 producer contract — the `[K]`-marker citation rule.
 *
 * The REAL guarantee that factual sentences take the resolved citation path
 * (not cite.ts's recall-biased markerless heuristic, which is only a backstop)
 * is the PRODUCER prompt instructing the judgment pass to mark every factual
 * sentence with a `[K]` evidence-ledger index. This const is the canonical §10
 * home for that contract; the judgment-assembly producer (a later phase)
 * prepends it to its user prompt via `composeV82UserPrompt`. It is kept OUT of
 * the identity block so that block stays byte-stable (cache key) and the
 * citation contract can version independently of the principles.
 *
 * Dormant in Phase 5: no producer emits ledger-cited prose yet. Exported +
 * test-locked now so the contract is ready and its wording is guarded.
 */
export const JUDGMENT_CITATION_CONTRACT_V1 = `Citation discipline (non-negotiable):
You are given an evidence ledger — evidence[1..N], each entry {kind, id, excerpt}.
- Every sentence that asserts a FACT (a number, a date, a named entity, or a
  state claim about a task / metric / person) MUST end with one or more [K]
  markers, where K is the 1-based ledger index of the evidence that supports it.
  Multiple sources: "...the account churned [1][3]."
- Use ONLY indices that exist in the ledger (1..N). NEVER invent an index, a URL,
  or an id — you choose slot numbers, nothing else.
- Sentences that are framing, transitions, or your own reasoning carry NO marker.
- If you cannot support a factual claim with a ledger index, do not assert it as
  fact: hedge it or drop it. An unsupported factual sentence is flagged by the
  CRITIC.`;
