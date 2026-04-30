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
  match_type: string | null;
  overlap_score: number | null;
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
            match_type: null,
            overlap_score: null,
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
          const [wasUsed, usedCount, taskId, matchType, overlapScore, id] =
            args as [number, number, string, string, number, number];
          const row = store.rows.find((r) => r.id === id && r.was_used == null);
          if (!row) return { changes: 0 };
          row.was_used = wasUsed;
          row.used_count = usedCount;
          row.task_id = taskId;
          row.match_type = matchType;
          row.overlap_score = overlapScore;
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
  extractContentTokens,
  logRecall,
  markRecallUtility,
  redactSecrets,
  SNIPPET_MAX_CHARS,
  tokenOverlap,
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
      match_type: null,
      overlap_score: null,
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
      match_type: null,
      overlap_score: null,
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

// ---------------------------------------------------------------------------
// Ship B (2026-04-30): token-overlap matcher
// ---------------------------------------------------------------------------

describe("extractContentTokens", () => {
  it("returns lowercased, length-≥4, stopword-stripped tokens", () => {
    const tokens = extractContentTokens(
      "The migration deadline is set for Friday next week",
    );
    // Content tokens (length ≥4, not in stopwords) should remain.
    // 'next' and 'week' are length 4 and not in the curated stopword list,
    // so they survive — "next" is borderline filler but rare enough to keep.
    expect(tokens.has("migration")).toBe(true);
    expect(tokens.has("deadline")).toBe(true);
    expect(tokens.has("friday")).toBe(true);
    expect(tokens.has("week")).toBe(true);
    // Length<4 always filtered
    expect(tokens.has("the")).toBe(false);
    expect(tokens.has("is")).toBe(false);
    expect(tokens.has("for")).toBe(false);
    expect(tokens.has("set")).toBe(false);
  });

  it("strips diacritics so publicación matches publicacion", () => {
    const a = extractContentTokens("La publicación es semanal");
    const b = extractContentTokens("La publicacion es semanal");
    expect(a.has("publicacion")).toBe(true);
    expect(b.has("publicacion")).toBe(true);
  });

  it("filters Spanish stopwords (esto, este, esta, etc)", () => {
    const tokens = extractContentTokens(
      "Esto es como cuando muchos usuarios tienen ese mismo problema",
    );
    expect(tokens.has("esto")).toBe(false);
    expect(tokens.has("como")).toBe(false);
    expect(tokens.has("cuando")).toBe(false);
    expect(tokens.has("muchos")).toBe(false);
    expect(tokens.has("mismo")).toBe(false);
    expect(tokens.has("usuarios")).toBe(true);
    expect(tokens.has("problema")).toBe(true);
  });

  it("dedupes repeated tokens", () => {
    const tokens = extractContentTokens(
      "williams williams radar radar journal",
    );
    expect(tokens.size).toBe(3);
    expect([...tokens].sort()).toEqual(["journal", "radar", "williams"]);
  });

  it("treats punctuation and whitespace as separators", () => {
    const tokens = extractContentTokens(
      "command: deploy.sh; restart;\twatch_logs",
    );
    expect(tokens.has("command")).toBe(true);
    expect(tokens.has("deploy")).toBe(true);
    expect(tokens.has("restart")).toBe(true);
    expect(tokens.has("watch_logs")).toBe(false); // underscore IS a separator → "watch" + "logs"
    expect(tokens.has("watch")).toBe(true);
    expect(tokens.has("logs")).toBe(true);
  });

  it("returns empty set for short or empty input", () => {
    expect(extractContentTokens("").size).toBe(0);
    expect(extractContentTokens("hi").size).toBe(0);
    expect(extractContentTokens("the and").size).toBe(0);
  });
});

describe("tokenOverlap", () => {
  it("returns full overlap (score=1) when snippet tokens all appear in response", () => {
    const r = tokenOverlap(
      "Williams Radar Journal — flujo de publicación",
      "Sobre Williams Radar Journal: el flujo de publicación es semanal",
    );
    // tokens: williams, radar, journal, flujo, publicacion → 5 in snippet
    expect(r.overlap).toBe(5);
    expect(r.score).toBe(1);
  });

  it("returns 0 when no content tokens overlap", () => {
    const r = tokenOverlap(
      "rocket fuel hydrogen oxygen propellant",
      "today is sunny and warm",
    );
    expect(r.overlap).toBe(0);
    expect(r.score).toBe(0);
  });

  it("matches paraphrase that uses different short words but same content tokens", () => {
    // Audit row 22 from this session: snippet says "Solo los viernes",
    // response says "Cron programado: 0 18 * * 5 — Viernes 18:00 MX".
    // Content tokens 'viernes' overlaps. Need ≥3 to count, so build a
    // realistic scenario.
    const snippet =
      "Williams Radar Journal — regla de publicación: Solo los viernes después de cierre";
    const response =
      "Confirmed Williams Radar — cron programado los viernes con publicación al cierre";
    const r = tokenOverlap(snippet, response);
    // Content tokens in snippet: williams, radar, journal, regla, publicacion, viernes, despues, cierre
    // Response has: williams, radar, viernes, publicacion, cierre, programado
    // Overlap: williams, radar, publicacion, viernes, cierre → 5
    expect(r.overlap).toBeGreaterThanOrEqual(4);
  });

  it("does NOT cross-match unrelated content with shared boilerplate", () => {
    // Audit row 21: snippet about shell_exec methodology, response about
    // Williams Radar. Should NOT match.
    const snippet =
      "El proceso de editar_archivo_y_ejecutar_shell incluye leer el archivo aplicar cambios";
    const response =
      "Williams Radar Journal cron está programado en mode viernes 18:00 hora MX";
    const r = tokenOverlap(snippet, response);
    expect(r.overlap).toBeLessThan(3);
  });

  it("handles empty snippet token set gracefully", () => {
    const r = tokenOverlap("", "anything");
    expect(r.overlap).toBe(0);
    expect(r.score).toBe(0);
  });
});

describe("markRecallUtility — dual signal (Ship B)", () => {
  it("sets match_type='verbatim' and overlap_score=1.0 on verbatim hit", () => {
    logRecall({
      bank: "mc-jarvis",
      query: "x",
      source: "hindsight",
      results: [
        {
          content:
            "The user mentioned the migration deadline is set for friday next week",
        },
      ],
      latencyMs: 100,
    });
    const result = markRecallUtility({
      taskId: "task-vb",
      responseText:
        "Confirmed: The user mentioned the migration deadline is set for friday next week.",
    });
    expect(result.used).toBe(1);
    expect(store.rows[0].match_type).toBe("verbatim");
    expect(store.rows[0].overlap_score).toBe(1);
  });

  it("sets match_type='token-overlap' on paraphrased content (audit row 19/20 case)", () => {
    // Real audit row 19 from 2026-04-30:
    //   Snippet: "Williams Radar Journal — Flujo de publicación: CONTENT_DIR=/root/claude/thewilli..."
    //   Response: "## Williams Radar Journal\n... thewilliamsradar-journal\n... publicación..."
    // Verbatim misses (response is structured markdown), token overlap fires.
    logRecall({
      bank: "mc-jarvis",
      query: "Háblame del Williams Radar Journal",
      source: "sqlite-fallback",
      results: [
        {
          content:
            "Williams Radar Journal — Flujo de publicación: CONTENT_DIR=/root/claude/thewilliamsradar-journal/content frontmatter title date slug",
        },
      ],
      latencyMs: 1155,
    });
    const result = markRecallUtility({
      taskId: "task-overlap",
      responseText:
        "## Williams Radar Journal\n\n**URL**: thewilliamsradar.com  \n**Repo**: EurekaMD-net/thewilliamsradar-journal\n\n### Arquitectura técnica\n- **CMS** publicación semanal con frontmatter title date slug",
    });
    expect(result.used).toBe(1);
    expect(store.rows[0].match_type).toBe("token-overlap");
    expect(store.rows[0].overlap_score).toBeGreaterThan(0);
    expect(store.rows[0].overlap_score).toBeLessThan(1);
  });

  it("sets match_type='none' on unrelated content (audit row 21 case)", () => {
    // Real audit row 21: Hindsight returned shell_exec methodology in
    // response to a Williams Radar polling question. Should NOT match.
    logRecall({
      bank: "mc-operational",
      query: "Verifica que el viernes el polling de Alpha Vantage",
      source: "hindsight",
      results: [
        {
          content:
            "El proceso de editar_archivo_y_ejecutar_shell incluye leer el archivo aplicar cambios revisar diff",
        },
      ],
      latencyMs: 3974,
    });
    const result = markRecallUtility({
      taskId: "task-none",
      responseText:
        "Williams Radar — Listo para W18. Cron programado los viernes 18:00 MX. PID 2425971 corriendo desde Apr 24.",
    });
    expect(result.used).toBe(0);
    expect(store.rows[0].match_type).toBe("none");
  });

  it("prefers verbatim over token-overlap when both could apply", () => {
    logRecall({
      bank: "mc-jarvis",
      query: "x",
      source: "hindsight",
      results: [
        {
          content:
            "the migration deadline is set for friday next week per legal",
        },
      ],
      latencyMs: 100,
    });
    const result = markRecallUtility({
      taskId: "task-prefer",
      // Response contains the snippet verbatim AND many tokens
      responseText:
        "the migration deadline is set for friday next week per legal — confirmed by counsel",
    });
    expect(result.used).toBe(1);
    expect(store.rows[0].match_type).toBe("verbatim");
    expect(store.rows[0].overlap_score).toBe(1);
  });

  it("threshold prevents trivial 1-2 token coincidences", () => {
    logRecall({
      bank: "mc-jarvis",
      query: "x",
      source: "hindsight",
      results: [
        {
          content:
            "The system implements observability through structured logging and metric collection",
        },
      ],
      latencyMs: 100,
    });
    // Response shares only 'system' content token (everything else is filler/short)
    const result = markRecallUtility({
      taskId: "task-thr",
      responseText: "the system is online",
    });
    expect(result.used).toBe(0);
    expect(store.rows[0].match_type).toBe("none");
  });

  it("stores best partial overlap_score even when no match (diagnostics)", () => {
    logRecall({
      bank: "mc-jarvis",
      query: "x",
      source: "hindsight",
      results: [
        {
          content:
            "Williams Radar runs polling against Alpha Vantage and computes Friday signals",
        },
      ],
      latencyMs: 100,
    });
    const result = markRecallUtility({
      taskId: "task-diag",
      // Two tokens overlap (williams, radar) — below threshold of 3 but >0
      responseText: "Williams Radar status check",
    });
    expect(result.used).toBe(0);
    expect(store.rows[0].match_type).toBe("none");
    // overlap_score reflects the best partial overlap as diagnostics
    expect(store.rows[0].overlap_score).toBeGreaterThan(0);
  });
});
