/**
 * TypeSafe Jev — the one place that talks to the vendor. Plain `fetch`, no
 * dependency. Callers: the scope classifier (live) and the shadow consumers
 * (`shadow.ts`, log-only).
 *
 * `askJev` throws on every non-answer (non-2xx, malformed body, timeout), so
 * a caller can never mistake silence for a score.
 */

import {
  sensitiveReasons,
  type JevQuestion,
} from "../tuning/jev-scope-replay.js";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-1.13.0";

/** A line that is nothing but one opaque token: a pasted code or short key. */
const BARE_TOKEN =
  /^[ \t]*(?!https?:\/\/|\/)(?=\S*\p{L})(?=\S*[\d!@#$%^&*])\S{6,}[ \t]*$/mu;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;

/**
 * The names of every rule that keeps `text` in the box: credential-shaped
 * text (`sensitiveReasons`), a bare token, a third party's e-mail address.
 * Names only, so a replay can count them without printing the text.
 */
export const withholdReasons = (text: string): string[] => [
  ...sensitiveReasons(text),
  ...(BARE_TOKEN.test(text) ? ["bare_token"] : []),
  ...(EMAIL.test(text) ? ["email"] : []),
];

/** Credential-shaped text, and third parties' e-mail addresses, stay here. */
export const mustNotLeave = (text: string): boolean =>
  withholdReasons(text).length > 0;

export const jevKey = (): string | undefined =>
  process.env.TYPESAFE_API_KEY || undefined;

/** One noul per question id, or a throw. Requires `jevKey()`. */
export async function askJev(
  state: Record<string, unknown>,
  questions: Record<string, JevQuestion>,
  deadlineMs: number,
): Promise<Record<string, number>> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jevKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ state, model: MODEL, questions }),
    signal: AbortSignal.timeout(deadlineMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const answers = ((await res.json()) as { answers?: unknown })?.answers as
    Record<string, { noul?: unknown }> | undefined;
  if (!answers || typeof answers !== "object")
    throw new Error("malformed body");
  const nouls: Record<string, number> = {};
  for (const id of Object.keys(questions)) {
    const p = answers[id]?.noul;
    if (typeof p !== "number" || p < 0 || p > 1)
      throw new Error("malformed body");
    nouls[id] = p;
  }
  return nouls;
}
