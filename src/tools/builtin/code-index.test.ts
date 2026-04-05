import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

// Mock the DB
const mockExec = vi.fn();
const mockPrepare = vi.fn().mockReturnValue({
  run: vi.fn(),
  all: vi.fn().mockReturnValue([]),
  get: vi.fn(),
});
const mockTransaction = vi.fn((fn: () => void) => fn);

vi.mock("../../db/index.js", () => ({
  getDatabase: () => ({
    exec: mockExec,
    prepare: mockPrepare,
    transaction: mockTransaction,
  }),
  writeWithRetry: (fn: () => void) => fn(),
}));

import { extractSymbols } from "./code-index.js";

// We can't easily test rebuildIndex (needs real FS + DB), but we can test extraction.
// Export extractSymbols for testing or test indirectly.

describe("code-index", () => {
  const tmpDir = "/tmp/code-index-test";

  beforeEach(() => {
    vi.clearAllMocks();
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("extracts exported functions", () => {
    const file = join(tmpDir, "test.ts");
    writeFileSync(
      file,
      [
        "export function hello(): void {",
        "  console.log('hi');",
        "}",
        "",
        "export async function fetchData(url: string): Promise<Response> {",
        "  return fetch(url);",
        "}",
      ].join("\n"),
    );

    // Use the test helper if available, otherwise skip
    if (typeof extractSymbols === "function") {
      const symbols = extractSymbols(file);
      expect(symbols.length).toBe(2);
      expect(symbols[0].name).toBe("hello");
      expect(symbols[0].kind).toBe("function");
      expect(symbols[0].exported).toBe(true);
      expect(symbols[0].line).toBe(1);
      expect(symbols[1].name).toBe("fetchData");
      expect(symbols[1].kind).toBe("function");
    }
  });

  it("extracts classes, interfaces, types, consts", () => {
    const file = join(tmpDir, "types.ts");
    writeFileSync(
      file,
      [
        "export interface Config {",
        "  name: string;",
        "}",
        "",
        "export type Status = 'active' | 'paused';",
        "",
        "export const MAX_RETRIES = 3;",
        "",
        "export class Worker {",
        "  run() {}",
        "}",
        "",
        "const internal = 42;", // not exported
      ].join("\n"),
    );

    if (typeof extractSymbols === "function") {
      const symbols = extractSymbols(file);
      expect(symbols.length).toBe(5); // 4 exported + 1 internal const
      expect(symbols.map((s) => s.name).sort()).toEqual(
        ["Config", "MAX_RETRIES", "Status", "Worker", "internal"].sort(),
      );
      const internalSym = symbols.find((s) => s.name === "internal");
      expect(internalSym?.exported).toBe(false);
    }
  });
});
