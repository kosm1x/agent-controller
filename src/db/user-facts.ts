/**
 * User facts CRUD — structured personal fact storage.
 *
 * Facts are key-value pairs organized by category (personal, preferences,
 * work, health, philosophy). They survive across sessions and are always
 * injected into the Jarvis prompt so the LLM never forgets them.
 *
 * Uses UPSERT (INSERT OR REPLACE) on the (category, key) unique constraint.
 */

import { getDatabase } from "./index.js";
import { redactCredentials } from "../api/mcp-server/redact.js";
import { factSecretDisplay, invalidateSecretRefs } from "../lib/secret-refs.js";

export interface UserFact {
  category: string;
  key: string;
  value: string;
  source: string;
  updated_at: string;
}

/**
 * Credential vocabulary for a fact NAME (key or category), matched against
 * the name's tokens (split on non-alphanumerics and camelCase, lowercased,
 * accents stripped) so `author`, `keyboard` or `monkey` never match.
 * `token` followed by a quantity word (`token_budget`) is not a credential.
 * A bare `key` / `sid` counts only as the LAST token (`service_key`,
 * `connect_sid`), and `key` not after public/primary/foreign/sort/partition/
 * cache/hot/short. `clave` counts only as the last token or before
 * api/acceso/secreta/privada/wifi, never after `palabra` (keyword) — so
 * `clave_interbancaria` / `clave_elector` do not match. ct0 / swid / espn_s2
 * / li_at are session cookies stored under their own names.
 */
const CREDENTIAL_NAME_RE =
  / (?:api ?key|private key|access key|ssh key|(?<!(?:public|primary|foreign|sort|partition|cache|hot|short) )key(?= $)|token(?! (?:budget|count|limit|limits|usage|cost|price|rate|window) )|secrets?|passwords?|pass|pw|passwd|pwd|passphrase|cookies?|o?auth|credentials?|bearer|jwt|(?<!palabras? )claves?(?= $| (?:api|acceso|secreta|privada|wifi) )|llaves?|contrasenas?|credencial(?:es)?|secretos?|pin|sessionid|session id|sid(?= $)|phpsessid|li at|ct0|swid|espn s2) /;

/**
 * A name whose LAST token is metadata ABOUT a credential (`api_key_path`,
 * `auth_method`, `credential_rotation_date`) is not one by name; its value is
 * still judged by the value rules.
 */
const CREDENTIAL_META_LAST_RE =
  / (?:path|method|provider|date|issuer|type|expiry|expires|rotation) $/;

/**
 * Credential value shapes the shared redactCredentials table does not cover,
 * kept local so redact.ts consumers do not change. Every pattern is linear
 * (no nested quantifiers) and has no /g flag (test() stays stateless).
 */
const CREDENTIAL_VALUE_PATTERNS: readonly RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JWT
  /\b[srp]k_(?:live|test)_[A-Za-z0-9]{10,}/, // Stripe
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/, // Slack
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bfw_[A-Za-z0-9]{16,}/, // Fireworks
  /:\/\/[^\s/:@]+:[^\s/@]+@/, // URL userinfo user:pass@
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /(?:\bapi[ _-]?key|\btoken|\bpassword|\bcontrase(?:ñ|n\u0303?)a|\bclave)\s*[:=]\s*\S{6,}/i,
  /"(?:token|auth_token|password)"\s*:\s*"[^"]+"/i,
];

function nameTokens(name: string): string {
  const tokens = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return ` ${tokens.join(" ")} `;
}

function isCredentialName(name: string): boolean {
  const tokens = nameTokens(name);
  return (
    !CREDENTIAL_META_LAST_RE.test(tokens) && CREDENTIAL_NAME_RE.test(tokens)
  );
}

/**
 * Ruling 3 (2026-10-01, "mask and block"): the ONE credential classifier for
 * user facts. True when the key or category names a credential, or when the
 * value carries a credential shape (redactCredentials — without the loose
 * hex rule, so git SHAs are not credentials — plus the local patterns
 * above). A value that only CONTAINS a credential inside longer prose counts
 * too: the whole value is masked.
 */
export function isCredentialFact(
  category: string,
  key: string,
  value: string,
): boolean {
  return (
    isCredentialName(key) ||
    isCredentialName(category) ||
    redactCredentials(value) !== value ||
    CREDENTIAL_VALUE_PATTERNS.some((re) => re.test(value))
  );
}

/** Fallback mask when a credential has no reference name (not stored). */
export const CREDENTIAL_FACT_PLACEHOLDER =
  "[valor oculto: credencial guardada; no se muestra]";

/**
 * A fact's value as the model may see it: a credential shows its by-name
 * placeholder (ruling 3c, lib/secret-refs.ts), anything else the value.
 */
export function factDisplayValue(
  f: Pick<UserFact, "category" | "key" | "value">,
): string {
  return factSecretDisplay(f.category, f.key, f.value);
}

/**
 * Set (upsert) a user fact. If (category, key) exists, updates the value.
 * Ruling 3c: a credential-style fact is stored like any other; every reader
 * shows it by its reference name only (factDisplayValue / lib/secret-refs.ts).
 */
export function setUserFact(
  category: string,
  key: string,
  value: string,
  source = "conversation",
): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO user_facts (category, key, value, source, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(category, key)
     DO UPDATE SET value = excluded.value,
                   source = excluded.source,
                   updated_at = datetime('now')`,
  ).run(category, key, value, source);
  invalidateSecretRefs();
}

/**
 * Get all facts, optionally filtered by category.
 */
export function getUserFacts(category?: string): UserFact[] {
  const db = getDatabase();
  if (category) {
    return db
      .prepare(
        "SELECT category, key, value, source, updated_at FROM user_facts WHERE category = ? ORDER BY category, key",
      )
      .all(category) as UserFact[];
  }
  return db
    .prepare(
      "SELECT category, key, value, source, updated_at FROM user_facts ORDER BY category, key",
    )
    .all() as UserFact[];
}

/**
 * Delete a specific fact by category + key.
 */
export function deleteUserFact(category: string, key: string): boolean {
  const db = getDatabase();
  const result = db
    .prepare("DELETE FROM user_facts WHERE category = ? AND key = ?")
    .run(category, key);
  invalidateSecretRefs();
  return result.changes > 0;
}

/**
 * Categories that are ALWAYS injected (core identity, small).
 * Everything else is relevance-scored.
 */
const ALWAYS_INJECT_CATEGORIES = new Set([
  "personal",
  "contact",
  "preferences",
]);

/**
 * Max total chars for the SCORED part of the facts block (prompt-bloat cap).
 * Always-inject categories are NOT counted against it: on 2026-05-24 the
 * `personal` facts alone crossed 3,000 chars and every scored fact — all 197
 * `projects` rows, credentials included — was silently skipped on every chat
 * turn for three months (found 2026-09-06: «no tenemos guardado el espn_s2»
 * with three copies of it in user_facts).
 */
const MAX_FACTS_CHARS = 3_000;

/**
 * Score a fact's relevance to the current message.
 * Higher score = more relevant. 0 = no relevance signal.
 */
function scoreFact(fact: UserFact, messageWords: Set<string>): number {
  const text = `${fact.category} ${fact.key} ${fact.value}`.toLowerCase();
  let score = 0;
  for (const word of messageWords) {
    if (text.includes(word)) score += 1;
  }
  return score;
}

/**
 * Format user facts as a prompt block, relevance-scored per message.
 *
 * Always injects: personal, contact, preferences (core identity).
 * Other categories: scored by keyword overlap with the current message,
 * top-N included up to MAX_FACTS_CHARS budget. Long signal digests and
 * ephemeral intelligence reports don't bloat every prompt.
 *
 * Relevance floor (2026-09-06 qa-audit C1): when a message is given, a fact
 * with score 0 is never injected — otherwise the sort collapses to recency
 * and the budget fills with the newest rows on EVERY unrelated turn (live:
 * three session tokens, a password and an auth token). Only a call WITHOUT
 * a message (none in production — the router always passes msg.text) keeps
 * recency order; a message with no scorable word («?») injects nothing.
 */
export function formatUserFactsBlock(currentMessage?: string): string {
  const facts = getUserFacts();
  if (facts.length === 0) return "";

  // Split into always-inject vs scored
  const alwaysFacts: UserFact[] = [];
  const scoredFacts: Array<{ fact: UserFact; score: number }> = [];

  const messageWords = new Set(
    (currentMessage ?? "")
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  );

  for (const f of facts) {
    if (ALWAYS_INJECT_CATEGORIES.has(f.category)) {
      alwaysFacts.push(f);
    } else {
      const score = scoreFact(f, messageWords);
      scoredFacts.push({ fact: f, score });
    }
  }

  // Sort scored facts: relevant first, then by recency
  scoredFacts.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.fact.updated_at ?? "").localeCompare(a.fact.updated_at ?? "");
  });

  // Build output: always-inject unconditionally, then scored facts within
  // their own budget (see MAX_FACTS_CHARS).
  const byCategory = new Map<string, string[]>();
  let totalChars = 0;

  // Always-inject first — not counted against the scored budget
  for (const f of alwaysFacts) {
    const line = `- **${f.key}**: ${factDisplayValue(f)}`;
    const list = byCategory.get(f.category) ?? [];
    list.push(line);
    byCategory.set(f.category, list);
  }

  // Then scored facts up to budget — relevant ones only when a message is known
  const requireRelevance = currentMessage !== undefined;
  for (const { fact: f, score } of scoredFacts) {
    if (requireRelevance && score === 0) continue;
    const line = `- **${f.key}**: ${factDisplayValue(f)}`;
    if (totalChars + line.length > MAX_FACTS_CHARS) continue;
    const list = byCategory.get(f.category) ?? [];
    list.push(line);
    byCategory.set(f.category, list);
    totalChars += line.length;
  }

  const sections: string[] = [];
  for (const [category, lines] of byCategory) {
    sections.push(`### ${category}\n${lines.join("\n")}`);
  }

  return (
    "\n\n## Perfil del usuario (hechos confirmados)\n" +
    "Estos datos los proporcionó Fede directamente. NUNCA los olvides ni los contradigas.\n\n" +
    sections.join("\n\n")
  );
}
