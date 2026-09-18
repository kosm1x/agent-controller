/**
 * Test case management — loading, seeding, and CRUD.
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { TestCase, TestCaseExpected } from "./types.js";
import {
  insertTestCase,
  countTestCases,
  getActiveTestCases,
} from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface SeedCase {
  case_id: string;
  category: string;
  input: {
    message: string;
    conversationHistory?: Array<{ role: string; content: string }>;
  };
  expected: Record<string, unknown>;
  weight: number;
  source: string;
}

const KNOWN_EXPECTED_KEYS: ReadonlySet<keyof TestCaseExpected> = new Set([
  "tools",
  "not_tools",
  "agent_type",
  "scope_groups",
  "not_scope_groups",
]);

/**
 * The scorers read only the keys declared on `TestCaseExpected`; any other
 * spelling is silently ignored and the case scores as "no checks" (= 1).
 * Three seeded cases carried `forbidden_groups` for months that way
 * (2026-09-18). Refuse at seed time instead.
 */
export function assertKnownExpectedKeys(
  caseId: string,
  expected: Record<string, unknown>,
): void {
  const unknown = Object.keys(expected).filter(
    (k) => !KNOWN_EXPECTED_KEYS.has(k as keyof TestCaseExpected),
  );
  if (unknown.length > 0) {
    throw new Error(
      `[tuning] seed case ${caseId}: unknown expected key(s) ${unknown.join(", ")} — the scorer reads only ${[...KNOWN_EXPECTED_KEYS].join(", ")}`,
    );
  }
}

/**
 * A case whose check set is empty scores 1 for free (`scorer.ts`
 * `totalChecks === 0` → "no checks"; `agent_type` defaults to "fast"). Same
 * defect class as the unknown-key case, one layer down (2026-09-18). Refuse
 * it at seed time so a `{"scope_groups": []}` case can never inflate a score.
 */
export function assertScorableCase(
  caseId: string,
  category: string,
  expected: Record<string, unknown>,
): void {
  assertKnownExpectedKeys(caseId, expected);
  const len = (k: keyof TestCaseExpected): number =>
    Array.isArray(expected[k]) ? (expected[k] as unknown[]).length : 0;
  const empty =
    category === "scope_accuracy"
      ? len("scope_groups") + len("not_scope_groups") === 0
      : category === "tool_selection"
        ? len("tools") + len("not_tools") === 0
        : category === "classification"
          ? typeof expected.agent_type !== "string"
          : null;
  if (empty === null) {
    throw new Error(
      `[tuning] seed case ${caseId}: unknown category "${category}" — it would be stored active and never scored`,
    );
  }
  if (empty) {
    throw new Error(
      `[tuning] seed case ${caseId} (${category}): empty check set — it would score 1 unconditionally`,
    );
  }
}

/**
 * Seed test cases from the JSON file into the database.
 * Uses INSERT OR REPLACE — safe to call multiple times.
 */
export function seedTestCases(): number {
  const existing = countTestCases();
  const seedPath = resolve(__dirname, "seed-cases.json");
  const raw = readFileSync(seedPath, "utf-8");
  const cases = JSON.parse(raw) as SeedCase[];

  let seeded = 0;
  for (const c of cases) {
    assertScorableCase(c.case_id, c.category, c.expected);
    const tc: TestCase = {
      case_id: c.case_id,
      category: c.category as TestCase["category"],
      input: c.input as TestCase["input"],
      expected: c.expected as TestCase["expected"],
      weight: c.weight,
      source: c.source as TestCase["source"],
      active: true,
    };
    insertTestCase(tc);
    seeded++;
  }

  const total = countTestCases();
  console.log(
    `[tuning] Seeded ${seeded} test cases (was ${existing}, now ${total})`,
  );
  return total;
}

/**
 * Get all active test cases, optionally filtered by category.
 */
export { getActiveTestCases };
