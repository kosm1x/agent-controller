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

import {
  looksSensitive,
  parseAnswers,
  parseGroupDescriptions,
  selectGroups,
} from "../tuning/jev-scope-replay.js";
import {
  buildChainQuestions,
  buildChainState,
  parseClassifierGuidance,
} from "../tuning/jev-scope-chain.js";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-1.13.0";
/** The threshold the retest registered and judged (first-half pick). */
export const JEV_SCOPE_THRESHOLD = 0.7;
/** Retest: p95 254 ms, max 532 ms over 946 requests. */
const DEADLINE_MS = 1500;

/** A line that is nothing but one opaque token: a pasted code or short key. */
const BARE_TOKEN =
  /^[ \t]*(?!https?:\/\/|\/)(?=\S*\p{L})(?=\S*[\d!@#$%^&*])\S{6,}[ \t]*$/mu;

/** Credential-shaped text, and third parties' e-mail addresses, stay here. */
export const mustNotLeave = (text: string): boolean =>
  looksSensitive(text) ||
  BARE_TOKEN.test(text) ||
  /[\w.+-]+@[\w-]+\.[\w.-]+/.test(text);

/**
 * On when the key is present; `SCOPE_CLASSIFIER_PROVIDER=sonnet` is the kill
 * switch. Direct env read, like the other knobs in scope-classifier.ts.
 */
export function jevScopeEnabled(): boolean {
  return (
    !!process.env.TYPESAFE_API_KEY &&
    process.env.SCOPE_CLASSIFIER_PROVIDER?.trim().toLowerCase() !== "sonnet"
  );
}

export async function classifyScopeGroupsWithJev(
  message: string,
  recentContext: string | undefined,
  prompt: string,
  validGroups: ReadonlySet<string>,
): Promise<Set<string> | null> {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) return null;
  const context = recentContext ?? "";
  // Role labels stripped first: "user:" is itself login-shaped.
  if (
    mustNotLeave(message) ||
    mustNotLeave(context.replace(/^(user|assistant): /gm, ""))
  ) {
    console.log("[scope-classifier] jev skipped: text withheld → sonnet");
    return null;
  }

  const descriptions = parseGroupDescriptions(prompt, validGroups);
  const started = performance.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        state: buildChainState(
          message,
          context,
          parseClassifierGuidance(prompt),
        ),
        model: MODEL,
        questions: buildChainQuestions(descriptions),
      }),
      signal: AbortSignal.timeout(DEADLINE_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const answers = parseAnswers(await res.json(), descriptions.keys());
    if (!answers) throw new Error("malformed body");
    const groups = selectGroups(answers.nouls, JEV_SCOPE_THRESHOLD);
    console.log(
      `[scope-classifier] jev: [${[...groups].join(",")}] in ${Math.round(performance.now() - started)} ms`,
    );
    return groups;
  } catch (err) {
    console.warn(
      `[scope-classifier] jev failed after ${Math.round(performance.now() - started)} ms → sonnet: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
