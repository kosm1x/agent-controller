/**
 * Gemini upload cache on the real database through initDatabase(":memory:").
 *
 * The table is created lazily behind a module-level "ready" flag, so a fresh
 * database per test also needs a fresh module: each test resets the module
 * registry and imports the database module and this module again, which
 * gives both a new singleton and a cleared flag. No upload and no network:
 * this module only keeps the cache rows.
 *
 * Expiry is judged by SQLite's clock, so rows expire in the far past or the
 * far future (never near "now"); listing order is by `created_at`, so the
 * cases set distinct explicit values for it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";

type DbModule = typeof import("./index.js");
type GeminiModule = typeof import("./gemini-files.js");

const PAST = "2000-01-01 00:00:00";
const FUTURE = "2999-01-01 00:00:00";

let dbModule: DbModule;
let gemini: GeminiModule;
let db: Database.Database;

function file(over: Partial<Parameters<GeminiModule["upsertGeminiFile"]>[0]> = {}) {
  return {
    name: "files/a",
    displayName: "report-a.pdf",
    uri: "https://files.example/a-v1",
    mimeType: "application/pdf",
    sizeBytes: 100,
    state: "ACTIVE",
    expiresAt: FUTURE,
    ...over,
  };
}

function setCreatedAt(name: string, createdAt: string): void {
  db.prepare("UPDATE gemini_files SET created_at = ? WHERE name = ?").run(
    createdAt,
    name,
  );
}

function allRows(): Array<Record<string, unknown>> {
  return db
    .prepare("SELECT * FROM gemini_files ORDER BY name")
    .all() as Array<Record<string, unknown>>;
}

beforeEach(async () => {
  vi.resetModules();
  dbModule = await import("./index.js");
  db = dbModule.initDatabase(":memory:");
  gemini = await import("./gemini-files.js");
});

afterEach(() => {
  dbModule.closeDatabase();
  vi.restoreAllMocks();
});

describe("ensureGeminiFilesTable", () => {
  it("creates the table on first use, with name unique", () => {
    const tableCount = () =>
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'gemini_files'",
          )
          .get() as { n: number }
      ).n;
    expect(tableCount()).toBe(0);

    gemini.ensureGeminiFilesTable();

    expect(tableCount()).toBe(1);
    db.prepare(
      "INSERT INTO gemini_files (name, display_name, uri, mime_type, expires_at) VALUES ('files/x', 'x', 'u', 'm', ?)",
    ).run(FUTURE);
    expect(() =>
      db
        .prepare(
          "INSERT INTO gemini_files (name, display_name, uri, mime_type, expires_at) VALUES ('files/x', 'y', 'u', 'm', ?)",
        )
        .run(FUTURE),
    ).toThrow(/UNIQUE/);
    expect(allRows()[0]).toMatchObject({ state: "PROCESSING", size_bytes: 0 });
  });
});

describe("upsertGeminiFile", () => {
  it("inserts a new name and updates uri, state, size and expiry on the same name", () => {
    gemini.upsertGeminiFile(file({ state: "PROCESSING" }));
    expect(allRows()).toEqual([
      expect.objectContaining({
        name: "files/a",
        display_name: "report-a.pdf",
        uri: "https://files.example/a-v1",
        mime_type: "application/pdf",
        size_bytes: 100,
        state: "PROCESSING",
        expires_at: FUTURE,
      }),
    ]);

    gemini.upsertGeminiFile(
      file({
        uri: "https://files.example/a-v2",
        state: "ACTIVE",
        sizeBytes: 250,
        expiresAt: "2998-06-01 00:00:00",
      }),
    );

    const rows = allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "files/a",
      uri: "https://files.example/a-v2",
      state: "ACTIVE",
      size_bytes: 250,
      expires_at: "2998-06-01 00:00:00",
    });
  });
});

describe("updateGeminiFileState", () => {
  it("changes the state of the named row only", () => {
    gemini.upsertGeminiFile(file({ name: "files/a", state: "PROCESSING" }));
    gemini.upsertGeminiFile(file({ name: "files/b", state: "PROCESSING" }));

    gemini.updateGeminiFileState("files/a", "FAILED");

    expect(allRows().map((r) => [r.name, r.state])).toEqual([
      ["files/a", "FAILED"],
      ["files/b", "PROCESSING"],
    ]);
  });
});

describe("listActiveGeminiFiles", () => {
  it("returns only ACTIVE rows that have not expired, newest first", () => {
    gemini.upsertGeminiFile(file({ name: "files/old", displayName: "old" }));
    gemini.upsertGeminiFile(file({ name: "files/new", displayName: "new" }));
    gemini.upsertGeminiFile(file({ name: "files/expired", expiresAt: PAST }));
    gemini.upsertGeminiFile(file({ name: "files/pending", state: "PROCESSING" }));
    setCreatedAt("files/old", "2026-01-01 10:00:00");
    setCreatedAt("files/new", "2026-01-02 10:00:00");

    const active = gemini.listActiveGeminiFiles();

    expect(active.map((r) => r.name)).toEqual(["files/new", "files/old"]);
    expect(active[0]).toEqual({
      name: "files/new",
      display_name: "new",
      uri: "https://files.example/a-v1",
      mime_type: "application/pdf",
      size_bytes: 100,
      state: "ACTIVE",
      expires_at: FUTURE,
      created_at: "2026-01-02 10:00:00",
    });
  });
});

describe("getGeminiFile", () => {
  it("finds a row by name or by display name, the newest when a display name repeats", () => {
    gemini.upsertGeminiFile(file({ name: "files/one", displayName: "shared.pdf" }));
    gemini.upsertGeminiFile(file({ name: "files/two", displayName: "shared.pdf" }));
    gemini.upsertGeminiFile(file({ name: "files/three", displayName: "solo.pdf" }));
    setCreatedAt("files/one", "2026-01-01 10:00:00");
    setCreatedAt("files/two", "2026-01-03 10:00:00");
    setCreatedAt("files/three", "2026-01-02 10:00:00");

    expect(gemini.getGeminiFile("files/one")?.name).toBe("files/one");
    expect(gemini.getGeminiFile("solo.pdf")?.name).toBe("files/three");
    expect(gemini.getGeminiFile("shared.pdf")).toMatchObject({
      name: "files/two",
      display_name: "shared.pdf",
      created_at: "2026-01-03 10:00:00",
    });
    // No row is "nothing found" (the driver gives undefined, the signature says null).
    expect(gemini.getGeminiFile("files/missing") ?? null).toBeNull();
  });
});

describe("cleanupExpiredGeminiFiles", () => {
  it("deletes expired rows whatever their state and reports the count", () => {
    gemini.upsertGeminiFile(file({ name: "files/live" }));
    gemini.upsertGeminiFile(file({ name: "files/gone-a", expiresAt: PAST }));
    gemini.upsertGeminiFile(
      file({ name: "files/gone-b", expiresAt: PAST, state: "PROCESSING" }),
    );

    expect(gemini.cleanupExpiredGeminiFiles()).toBe(2);
    expect(allRows().map((r) => r.name)).toEqual(["files/live"]);
  });
});
