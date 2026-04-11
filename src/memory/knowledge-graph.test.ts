/**
 * Tests for temporal knowledge graph (v6.5 M1).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";

let mockDb: Database.Database;

vi.mock("../db/index.js", () => ({
  getDatabase: () => mockDb,
  writeWithRetry: (fn: () => unknown) => fn(),
}));

import {
  addTriple,
  queryTriples,
  invalidateTriple,
  getEntityHistory,
  formatTriples,
} from "./knowledge-graph.js";

beforeEach(() => {
  mockDb = new Database(":memory:");
  mockDb.exec(`CREATE TABLE knowledge_triples (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    subject     TEXT NOT NULL,
    predicate   TEXT NOT NULL,
    object      TEXT NOT NULL,
    confidence  REAL DEFAULT 1.0,
    valid_from  TEXT DEFAULT (datetime('now')),
    valid_to    TEXT,
    source      TEXT DEFAULT 'agent',
    task_id     TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  )`);
});

afterEach(() => {
  mockDb.close();
  vi.restoreAllMocks();
});

describe("addTriple", () => {
  it("inserts a triple and returns its ID", () => {
    const id = addTriple("cuatro-flor", "status_is", "phase 3 complete");
    expect(id).toBeGreaterThan(0);

    const rows = mockDb.prepare("SELECT * FROM knowledge_triples").all();
    expect(rows).toHaveLength(1);
  });

  it("supersedes prior triple with same subject+predicate", () => {
    addTriple("cuatro-flor", "status_is", "phase 2 complete");
    addTriple("cuatro-flor", "status_is", "phase 3 complete");

    const active = mockDb
      .prepare("SELECT * FROM knowledge_triples WHERE valid_to IS NULL")
      .all();
    expect(active).toHaveLength(1);
    expect((active[0] as { object: string }).object).toBe("phase 3 complete");

    const invalidated = mockDb
      .prepare("SELECT * FROM knowledge_triples WHERE valid_to IS NOT NULL")
      .all();
    expect(invalidated).toHaveLength(1);
  });

  it("respects supersede=false", () => {
    addTriple("jarvis", "uses", "qwen3.5-plus");
    addTriple("jarvis", "uses", "claude-sonnet", { supersede: false });

    const active = mockDb
      .prepare("SELECT * FROM knowledge_triples WHERE valid_to IS NULL")
      .all();
    expect(active).toHaveLength(2);
  });

  it("stores confidence and source", () => {
    addTriple("pipesong", "status_is", "phase 3", {
      confidence: 0.7,
      source: "extraction",
      taskId: "task-123",
    });

    const row = mockDb.prepare("SELECT * FROM knowledge_triples").get() as {
      confidence: number;
      source: string;
      task_id: string;
    };
    expect(row.confidence).toBe(0.7);
    expect(row.source).toBe("extraction");
    expect(row.task_id).toBe("task-123");
  });
});

describe("queryTriples", () => {
  beforeEach(() => {
    addTriple("cuatro-flor", "status_is", "phase 3 complete");
    addTriple("cuatro-flor", "uses", "117 as base module");
    addTriple("pipesong", "status_is", "phase 2 done");
  });

  it("queries by subject", () => {
    const results = queryTriples({ subject: "cuatro-flor" });
    expect(results).toHaveLength(2);
  });

  it("queries by subject+predicate", () => {
    const results = queryTriples({
      subject: "cuatro-flor",
      predicate: "status_is",
    });
    expect(results).toHaveLength(1);
    expect(results[0].object).toBe("phase 3 complete");
  });

  it("is case-insensitive", () => {
    const results = queryTriples({ subject: "CUATRO-FLOR" });
    expect(results).toHaveLength(2);
  });

  it("filters active only by default", () => {
    addTriple("cuatro-flor", "status_is", "phase 4 started"); // supersedes phase 3
    const results = queryTriples({
      subject: "cuatro-flor",
      predicate: "status_is",
    });
    expect(results).toHaveLength(1);
    expect(results[0].object).toBe("phase 4 started");
  });
});

describe("invalidateTriple", () => {
  it("sets valid_to on the triple", () => {
    const id = addTriple("jarvis", "model_is", "qwen3.5-plus");
    invalidateTriple(id);

    const row = mockDb
      .prepare("SELECT valid_to FROM knowledge_triples WHERE id = ?")
      .get(id) as { valid_to: string | null };
    expect(row.valid_to).not.toBeNull();
  });
});

describe("getEntityHistory", () => {
  it("returns all triples including invalidated", () => {
    addTriple("jarvis", "status_is", "v6.0");
    addTriple("jarvis", "status_is", "v6.5"); // supersedes

    const history = getEntityHistory("jarvis");
    expect(history).toHaveLength(2);
  });
});

describe("formatTriples", () => {
  it("formats triples as readable text", () => {
    addTriple("jarvis", "uses", "claude-sonnet");
    const triples = queryTriples({ subject: "jarvis" });
    const text = formatTriples(triples);
    expect(text).toContain("jarvis");
    expect(text).toContain("claude-sonnet");
    expect(text).toContain("→");
  });

  it("returns 'No known facts' for empty list", () => {
    expect(formatTriples([])).toBe("No known facts.");
  });
});
