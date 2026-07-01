/**
 * V8.2 Phase 2 — decomposition tests (spec §7).
 *
 * Three surfaces:
 *  - `decomposeQuestion` (forced-tool LLM): mock `queryClaudeSdk` to invoke the
 *    `submit_decomposition` handler with synthetic angles (mirrors the S2
 *    critic test strategy). Asserts ≤3 angles across 10 questions, the >3
 *    rejection, question echo, injected clock, and the no-tool-call failure.
 *  - boundary-honoring retrieval (real in-memory DB, no LLM): seeds `tasks` and
 *    asserts status_in / date_from-to / exclude_completed / limit are honored.
 *  - append-only persistence: writes to a tmp baseDir; a second write lands on
 *    a versioned sibling, never overwriting the first.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryClaudeSdk } from "../../inference/claude-sdk.js";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import {
  decomposeQuestion,
  DecompositionError,
  retrieveForAngle,
  retrieveTasksForBoundaries,
  retrieveKbForQuery,
  gatherEvidence,
  saveDecomposition,
  MAX_ANGLE_LIMIT,
  DEFAULT_ANGLE_LIMIT,
  DECOMPOSE_SYSTEM_PROMPT,
} from "./decompose.js";
import { strategicVoiceSystemPrompt } from "./strategic-voice.js";
import type { Decomposition, DecompositionAngle } from "./types.js";

vi.mock("../../inference/claude-sdk.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../inference/claude-sdk.js")
  >("../../inference/claude-sdk.js");
  return { ...actual, queryClaudeSdk: vi.fn() };
});

const mockQuery = vi.mocked(queryClaudeSdk);

const SDK_RESULT = {
  text: "",
  toolCalls: ["submit_decomposition"],
  numTurns: 1,
  usage: {
    promptTokens: 100,
    completionTokens: 40,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  },
  costUsd: 0.002,
  costAuthoritative: true,
  durationMs: 50,
  model: "claude-sonnet-4-6",
};

const NOW = "2026-06-01T12:00:00.000Z";

function angle(
  overrides: Partial<DecompositionAngle> = {},
): DecompositionAngle {
  return {
    objective: overrides.objective ?? "what is the state of the CRM pilot?",
    tool_guidance: overrides.tool_guidance ?? ["crm_query"],
    boundaries: overrides.boundaries ?? {},
  };
}

/** Simulate the SDK invoking submit_decomposition before returning. */
function mockDecompositionCalled(angles: DecompositionAngle[]) {
  mockQuery.mockImplementationOnce(async (opts) => {
    const t = opts.extraTools?.[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (t) await (t as any).handler({ angles }, {});
    return SDK_RESULT;
  });
}

/** Simulate the degraded path: SDK returns without invoking the tool. */
function mockNoToolCall() {
  mockQuery.mockResolvedValueOnce({ ...SDK_RESULT, toolCalls: [] });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("decomposeQuestion — forced tool", () => {
  it("returns ≤3 angles for 10 different questions, echoing question + injected clock", async () => {
    const questions = Array.from({ length: 10 }, (_, i) => `question ${i}?`);
    for (const q of questions) {
      // model returns 1-3 angles (vary by length of question to avoid a static run)
      const n = (q.length % 3) + 1;
      mockDecompositionCalled(Array.from({ length: n }, () => angle()));
      const d = await decomposeQuestion(q, "ctx", { nowIso: NOW });
      expect(d.angles.length).toBeGreaterThanOrEqual(1);
      expect(d.angles.length).toBeLessThanOrEqual(3);
      expect(d.question).toBe(q);
      expect(d.generated_at).toBe(NOW);
    }
  });

  it("rejects a 4-angle decomposition at the function boundary (≤3 cap)", async () => {
    mockDecompositionCalled([angle(), angle(), angle(), angle()]);
    await expect(
      decomposeQuestion("q?", "ctx", { nowIso: NOW }),
    ).rejects.toThrow(DecompositionError);
  });

  it("throws DecompositionError when the model emits no tool call", async () => {
    mockNoToolCall();
    await expect(decomposeQuestion("q?", "ctx")).rejects.toThrow(
      /did not call submit_decomposition/,
    );
  });

  it("throws DecompositionError when the SDK call fails", async () => {
    mockQuery.mockRejectedValueOnce(new Error("api down"));
    await expect(decomposeQuestion("q?", "ctx")).rejects.toThrow(
      /decomposition call failed: api down/,
    );
  });

  it("does not call the model when the caller signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      decomposeQuestion("q?", "ctx", { signal: ac.signal }),
    ).rejects.toThrow(DecompositionError);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("uses the strategic-voice block as systemPrompt; task text + question lead the user prompt (§10 cache prefix)", async () => {
    let captured: { system: string; prompt: string } | null = null;
    mockQuery.mockImplementationOnce(async (opts) => {
      captured = { system: opts.systemPrompt, prompt: opts.prompt };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const t = opts.extraTools?.[0] as any;
      if (t) await t.handler({ angles: [angle()] }, {});
      return SDK_RESULT;
    });

    await decomposeQuestion("ship the pilot?", "pilot ctx", { nowIso: NOW });

    expect(captured).not.toBeNull();
    const c = captured!;
    // systemPrompt is the shared identity block — byte-identical to every other
    // V8.2 call — not the decomposition task text.
    expect(c.system).toBe(strategicVoiceSystemPrompt());
    expect(c.system).toContain("Strategic-voice principles");
    expect(c.system).not.toContain("retrieval ANGLES");
    // Decomposition instructions + the question/context now lead the user turn.
    expect(c.prompt).toContain(DECOMPOSE_SYSTEM_PROMPT);
    expect(c.prompt).toContain("ship the pilot?");
    expect(c.prompt).toContain("pilot ctx");
  });
});

describe("retrieveTasksForBoundaries — boundary filters honored", () => {
  beforeEach(() => {
    initDatabase(":memory:");
    const db = getDatabase();
    const insert = db.prepare(
      `INSERT INTO tasks (task_id, title, description, status, priority, created_at)
       VALUES (?,?,?,?,?,?)`,
    );
    // task_id, title, status, priority, created_at
    insert.run(
      "t-open-1",
      "open one",
      "d",
      "blocked",
      "high",
      "2026-05-20T00:00:00.000Z",
    );
    insert.run(
      "t-open-2",
      "open two",
      "d",
      "pending",
      "medium",
      "2026-05-25T00:00:00.000Z",
    );
    insert.run(
      "t-done-1",
      "done one",
      "d",
      "completed",
      "low",
      "2026-05-22T00:00:00.000Z",
    );
    insert.run(
      "t-cancel-1",
      "cancel one",
      "d",
      "cancelled",
      "low",
      "2026-05-28T00:00:00.000Z",
    );
    insert.run(
      "t-run-1",
      "running one",
      "d",
      "running",
      "critical",
      "2026-05-30T00:00:00.000Z",
    );
    // created_at BEFORE the date-window used by the date test so it only
    // affects exclude_completed / count assertions.
    insert.run(
      "t-failed-1",
      "failed one",
      "d",
      "failed",
      "high",
      "2026-05-18T00:00:00.000Z",
    );
  });
  afterEach(() => {
    closeDatabase();
  });

  function ids(refs: { id: string }[]): string[] {
    return refs.map((r) => r.id).sort();
  }

  it("honors status_in", () => {
    const refs = retrieveTasksForBoundaries(
      { status_in: ["blocked", "pending"] },
      { db: getDatabase(), nowIso: NOW },
    );
    expect(ids(refs)).toEqual(["t-open-1", "t-open-2"]);
    expect(refs[0].kind).toBe("task");
    expect(refs[0].retrieved_at).toBe(NOW);
    expect(refs.find((r) => r.id === "t-open-1")?.excerpt).toBe(
      "[blocked/high] open one",
    );
  });

  it("honors date_from / date_to (inclusive, on created_at)", () => {
    const refs = retrieveTasksForBoundaries(
      {
        date_from: "2026-05-22T00:00:00.000Z",
        date_to: "2026-05-28T00:00:00.000Z",
      },
      { db: getDatabase(), nowIso: NOW },
    );
    expect(ids(refs)).toEqual(["t-cancel-1", "t-done-1", "t-open-2"]);
  });

  it("honors exclude_completed (drops ALL terminal states incl. failed)", () => {
    const refs = retrieveTasksForBoundaries(
      { exclude_completed: true },
      { db: getDatabase(), nowIso: NOW },
    );
    // completed, cancelled AND failed dropped (qa-W2); only in-flight remain
    expect(ids(refs)).toEqual(["t-open-1", "t-open-2", "t-run-1"]);
    expect(refs.find((r) => r.id === "t-failed-1")).toBeUndefined();
  });

  it("returns newest-first and honors an explicit limit", () => {
    const refs = retrieveTasksForBoundaries(
      { limit: 2 },
      { db: getDatabase(), nowIso: NOW },
    );
    // newest two by created_at: t-run-1 (05-30), t-cancel-1 (05-28)
    expect(refs.map((r) => r.id)).toEqual(["t-run-1", "t-cancel-1"]);
  });

  it("caps an over-large limit at MAX_ANGLE_LIMIT", () => {
    const refs = retrieveTasksForBoundaries(
      { limit: 9999 },
      { db: getDatabase(), nowIso: NOW },
    );
    expect(refs.length).toBeLessThanOrEqual(MAX_ANGLE_LIMIT);
    expect(refs.length).toBe(6); // only 6 seeded
  });

  it("retrieveForAngle delegates to the task boundary pass", () => {
    const refs = retrieveForAngle(
      angle({ boundaries: { status_in: ["running"] } }),
      { db: getDatabase(), nowIso: NOW },
    );
    expect(ids(refs)).toEqual(["t-run-1"]);
  });

  it("DEFAULT_ANGLE_LIMIT applies when limit omitted", () => {
    expect(DEFAULT_ANGLE_LIMIT).toBeLessThanOrEqual(MAX_ANGLE_LIMIT);
    const refs = retrieveTasksForBoundaries(
      {},
      { db: getDatabase(), nowIso: NOW },
    );
    expect(refs.length).toBe(6);
  });
});

describe("gatherEvidence — dedup across angles", () => {
  beforeEach(() => {
    initDatabase(":memory:");
    getDatabase()
      .prepare(
        `INSERT INTO tasks (task_id, title, description, status, priority, created_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run("t-1", "shared", "d", "blocked", "high", "2026-05-20T00:00:00.000Z");
  });
  afterEach(() => {
    closeDatabase();
  });

  it("returns one ledger entry when two angles surface the same task", () => {
    const decomposition: Decomposition = {
      question: "q?",
      angles: [
        angle({ boundaries: { status_in: ["blocked"] } }),
        angle({ boundaries: { status_in: ["blocked"] } }),
      ],
      generated_at: NOW,
    };
    const ledger = gatherEvidence(decomposition, {
      db: getDatabase(),
      nowIso: NOW,
    });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].id).toBe("t-1");
  });
});

describe("retrieveKbForQuery + gatherEvidence KB pass (Phase 2 — ledger↔citation asymmetry)", () => {
  beforeEach(() => {
    initDatabase(":memory:");
    const db = getDatabase();
    // KB files (FTS populated via jarvis_files trigger).
    const kb = db.prepare(
      `INSERT INTO jarvis_files (id, path, title, content) VALUES (?,?,?,?)`,
    );
    kb.run(
      "k1",
      "projects/pipesong/README.md",
      "PipeSong",
      "Voice AI infrastructure. Phase 4a is the documented next step.",
    );
    kb.run(
      "k2",
      "NorthStar/priority-snapshot.md",
      "Priority snapshot",
      "PipeSong prioritized for the salon voice outreach funnel.",
    );
    kb.run(
      "k3",
      "projects/vlcms/README.md",
      "Very Light CMS",
      "A Hono + SQLite content service — unrelated to the voice stack.",
    );
    // One task, so gatherEvidence has a task ref to merge the KB pass with.
    db.prepare(
      `INSERT INTO tasks (task_id, title, description, status, priority, created_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(
      "t-ps",
      "pipesong bringup",
      "d",
      "blocked",
      "high",
      "2026-05-20T00:00:00.000Z",
    );
  });
  afterEach(() => {
    closeDatabase();
  });

  it("returns kb_entry refs (id = path) for the subject, bm25-ranked, excluding non-matches", () => {
    const refs = retrieveKbForQuery("pipesong", {
      db: getDatabase(),
      nowIso: NOW,
    });
    expect(refs.length).toBeGreaterThanOrEqual(2);
    expect(refs.every((r) => r.kind === "kb_entry")).toBe(true);
    const ids = refs.map((r) => r.id);
    expect(ids).toContain("projects/pipesong/README.md");
    expect(ids).toContain("NorthStar/priority-snapshot.md");
    expect(ids).not.toContain("projects/vlcms/README.md"); // non-match excluded
    expect(refs[0].retrieved_at).toBe(NOW);
    expect(refs[0].excerpt.length).toBeGreaterThan(0);
  });

  it("returns [] on an empty-after-sanitization query (no alnum tokens)", () => {
    expect(retrieveKbForQuery("  @#$ -- ", { db: getDatabase() })).toEqual([]);
  });

  it("returns [] when nothing in the KB matches", () => {
    expect(
      retrieveKbForQuery("nonexistentsubjectxyz", { db: getDatabase() }),
    ).toEqual([]);
  });

  it("honors an explicit limit (cap ≤ MAX_KB_LIMIT)", () => {
    const refs = retrieveKbForQuery("pipesong", {
      db: getDatabase(),
      limit: 1,
    });
    expect(refs).toHaveLength(1);
  });

  it("gatherEvidence merges the subject KB pass into the task ledger", () => {
    const decomposition: Decomposition = {
      question: "what is the state of pipesong?",
      angles: [angle({ boundaries: { status_in: ["blocked"] } })],
      generated_at: NOW,
    };
    const ledger = gatherEvidence(decomposition, {
      db: getDatabase(),
      nowIso: NOW,
      subject: "pipesong",
    });
    const kinds = new Set(ledger.map((r) => r.kind));
    expect(kinds.has("task")).toBe(true);
    expect(kinds.has("kb_entry")).toBe(true);
    expect(ledger.some((r) => r.id === "t-ps")).toBe(true);
    expect(ledger.some((r) => r.id === "projects/pipesong/README.md")).toBe(
      true,
    );
  });

  it("gatherEvidence stays task-only when no subject is provided (backward-compatible)", () => {
    const decomposition: Decomposition = {
      question: "q?",
      angles: [angle({ boundaries: { status_in: ["blocked"] } })],
      generated_at: NOW,
    };
    const ledger = gatherEvidence(decomposition, {
      db: getDatabase(),
      nowIso: NOW,
    });
    expect(ledger.every((r) => r.kind === "task")).toBe(true);
    expect(ledger.some((r) => r.kind === "kb_entry")).toBe(false);
  });

  it("degrades to [] (never throws) when jarvis_files_fts is absent (qa-W2)", () => {
    getDatabase().exec("DROP TABLE jarvis_files_fts");
    expect(() =>
      retrieveKbForQuery("pipesong", { db: getDatabase() }),
    ).not.toThrow();
    expect(retrieveKbForQuery("pipesong", { db: getDatabase() })).toEqual([]);
  });
});

describe("saveDecomposition — append-only ADR", () => {
  let baseDir: string;
  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "mc-decisions-"));
  });
  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  const decomposition: Decomposition = {
    question: "q?",
    angles: [angle()],
    generated_at: NOW,
  };

  it("writes decisions/<id>/decomposition.json and returns the path", () => {
    const p = saveDecomposition("jd-1", decomposition, { baseDir });
    expect(p).toBe(join(baseDir, "jd-1", "decomposition.json"));
    expect(existsSync(p)).toBe(true);
    expect(JSON.parse(readFileSync(p, "utf8")).question).toBe("q?");
  });

  it("never overwrites — a second save lands on a versioned sibling", () => {
    const p1 = saveDecomposition("jd-1", decomposition, { baseDir });
    const p2 = saveDecomposition(
      "jd-1",
      { ...decomposition, question: "second?" },
      { baseDir },
    );
    expect(p2).toBe(join(baseDir, "jd-1", "decomposition.v2.json"));
    // original preserved
    expect(JSON.parse(readFileSync(p1, "utf8")).question).toBe("q?");
    expect(JSON.parse(readFileSync(p2, "utf8")).question).toBe("second?");
  });

  it("rejects an unsafe judgmentId before touching the filesystem (qa-R2)", () => {
    for (const bad of ["../evil", "a/b", "", "..", "x\0y"]) {
      expect(() => saveDecomposition(bad, decomposition, { baseDir })).toThrow(
        /unsafe judgmentId/,
      );
    }
    // the traversal target was never created
    expect(existsSync(join(baseDir, "..", "evil"))).toBe(false);
  });
});
