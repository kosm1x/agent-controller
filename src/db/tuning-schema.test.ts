/**
 * The tuning tables' DDL on a real database, and what opening a database does
 * and does not do: it creates the schema (the tuning tables included) and
 * writes no knowledge-base row; the directive rows come only from an explicit
 * seedDirectives() call. Temporary databases and a temporary mirror folder
 * only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, initDatabase } from "./index.js";
import { seedDirectives } from "./jarvis-fs.js";
import { cancelPendingRegeneration } from "./jarvis-index.js";
import { ensureTuningTables } from "./tuning-schema.js";
import { ensureTuningTables as ensureTuningTablesOnOpenDb } from "../tuning/schema.js";

const TUNING_TABLES = [
  "mined_test_cases",
  "tune_eval_results",
  "tune_experiments",
  "tune_runs",
  "tune_test_cases",
  "tune_variants",
];
const TUNING_INDEXES = [
  "idx_mined_cases_category",
  "idx_tune_cases_category",
  "idx_tune_experiments_run",
  "idx_tune_experiments_status",
  "idx_tune_results_experiment",
  "idx_tune_variants_score",
  "idx_tune_variants_valid",
];

const names = (db: Database.Database, type: "table" | "index"): string[] =>
  (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all(type) as Array<{ name: string }>
  ).map((r) => r.name);
const columns = (db: Database.Database, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

let dir = "";
const savedMirror = process.env.JARVIS_KB_MIRROR_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "mc-tuning-schema-test-"));
  process.env.JARVIS_KB_MIRROR_DIR = join(dir, "kb");
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  // A seeded row arms the index-regeneration timer through a dynamic import.
  await vi.dynamicImportSettled();
  cancelPendingRegeneration();
  closeDatabase();
  vi.restoreAllMocks();
  if (savedMirror === undefined) delete process.env.JARVIS_KB_MIRROR_DIR;
  else process.env.JARVIS_KB_MIRROR_DIR = savedMirror;
  rmSync(dir, { recursive: true, force: true });
});

describe("ensureTuningTables (database leaf)", () => {
  it("creates exactly the tuning tables, their indexes and the added columns on the handle it is given, and is idempotent", () => {
    const db = new Database(":memory:");
    try {
      ensureTuningTables(db);
      expect(names(db, "table")).toEqual(TUNING_TABLES);
      expect(names(db, "index")).toEqual(TUNING_INDEXES);
      expect(columns(db, "tune_variants")).toContain("code_fingerprint");
      expect(columns(db, "tune_experiments")).toEqual(expect.arrayContaining(["failure_source", "confidence_avg"]));
      ensureTuningTables(db);
      expect(names(db, "table")).toEqual(TUNING_TABLES);
      expect(names(db, "index")).toEqual(TUNING_INDEXES);
    } finally {
      db.close();
    }
  });

  it("declares every column of every tuning table with its type, in order", () => {
    const db = new Database(":memory:");
    try {
      ensureTuningTables(db);
      const declared = Object.fromEntries(
        TUNING_TABLES.map((t) => [
          t,
          (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string; type: string }>).map((c) => [
            c.name,
            c.type,
          ]),
        ]),
      );
      expect(declared).toEqual({
        mined_test_cases: [
          ["id", "INTEGER"],
          ["case_id", "TEXT"],
          ["category", "TEXT"],
          ["input", "TEXT"],
          ["expected", "TEXT"],
          ["weight", "REAL"],
          ["source", "TEXT"],
          ["active", "INTEGER"],
          ["mined_from", "TEXT"],
          ["created_at", "TEXT"],
        ],
        tune_eval_results: [
          ["id", "INTEGER"],
          ["experiment_id", "TEXT"],
          ["case_id", "TEXT"],
          ["score", "REAL"],
          ["details", "TEXT"],
          ["tokens_used", "INTEGER"],
          ["created_at", "TEXT"],
        ],
        tune_experiments: [
          ["id", "INTEGER"],
          ["experiment_id", "TEXT"],
          ["run_id", "TEXT"],
          ["surface", "TEXT"],
          ["target", "TEXT"],
          ["mutation_type", "TEXT"],
          ["original_value", "TEXT"],
          ["mutated_value", "TEXT"],
          ["hypothesis", "TEXT"],
          ["baseline_score", "REAL"],
          ["mutated_score", "REAL"],
          ["status", "TEXT"],
          ["created_at", "TEXT"],
          ["failure_source", "TEXT"],
          ["confidence_avg", "REAL"],
        ],
        tune_runs: [
          ["id", "INTEGER"],
          ["run_id", "TEXT"],
          ["status", "TEXT"],
          ["baseline_score", "REAL"],
          ["best_score", "REAL"],
          ["experiments_run", "INTEGER"],
          ["experiments_won", "INTEGER"],
          ["total_cost_usd", "REAL"],
          ["report", "TEXT"],
          ["started_at", "TEXT"],
          ["completed_at", "TEXT"],
        ],
        tune_test_cases: [
          ["id", "INTEGER"],
          ["case_id", "TEXT"],
          ["category", "TEXT"],
          ["input", "TEXT"],
          ["expected", "TEXT"],
          ["weight", "REAL"],
          ["source", "TEXT"],
          ["active", "INTEGER"],
          ["created_at", "TEXT"],
        ],
        tune_variants: [
          ["id", "INTEGER"],
          ["variant_id", "TEXT"],
          ["parent_id", "TEXT"],
          ["run_id", "TEXT"],
          ["generation", "INTEGER"],
          ["config_json", "TEXT"],
          ["composite_score", "REAL"],
          ["subscores_json", "TEXT"],
          ["valid", "INTEGER"],
          ["activated_at", "TEXT"],
          ["created_at", "TEXT"],
          ["code_fingerprint", "TEXT"],
        ],
      });
    } finally {
      db.close();
    }
  });
});

describe("ensureTuningTables (tuning module)", () => {
  it("creates the tuning tables on the open database", () => {
    initDatabase(":memory:");
    const db = getDatabase();
    db.exec("DROP TABLE mined_test_cases; DROP TABLE tune_runs;");
    expect(names(db, "table")).not.toContain("tune_runs");
    ensureTuningTablesOnOpenDb();
    expect(names(db, "table")).toEqual(expect.arrayContaining(TUNING_TABLES));
    expect(names(db, "index")).toEqual(expect.arrayContaining(TUNING_INDEXES));
  });
});

describe("initDatabase", () => {
  const directiveRows = (): Array<{ qualifier: string }> =>
    getDatabase()
      .prepare("SELECT qualifier FROM jarvis_files WHERE path LIKE 'directives/%' ORDER BY qualifier")
      .all() as Array<{ qualifier: string }>;

  it("does schema only: the tuning tables exist and no directive row is written until seedDirectives() runs", () => {
    const db = initDatabase(join(dir, "fresh.db"));
    expect(names(db, "table")).toEqual(expect.arrayContaining(TUNING_TABLES));
    expect(names(db, "index")).toEqual(expect.arrayContaining(TUNING_INDEXES));
    expect(directiveRows()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM jarvis_files").get()).toEqual({ n: 0 });

    seedDirectives();
    expect(directiveRows().map((r) => r.qualifier)).toEqual(["always-read", "enforce"]);
  });
});
