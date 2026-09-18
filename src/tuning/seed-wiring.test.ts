import { describe, it, expect, vi, beforeAll } from "vitest";
import { initDatabase } from "../db/index.js";
import { ensureTuningTables, countTestCases } from "./schema.js";

// seedTestCases reads seed-cases.json through the bare "fs" specifier; feed it
// a corpus with one empty-check case and prove the refusal fires at the call
// site (not only when assertScorableCase is invoked directly) — 2026-09-18.
vi.mock("fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("fs")>();
  return {
    ...real,
    readFileSync: (path: unknown, enc?: unknown) =>
      String(path).endsWith("seed-cases.json")
        ? JSON.stringify([
            {
              case_id: "sc-empty-wiring",
              category: "scope_accuracy",
              input: { message: "hola" },
              expected: { scope_groups: [] },
              weight: 1,
              source: "seed",
            },
          ])
        : real.readFileSync(path as string, enc as BufferEncoding),
  };
});

import { seedTestCases } from "./test-cases.js";

beforeAll(() => {
  initDatabase(":memory:");
  ensureTuningTables();
});

describe("seedTestCases refuses an empty check set before inserting (2026-09-18)", () => {
  it("throws and leaves tune_test_cases empty", () => {
    expect(() => seedTestCases()).toThrow(
      /sc-empty-wiring \(scope_accuracy\): empty check set/,
    );
    expect(countTestCases()).toBe(0);
  });
});
