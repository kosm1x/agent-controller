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
 * Format all user facts as a prompt block for injection into the LLM context.
 * Returns empty string if no facts exist.
 */
export function formatUserFactsBlock(): string {
  const facts = getUserFacts();
  if (facts.length === 0) return "";

  const byCategory = new Map<string, UserFact[]>();
  for (const f of facts) {
    const list = byCategory.get(f.category) ?? [];
    list.push(f);
    byCategory.set(f.category, list);
  }

  const sections: string[] = [];
  for (const [category, items] of byCategory) {
    const lines = items.map((f) => `- **${f.key}**: ${f.value}`).join("\n");
    sections.push(`### ${category}\n${lines}`);
  }

  return (
    "\n\n## Perfil del usuario (hechos confirmados)\n" +
    "Estos datos los proporcionó Fede directamente. NUNCA los olvides ni los contradigas.\n\n" +
    sections.join("\n\n")
  );
}
