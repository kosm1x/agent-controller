/**
 * openDbFile must fail closed (queue 4a qa R1 Info 1): when getDatabase()
 * throws (no db open), the answer is "" — never a path — so the shared
 * live-db predicate refuses and neither the KB mirror nor Drive is written.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

const db = vi.hoisted(() => ({ impl: (): unknown => { throw new Error("Database not initialized"); } }));
vi.mock("./index.js", () => ({ getDatabase: () => db.impl() }));

import { LIVE_DB_PATH, isLiveDatabaseFile, openDbFile } from "./live-db.js";

afterEach(() => {
  db.impl = () => { throw new Error("Database not initialized"); };
});

describe("openDbFile", () => {
  it("getDatabase throwing ⇒ \"\" ⇒ the live predicate refuses", () => {
    expect(openDbFile()).toBe("");
    expect(isLiveDatabaseFile(openDbFile(), LIVE_DB_PATH)).toBe(false);
  });

  it("returns the main database file SQLite reports", () => {
    db.impl = () => ({
      pragma: () => [
        { name: "temp", file: "" },
        { name: "main", file: "/scratch/synth.db" },
      ],
    });
    expect(openDbFile()).toBe("/scratch/synth.db");
  });

  it("no main row ⇒ \"\"", () => {
    db.impl = () => ({ pragma: () => [{ name: "aux", file: "/x.db" }] });
    expect(openDbFile()).toBe("");
  });
});
