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

export interface UserFact {
  category: string;
  key: string;
  value: string;
  source: string;
  updated_at: string;
}

/**
 * Set (upsert) a user fact. If (category, key) exists, updates the value.
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

/** Max total chars for the facts block to prevent prompt bloat. */
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

  // Build output within budget
  const byCategory = new Map<string, string[]>();
  let totalChars = 0;

  // Always-inject first
  for (const f of alwaysFacts) {
    const line = `- **${f.key}**: ${f.value}`;
    const list = byCategory.get(f.category) ?? [];
    list.push(line);
    byCategory.set(f.category, list);
    totalChars += line.length;
  }

  // Then scored facts up to budget
  for (const { fact: f } of scoredFacts) {
    const line = `- **${f.key}**: ${f.value}`;
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
