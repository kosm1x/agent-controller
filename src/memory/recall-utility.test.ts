/**
 * Recall utility instrumentation tests — was_used tracking.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory queryable mock store. Each test resets it via beforeEach.
interface AuditRow {
  id: number;
  created_at: string; // "YYYY-MM-DD HH:MM:SS"
  bank: string;
  query: string;
  source: string;
  result_count: number;
  result_snippets: string;
  latency_ms: number | null;
  excluded_count: number;
  was_used: number | null;
  used_count: number | null;
  task_id: string | null;
  checked_at: string | null;
}

const store = {
  rows: [] as AuditRow[],
  nextId: 1,
};

const mockDb = {
  prepare: (sql: string) => {
    if (sql.startsWith("INSERT INTO recall_audit")) {
      return {
        run: (...args: unknown[]) => {
          const [bank, query, source, count, snippets, latency, excluded] =
            args as [
              string,
              string,
              string,
              number,
              string,
              number | null,
              number | null | undefined,
            ];
          store.rows.push({
            id: store.nextId++,
            created_at: new Date().toISOString().replace("T", " ").slice(0, 19),
            bank,
            query,
            source,
            result_count: count,
            result_snippets: snippets,
            latency_ms: latency,
            excluded_count: excluded ?? 0,
            was_used: null,
            used_count: null,
            task_id: null,
            checked_at: null,
          });
          return { changes: 1, lastInsertRowid: store.nextId - 1 };
        },
      };
    }
    if (sql.startsWith("SELECT id, result_snippets")) {
      return {
        all: (cutoffIso: string, _limit: number) => {
          return store.rows
            .filter((r) => r.was_used == null && r.created_at >= cutoffIso)
            .map((r) => ({ id: r.id, result_snippets: r.result_snippets }));
        },
      };
    }
    if (sql.startsWith("UPDATE recall_audit")) {
      return {
        run: (...args: unknown[]) => {
          const [wasUsed, usedCount, taskId, id] = args as [
            number,
            number,
            string,
            number,
          ];
          const row = store.rows.find((r) => r.id === id && r.was_used == null);
          if (!row) return { changes: 0 };
          row.was_used = wasUsed;
          row.used_count = usedCount;
          row.task_id = taskId;
          row.checked_at = new Date()
            .toISOString()
            .replace("T", " ")
            .slice(0, 19);
          return { changes: 1 };
        },
      };
    }
    throw new Error(`unmocked query: ${sql.slice(0, 60)}`);
  },
};

vi.mock("../db/index.js", () => ({
  getDatabase: () => mockDb,
  writeWithRetry: (fn: () => unknown) => fn(),
}));

import {
  deriveSnippets,
  logRecall,
  markRecallUtility,
  redactSecrets,
  SNIPPET_MAX_CHARS,
} from "./recall-utility.js";

beforeEach(() => {
  store.rows = [];
  store.nextId = 1;
});

describe("redactSecrets", () => {
  it("redacts OpenAI-style sk-… keys", () => {
    const out = redactSecrets("token sk-abcdefghij1234567890XYZ in the chat");
    expect(out).not.toContain("sk-abcdefghij");
    expect(out).toContain("[REDACTED-OPENAI-LIKE]");
  });

  it("redacts AWS access key IDs", () => {
    const out = redactSecrets("creds AKIAIOSFODNN7EXAMPLE here");
    expect(out).toContain("[REDACTED-AWS-AKID]");
  });

  it("redacts JWT tokens with three dot-separated base64 segments", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const out = redactSecrets(`session token ${jwt} expired`);
    expect(out).toContain("[REDACTED-JWT]");
  });

  it("leaves regular text alone", () => {
    expect(redactSecrets("just a sentence")).toBe("just a sentence");
  });
});

describe("deriveSnippets", () => {
  it("returns empty for content shorter than SNIPPET_MIN_CHARS", () => {
    expect(deriveSnippets("short")).toEqual([]);
  });

  it("returns first SNIPPET_MAX_CHARS chars for medium content", () => {
    const text = "x".repeat(60);
    const snippets = deriveSnippets(text);
    expect(snippets).toHaveLength(1);
    expect(snippets[0].length).toBe(60);
  });

  it("redacts secrets out of snippet output (W3)", () => {
    const text =
      "The user pasted sk-abcdefghij1234567890XYZxyz into the chat earlier today";
    const snippets = deriveSnippets(text);
    expect(snippets.length).toBeGreaterThan(0);
    expect(snippets.join(" ")).not.toContain("sk-abcdefghij");
    expect(snippets.join(" ")).toContain("[REDACTED-OPENAI-LIKE]");
  });

  it("returns head + middle for long content", () => {
    // 200 chars of distinct content: 100 'a' then 100 'b'
    const text = "a".repeat(100) + "b".repeat(100);
    const snippets = deriveSnippets(text);
    expect(snippets).toHaveLength(2);
    // head should start with 'a'
    expect(snippets[0].startsWith("a")).toBe(true);
    // middle window should contain a transition (mix of a and b)
    expect(snippets[1].includes("a")).toBe(true);
    expect(snippets[1].includes("b")).toBe(true);
  });

  it("strips AUTO-PERSIST prefix before fingerprinting", () => {
    const text =
      "[AUTO-PERSIST task=abc123]\nUser: " +
      "the user mentioned the migration deadline is friday".repeat(2);
    const snippets = deriveSnippets(text);
    expect(snippets.length).toBeGreaterThan(0);
    // Should not include the prefix marker
    expect(snippets[0]).not.toContain("AUTO-PERSIST");
    expect(snippets[0]).not.toContain("task=");
  });

  it("strips Spanish Usuario prefix", () => {
    const text =
      "Usuario: " +
      "necesita llegar al setenta por ciento de dominio en unidad cero".repeat(
        2,
      );
    const snippets = deriveSnippets(text);
    expect(snippets[0]).not.toMatch(/^Usuario:/i);
  });

  it("dedupes when head and middle would be identical", () => {
    // Content exactly 2*MAX so middle starts at MAX/2 — different region from head
    const text = "abcdef".repeat(SNIPPET_MAX_CHARS);
    const snippets = deriveSnippets(text);
    // Both windows extract from the same repeating string, dedup trims to 1
    expect(new Set(snippets).size).toBe(snippets.length);
  });
});

describe("logRecall", () => {
  it("inserts a row with derived snippets", () => {
    logRecall({
      bank: "mc-jarvis",
      query: "what did the user say about migration",
      source: "hindsight",
      results: [
        {
          content:
            "The user mentioned the migration deadline is set for friday next week and we should prepare a rollback plan",
        },
      ],
      latencyMs: 1234,
    });

    expect(store.rows).toHaveLength(1);
    const row = store.rows[0];
    expect(row.bank).toBe("mc-jarvis");
    expect(row.source).toBe("hindsight");
    expect(row.result_count).toBe(1);
    expect(row.latency_ms).toBe(1234);
    expect(row.was_used).toBeNull();
    expect(row.task_id).toBeNull();
    const snippets = JSON.parse(row.result_snippets);
    expect(snippets.length).toBeGreaterThan(0);
    expect(snippets[0]).toContain("migration deadline");
  });

  it("logs zero-result recalls (still informative)", () => {
    logRecall({
      bank: "mc-operational",
      query: "nonexistent topic",
      source: "sqlite-fallback",
      results: [],
      latencyMs: 50,
    });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].result_count).toBe(0);
    expect(JSON.parse(store.rows[0].result_snippets)).toEqual([]);
  });

  it("truncates very long queries to 500 chars", () => {
    logRecall({
      bank: "mc-jarvis",
      query: "a".repeat(2000),
      source: "hindsight",
      results: [],
      latencyMs: 100,
    });
    expect(store.rows[0].query.length).toBe(500);
  });

  it("persists excludedCount when supplied (recall-side filter audit)", () => {
    logRecall({
      bank: "mc-jarvis",
      query: "test",
      source: "hindsight",
      results: [{ content: "x".repeat(60) }],
      latencyMs: 100,
      excludedCount: 7,
    });
    expect(store.rows[0].excluded_count).toBe(7);
  });

  it("defaults excludedCount to 0 when omitted (back-compat)", () => {
    logRecall({
      bank: "mc-jarvis",
      query: "test",
      source: "hindsight",
      results: [],
      latencyMs: 100,
    });
    expect(store.rows[0].excluded_count).toBe(0);
  });

  it("normalizes whitespace + redacts secrets in query (I3 + W3)", () => {
    logRecall({
      bank: "mc-jarvis",
      query: "lookup\n\n  the  token sk-abcdefghij1234567890XYZ  please",
      source: "hindsight",
      results: [],
      latencyMs: 100,
    });
    const q = store.rows[0].query;
    expect(q).not.toContain("\n");
    expect(q).not.toMatch(/\s{2,}/);
    expect(q).not.toContain("sk-abcdefghij");
    expect(q).toContain("[REDACTED-OPENAI-LIKE]");
  });

  it("does not throw if DB write fails", () => {
    const original = mockDb.prepare;
    mockDb.prepare = (() => {
      throw new Error("DB exploded");
    }) as typeof mockDb.prepare;
    expect(() =>
      logRecall({
        bank: "mc-jarvis",
        query: "q",
        source: "hindsight",
        results: [],
        latencyMs: 100,
      }),
    ).not.toThrow();
    mockDb.prepare = original;
  });
});

describe("markRecallUtility", () => {
  it("returns 0/0 when no unmatched rows", () => {
    const result = markRecallUtility({
      taskId: "task-1",
      responseText: "anything",
    });
    expect(result).toEqual({ updated: 0, used: 0 });
  });

  it("marks was_used=1 when any snippet appears in response", () => {
    logRecall({
      bank: "mc-jarvis",
      query: "migration",
      source: "hindsight",
      results: [
        {
          content:
            "The user mentioned the migration deadline is set for friday next week",
        },
      ],
      latencyMs: 1000,
    });

    const result = markRecallUtility({
      taskId: "task-1",
      // Response quotes the recalled fact verbatim — what we want was_used=1 to mean
      responseText:
        "Confirmed: The user mentioned the migration deadline is set for friday next week. Will prep accordingly.",
    });

    expect(result.updated).toBe(1);
    expect(result.used).toBe(1);
    expect(store.rows[0].was_used).toBe(1);
    expect(store.rows[0].task_id).toBe("task-1");
    expect(store.rows[0].used_count).toBeGreaterThan(0);
  });

  it("marks was_used=0 when no snippet appears", () => {
    logRecall({
      bank: "mc-jarvis",
      query: "rocket fuel",
      source: "hindsight",
      results: [
        {
          content:
            "Liquid hydrogen and oxygen react to produce thrust in rocket engines",
        },
      ],
      latencyMs: 100,
    });

    const result = markRecallUtility({
      taskId: "task-2",
      responseText: "Today is sunny and the cat slept on the porch",
    });

    expect(result.updated).toBe(1);
    expect(result.used).toBe(0);
    expect(store.rows[0].was_used).toBe(0);
    expect(store.rows[0].task_id).toBe("task-2");
  });

  it("is case-insensitive", () => {
    logRecall({
      bank: "mc-jarvis",
      query: "x",
      source: "hindsight",
      results: [
        {
          content: "The MIGRATION DEADLINE is friday next week per legal",
        },
      ],
      latencyMs: 100,
    });

    const result = markRecallUtility({
      taskId: "task-3",
      responseText:
        "ok i'll handle the migration deadline is friday next week per legal item asap",
    });

    expect(result.used).toBe(1);
  });

  it("ignores unmatched rows older than the window", () => {
    logRecall({
      bank: "mc-jarvis",
      query: "old",
      source: "hindsight",
      results: [
        { content: "ancient memory content that should not be considered now" },
      ],
      latencyMs: 100,
    });

    // Force the row's created_at to look 2 minutes old
    store.rows[0].created_at = new Date(Date.now() - 120_000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);

    const result = markRecallUtility({
      taskId: "task-4",
      responseText:
        "ancient memory content that should not be considered now in any way",
      windowMs: 60_000,
    });

    expect(result.updated).toBe(0);
    expect(store.rows[0].was_used).toBeNull();
  });

  it("is idempotent — second call does not re-claim already-marked rows", () => {
    logRecall({
      bank: "mc-jarvis",
      query: "x",
      source: "hindsight",
      results: [
        { content: "the migration deadline is friday next week per legal" },
      ],
      latencyMs: 100,
    });

    const r1 = markRecallUtility({
      taskId: "task-5",
      responseText: "the migration deadline is friday next week per legal",
    });
    expect(r1.updated).toBe(1);

    const r2 = markRecallUtility({
      taskId: "task-different",
      responseText: "the migration deadline is friday next week per legal",
    });
    expect(r2.updated).toBe(0);
    // task_id was claimed by the first call
    expect(store.rows[0].task_id).toBe("task-5");
  });

  it("ignores snippets shorter than SNIPPET_MIN_CHARS", () => {
    // Manually plant a row with a too-short snippet that happens to appear in response
    store.rows.push({
      id: store.nextId++,
      created_at: new Date().toISOString().replace("T", " ").slice(0, 19),
      bank: "mc-jarvis",
      query: "x",
      source: "hindsight",
      result_count: 1,
      result_snippets: JSON.stringify(["short"]),
      latency_ms: 100,
      excluded_count: 0,
      was_used: null,
      used_count: null,
      task_id: null,
      checked_at: null,
    });

    const result = markRecallUtility({
      taskId: "task-6",
      responseText: "short response that contains short",
    });

    expect(result.updated).toBe(1);
    expect(result.used).toBe(0); // snippet too short to count
  });

  it("counts multiple snippet matches", () => {
    logRecall({
      bank: "mc-jarvis",
      query: "x",
      source: "hindsight",
      results: [
        {
          content:
            "the migration deadline is friday and the rollback plan must be approved by legal".repeat(
              2,
            ),
        },
      ],
      latencyMs: 100,
    });

    const result = markRecallUtility({
      taskId: "task-7",
      responseText:
        "ok the migration deadline is friday and the rollback plan must be approved by legal — confirming both",
    });

    expect(result.used).toBe(1);
    expect(store.rows[0].used_count).toBeGreaterThanOrEqual(1);
  });

  it("does not double-claim across concurrent sweeps (W4)", () => {
    logRecall({
      bank: "mc-jarvis",
      query: "race",
      source: "hindsight",
      results: [
        {
          content:
            "this content fragment is unique enough to discriminate across turns reliably for the test",
        },
      ],
      latencyMs: 100,
    });

    const r1 = markRecallUtility({
      taskId: "task-first",
      responseText:
        "this content fragment is unique enough to discriminate across turns reliably for the test",
    });
    const r2 = markRecallUtility({
      taskId: "task-second",
      responseText:
        "this content fragment is unique enough to discriminate across turns reliably for the test",
    });

    expect(r1.updated).toBe(1);
    expect(r2.updated).toBe(0);
    expect(store.rows[0].task_id).toBe("task-first");
  });

  it("handles malformed result_snippets JSON gracefully", () => {
    store.rows.push({
      id: store.nextId++,
      created_at: new Date().toISOString().replace("T", " ").slice(0, 19),
      bank: "mc-jarvis",
      query: "x",
      source: "hindsight",
      result_count: 0,
      result_snippets: "not valid json",
      latency_ms: 100,
      excluded_count: 0,
      was_used: null,
      used_count: null,
      task_id: null,
      checked_at: null,
    });

    expect(() =>
      markRecallUtility({
        taskId: "task-8",
        responseText: "anything",
      }),
    ).not.toThrow();

    expect(store.rows[0].was_used).toBe(0);
  });
});
