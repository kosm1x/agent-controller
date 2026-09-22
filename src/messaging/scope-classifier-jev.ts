/**
 * TypeSafe Jev as the scope classifier (operator ruling 2026-09-21: enabled at
 * the 89.5 % held-out coverage the equal-inputs retest measured — plan
 * `docs/planning/jev-decision-layer-plan-2026-09-21.md` §5).
 *
 * Same request the retest sent: normalized message + the router's
 * `recentContext` + the classifier prompt's RULES and examples in `state`, one
 * noul per group with the production description as criteria, groups kept at
 * the registered threshold. What the number does and does not cover: it was
 * measured on SPANISH turns (English/other read 74.0 %, n=50); and where the
 * retest sent a sensitive context turn as `[omitted]` (6.3 % of requests, worth
 * 0.1 pt), this path sends nothing and lets Sonnet classify the turn.
 *
 * Leaves the box on EVERY turn: the message, up to 150 chars of the previous
 * thread turn, and the classifier prompt's rules, examples and group
 * descriptions, which name internal projects and hosts.
 *
 * Returns null whenever Jev did not answer; the caller then runs the Sonnet
 * classifier, and after that the regex fallback — Jev can only be skipped,
 * never be the reason a turn has no scope.
 *
 * Text that looks like a credential, or carries an e-mail address, never
 * reaches the vendor: the turn goes to Sonnet instead. Known limit: the guard
 * sees the 150-char context slice, so a long token cut by the slice can leave
 * a fragment under the length its rule needs.
 */

import { askJev, jevKey, mustNotLeave } from "../jev/client.js";
import { recordJevShadow } from "../jev/shadow.js";
import {
  parseGroupDescriptions,
  selectGroups,
} from "../tuning/jev-scope-replay.js";
import {
  buildChainQuestions,
  buildChainState,
  parseClassifierGuidance,
} from "../tuning/jev-scope-chain.js";

export { mustNotLeave };

/** The threshold the retest registered and judged (first-half pick). */
export const JEV_SCOPE_THRESHOLD = 0.7;
/** Retest: p95 254 ms, max 532 ms over 946 requests. */
const DEADLINE_MS = 1500;

/**
 * On when the key is present; `SCOPE_CLASSIFIER_PROVIDER=sonnet` is the kill
 * switch. Direct env read, like the other knobs in scope-classifier.ts.
 */
export function jevScopeEnabled(): boolean {
  return (
    !!jevKey() &&
    process.env.SCOPE_CLASSIFIER_PROVIDER?.trim().toLowerCase() !== "sonnet"
  );
}

export async function classifyScopeGroupsWithJev(
  message: string,
  recentContext: string | undefined,
  prompt: string,
  validGroups: ReadonlySet<string>,
  wholeTurns: readonly string[] = [],
): Promise<Set<string> | null> {
  if (!jevKey()) return null;
  // One telemetry row per call: outcome, latency, the groups chosen — never
  // text. Deferred: a busy DB blocks the writer, and this is the turn's path.
  const log = (item: string, latencyMs: number | null, groups?: string) =>
    setImmediate(() =>
      recordJevShadow([
        {
          consumer: "scope",
          ref: null,
          item,
          noul: null,
          latencyMs,
          incumbent: groups ?? null,
        },
      ]),
    );
  const context = recentContext ?? "";
  // Role labels stripped first: "user:" is itself login-shaped. `wholeTurns`
  // is the context before the router cut it: a cut can drop the word that
  // makes the filter object and keep the value. A context with no whole
  // turns behind it cannot be read, so it does not leave.
  if (
    mustNotLeave(message) ||
    mustNotLeave(context.replace(/^(user|assistant): /gm, "")) ||
    (context !== "" && wholeTurns.length === 0) ||
    wholeTurns.some(mustNotLeave)
  ) {
    console.log("[scope-classifier] jev skipped: text withheld → sonnet");
    log("_withheld", null);
    return null;
  }

  const descriptions = parseGroupDescriptions(prompt, validGroups);
  const started = performance.now();
  try {
    const answers = await askJev(
      buildChainState(message, context, parseClassifierGuidance(prompt)),
      buildChainQuestions(descriptions),
      DEADLINE_MS,
    );
    const nouls: Record<string, number> = {};
    for (const g of descriptions.keys()) nouls[g] = answers[`g_${g}`];
    const groups = selectGroups(nouls, JEV_SCOPE_THRESHOLD);
    const ms = Math.round(performance.now() - started);
    console.log(
      `[scope-classifier] jev: [${[...groups].join(",")}] in ${ms} ms`,
    );
    log("answered", ms, [...groups].join(","));
    return groups;
  } catch (err) {
    const ms = Math.round(performance.now() - started);
    console.warn(
      `[scope-classifier] jev failed after ${ms} ms → sonnet: ${err instanceof Error ? err.message : String(err)}`,
    );
    log("_failed", ms);
    return null;
  }
}
