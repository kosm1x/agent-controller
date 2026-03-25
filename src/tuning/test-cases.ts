/**
 * Test case management — loading, seeding, and CRUD.
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { TestCase } from "./types.js";
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
