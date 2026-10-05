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
  retrieveRecentDayLogs,
  gatherEvidence,
  saveDecomposition,
  MAX_ANGLE_LIMIT,
  MAX_KB_LIMIT,
  DEFAULT_ANGLE_LIMIT,
  DECOMPOSE_SYSTEM_PROMPT,
} from "./decompose.js";
import { strategicVoiceSystemPrompt } from "./strategic-voice.js";
import { invalidateSecretRefs } from "../secret-refs.js";
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

  it("retrieves accented-subject KB files for an accented query (#153 regression)", () => {
    // The pre-Unicode sanitizer split "Ángeles" into the unmatchable token
    // "ngeles", so the AUTHOR's ledger never contained the entity's own README
    // and the judgment mis-cited or left the claim unsupported (judgment #153).
    getDatabase()
      .prepare(
        `INSERT INTO jarvis_files (id, path, title, content) VALUES (?,?,?,?)`,
      )
      .run(
        "k4",
        "projects/grupo-angeles/README.md",
        "Grupo Ángeles",
        "Minuta de la reunión con Grupo Ángeles, agosto 2026.",
      );
    const ids = retrieveKbForQuery("Grupo Ángeles", {
      db: getDatabase(),
      nowIso: NOW,
    }).map((r) => r.id);
    expect(ids).toContain("projects/grupo-angeles/README.md");
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

describe("retrieveRecentDayLogs + gatherEvidence day-log pass (staleness gap)", () => {
  beforeEach(() => {
    initDatabase(":memory:");
    const db = getDatabase();
    const kb = db.prepare(
      `INSERT INTO jarvis_files (id, path, title, content) VALUES (?,?,?,?)`,
    );
    // Three day-logs mention the subject (varying dates) + one that does not +
    // one non-day-log KB file that mentions it (must NOT be picked by this pass).
    kb.run(
      "d1",
      "logs/day-logs/2026-06-17.md",
      "day 06-17",
      "Kicked off salon-voice-outreach scoping.",
    );
    kb.run(
      "d2",
      "logs/day-logs/2026-06-27.md",
      "day 06-27",
      "Actualiza el kb de salon-voice-outreach con el repo. Stage 1 shipped.",
    );
    kb.run(
      "d3",
      "logs/day-logs/2026-06-28.md",
      "day 06-28",
      "vlcrm extraction for salon-voice-outreach.",
    );
    kb.run(
      "d4",
      "logs/day-logs/2026-06-20.md",
      "day 06-20",
      "Worked on an unrelated project only.",
    );
    kb.run(
      "k-readme",
      "projects/salon-voice-outreach/README.md",
      "SVO",
      "salon-voice-outreach README.",
    );
    // A non-date file INSIDE the day-log namespace (kb-reindex could ingest one).
    // Must be excluded: in DESC order 'R' > '2', so an unanchored GLOB would sort
    // it above every date and displace the newest real logs (W1 regression guard).
    kb.run(
      "dl-readme",
      "logs/day-logs/README.md",
      "index",
      "day-log index for salon-voice-outreach and others.",
    );
  });
  afterEach(() => {
    closeDatabase();
  });

  it("returns day-logs mentioning the subject, NEWEST-first, honoring the limit", () => {
    const refs = retrieveRecentDayLogs("salon-voice-outreach", {
      db: getDatabase(),
      nowIso: NOW,
      limit: 2,
    });
    expect(refs.map((r) => r.id)).toEqual([
      "logs/day-logs/2026-06-28.md",
      "logs/day-logs/2026-06-27.md",
    ]); // newest 2; 06-17 dropped by limit
    expect(refs.every((r) => r.kind === "kb_entry")).toBe(true);
    expect(refs[0].excerpt.startsWith("day-log 2026-06-28")).toBe(true);
    expect(refs[0].retrieved_at).toBe(NOW);
  });

  it("excludes day-logs that do NOT mention the subject, and non-day-log paths", () => {
    const ids = retrieveRecentDayLogs("salon-voice-outreach", {
      db: getDatabase(),
    }).map((r) => r.id);
    expect(ids).not.toContain("logs/day-logs/2026-06-20.md"); // no mention
    expect(ids).not.toContain("projects/salon-voice-outreach/README.md"); // not a day-log
    expect(ids).not.toContain("logs/day-logs/README.md"); // non-date file in the namespace
  });

  it("returns [] on a blank subject", () => {
    expect(retrieveRecentDayLogs("   ", { db: getDatabase() })).toEqual([]);
  });

  it("gatherEvidence appends the day-log pass when a subject is set", () => {
    const decomposition: Decomposition = {
      question: "state of svo?",
      angles: [angle({ boundaries: { status_in: ["blocked"] } })],
      generated_at: NOW,
    };
    const ledger = gatherEvidence(decomposition, {
      db: getDatabase(),
      nowIso: NOW,
      subject: "salon-voice-outreach",
    });
    expect(ledger.some((r) => r.id === "logs/day-logs/2026-06-28.md")).toBe(
      true,
    );
  });

  it("degrades to [] (never throws) when jarvis_files is absent", () => {
    getDatabase().exec("DROP TABLE jarvis_files_fts; DROP TABLE jarvis_files;");
    expect(() =>
      retrieveRecentDayLogs("salon-voice-outreach", { db: getDatabase() }),
    ).not.toThrow();
    expect(
      retrieveRecentDayLogs("salon-voice-outreach", { db: getDatabase() }),
    ).toEqual([]);
  });
});

describe("retrieveRecentDayLogs — subject resolved to project slug/name, folded matching", () => {
  // Synthetic names only (public repo).
  const DL = "logs/day-logs/";
  const SNIP_CONTENT =
    "Cafe\u0301 ".repeat(20) +
    "Ánimo. Notes before it: TORRE ÑANDÚ milestone reached, " +
    "x".repeat(200);
  beforeEach(() => {
    initDatabase(":memory:");
    const db = getDatabase();
    const p = db.prepare(
      `INSERT INTO projects (id, slug, name) VALUES (?,?,?)`,
    );
    p.run("p1", "zorblat", "Zorblat - Synthetic Voice Layer");
    p.run("p2", "krellwick", "Krellwick - Tidal Archive Engine");
    p.run("p3", "circulo-ambar", "Impulsar Círculo Ámbar");
    p.run("p4", "tn-tower", "Torre Ñandú");
    p.run("p5", "quillfeather", "Quillfeather Ledger");
    const kb = db.prepare(
      `INSERT INTO jarvis_files (id, path, title, content) VALUES (?,?,?,?)`,
    );
    const day = (date: string, content: string) =>
      kb.run(`d-${date}`, `${DL}${date}.md`, `day ${date}`, content);
    day(
      "2026-07-01",
      "Kickoff for Zorblat - Synthetic Voice Layer with the team.",
    );
    day(
      "2026-07-02",
      "Reviewed the Synthetic Voice Layer docs; impulsar the ambar palette later.",
    );
    day("2026-07-03", "circulo ambar review done.");
    day("2026-07-04", "CÍRCULO ÁMBAR launch prep.");
    day("2026-07-05", "Pushed zorblat fixes.");
    day("2026-07-06", "quillfeather sync only.");
    day("2026-07-07", "krellwick bump.");
    day("2026-07-08", "zorblat follow-up.");
    day("2026-07-09", "boveda gris backup check.");
    day("2026-07-10", SNIP_CONTENT);
    kb.run("dl-notes", `${DL}zorblat-notes.md`, "notes", "zorblat notes");
  });
  afterEach(() => {
    closeDatabase();
  });
  const ids = (subject: string, limit?: number) =>
    retrieveRecentDayLogs(subject, {
      db: getDatabase(),
      nowIso: NOW,
      limit,
    }).map((r) => r.id);

  it("display-name subject finds the newer slug-only logs, newest first", () => {
    expect(ids("Zorblat - Synthetic Voice Layer")).toEqual([
      `${DL}2026-07-08.md`, // slug only
      `${DL}2026-07-05.md`, // slug only
      `${DL}2026-07-01.md`, // full name
    ]);
  });

  it("display name absent verbatim from every log still matches via the slug", () => {
    expect(ids("Krellwick - Tidal Archive Engine")).toEqual([
      `${DL}2026-07-07.md`,
    ]);
  });

  it("matches across case and accents on both sides", () => {
    const r = ids("Impulsar Círculo Ámbar");
    expect(r).toContain(`${DL}2026-07-04.md`); // "CÍRCULO ÁMBAR"
    expect(r).toContain(`${DL}2026-07-03.md`); // "circulo ambar"
    expect(ids("Torre Ñandú")).toEqual([`${DL}2026-07-10.md`]); // "TORRE ÑANDÚ"
  });

  it("matches the spaced-slug form", () => {
    expect(ids("Impulsar Círculo Ámbar")).toEqual([
      `${DL}2026-07-04.md`,
      `${DL}2026-07-03.md`,
    ]);
  });

  it("a slug subject resolves the project and matches full-name-only logs", () => {
    expect(ids("tn-tower")).toEqual([`${DL}2026-07-10.md`]);
    expect(ids("  TN-Tower ")).toEqual([`${DL}2026-07-10.md`]);
  });

  it("no project row → raw subject, folded; other projects' slugs not pulled in", () => {
    expect(ids("Bóveda Gris")).toEqual([`${DL}2026-07-09.md`]);
    expect(ids("BOVEDA GRIS")).toEqual([`${DL}2026-07-09.md`]);
    expect(ids("Bóveda Gris")).not.toContain(`${DL}2026-07-06.md`);
  });

  it("does not match single words of a multi-word name", () => {
    expect(ids("Zorblat - Synthetic Voice Layer")).not.toContain(
      `${DL}2026-07-02.md`,
    );
    expect(ids("Impulsar Círculo Ámbar")).not.toContain(`${DL}2026-07-02.md`);
  });

  it("snippet is cut from the original text, not shifted by folding", () => {
    const [ref] = retrieveRecentDayLogs("Torre Ñandú", {
      db: getDatabase(),
      nowIso: NOW,
    });
    const at = SNIP_CONTENT.indexOf("TORRE ÑANDÚ");
    const snippet = SNIP_CONTENT.slice(at - 30, at - 30 + 160);
    expect(snippet.startsWith("Cafe\u0301 Ánimo.")).toBe(true); // sanity
    expect(ref.excerpt).toBe(`day-log 2026-07-10: …${snippet.trim()}…`);
  });

  it("works on the raw subject without a projects table; [] without jarvis_files", () => {
    getDatabase().exec("DROP TABLE projects");
    expect(ids("Bóveda Gris")).toEqual([`${DL}2026-07-09.md`]);
    expect(ids("Zorblat - Synthetic Voice Layer")).toEqual([
      `${DL}2026-07-01.md`,
    ]);
    getDatabase().exec("DROP TABLE jarvis_files_fts; DROP TABLE jarvis_files;");
    expect(ids("Bóveda Gris")).toEqual([]);
  });

  it("honors the limit newest-first and excludes non-date day-log paths", () => {
    expect(ids("zorblat", 2)).toEqual([
      `${DL}2026-07-08.md`,
      `${DL}2026-07-05.md`,
    ]);
    expect(ids("zorblat")).not.toContain(`${DL}zorblat-notes.md`);
  });

  const addDay = (date: string, content: unknown) =>
    getDatabase()
      .prepare(
        `INSERT INTO jarvis_files (id, path, title, content) VALUES (?,?,?,?)`,
      )
      .run(`x-${date}`, `${DL}${date}.md`, `day ${date}`, content);
  const addProject = (id: string, slug: string, name: string) =>
    getDatabase()
      .prepare(`INSERT INTO projects (id, slug, name) VALUES (?,?,?)`)
      .run(id, slug, name);

  it("matches terms only on word boundaries, never inside a longer word", () => {
    addProject("p6", "vex", "Vex - Signal Router");
    addDay("2026-08-01", "stopped the convex loops early, vexing.");
    addDay("2026-08-02", "vex shipped.");
    addDay("2026-08-03", "deploy notes (vex), done");
    addDay("2026-08-04", "rolled back vex");
    expect(ids("vex", 8)).toEqual([
      `${DL}2026-08-04.md`, // at text end
      `${DL}2026-08-03.md`, // followed by punctuation
      `${DL}2026-08-02.md`, // at text start
    ]);
  });

  it("a hyphen is a boundary: slug followed by -suffix still matches (accepted)", () => {
    addProject("p6", "vex", "Vex - Signal Router");
    addDay("2026-08-05", "merged the vex-suffix branch");
    expect(ids("vex")).toEqual([`${DL}2026-08-05.md`]);
  });

  it("skips a non-string (BLOB) content row without dropping the pass", () => {
    addDay("2026-08-06", Buffer.from("zorblat binary"));
    expect(ids("zorblat", 2)).toEqual([
      `${DL}2026-07-08.md`,
      `${DL}2026-07-05.md`,
    ]);
  });

  it("resolution prefers a slug match over a name match", () => {
    addProject("pb", "ndb", "Nova-Desk"); // inserted first: its NAME equals the subject
    addProject("pa", "nova-desk", "Nova Desk Alpha");
    addDay("2026-08-07", "Nova Desk Alpha status review.");
    addDay("2026-08-08", "ndb fixed.");
    expect(ids("nova-desk")).toEqual([`${DL}2026-08-07.md`]);
  });

  it("snippet anchors on the EARLIEST match across terms", () => {
    const content = `TORRE ÑANDÚ intro. ${"y".repeat(250)} then tn-tower deploy.`;
    addDay("2026-08-09", content);
    const [ref] = retrieveRecentDayLogs("tn-tower", { db: getDatabase() });
    expect(ref.excerpt).toBe(`day-log 2026-08-09: …${content.slice(0, 160)}…`);
  });

  it("caps an over-large limit at MAX_KB_LIMIT", () => {
    for (let d = 10; d < 20; d++) addDay(`2026-08-${d}`, `zorblat day ${d}`);
    expect(ids("zorblat", 50)).toHaveLength(MAX_KB_LIMIT);
  });

  it("matches a term containing regex metacharacters literally", () => {
    addProject("p7", "cpp-legacy", "C++ (Legacy) v2.0");
    addDay("2026-08-20", "migrated c++ (legacy) v2.0 today");
    addDay("2026-08-21", "migrated cxx (legacy) v2x0 today");
    expect(() => ids("C++ (Legacy) v2.0")).not.toThrow();
    expect(ids("C++ (Legacy) v2.0")).toEqual([`${DL}2026-08-20.md`]);
  });

  it("a non-ASCII letter glued to a term is not a word boundary", () => {
    // ø / ß survive folding (no NFD decomposition); ñ would fold to ASCII n.
    addDay("2026-08-22", "notes on øzorblat only");
    addDay("2026-08-23", "notes on zorblatß only");
    expect(ids("zorblat", 8)).not.toContain(`${DL}2026-08-22.md`);
    expect(ids("zorblat", 8)).not.toContain(`${DL}2026-08-23.md`);
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

describe("audit R4 S2: KB and day-log excerpts carry no stored value", () => {
  // Synthetic, assembled at runtime (public repo).
  const SEC = "pw-" + "z".repeat(14);
  beforeEach(() => {
    initDatabase(":memory:");
    const db = getDatabase();
    db.prepare(
      "INSERT INTO user_facts (category, key, value) VALUES (?, ?, ?)",
    ).run("projects", "acme_ftp_password", SEC);
    const kb = db.prepare(
      `INSERT INTO jarvis_files (id, path, title, content) VALUES (?,?,?,?)`,
    );
    kb.run("k1", "projects/pipesong/README.md", "PipeSong", `pipesong ftp ${SEC} ok`);
    kb.run("d1", "logs/day-logs/2026-05-20.md", "day", `pipesong deploy ${SEC} done`);
    invalidateSecretRefs();
  });
  afterEach(() => {
    closeDatabase();
    invalidateSecretRefs();
  });

  it("retrieveKbForQuery excerpts", () => {
    const refs = retrieveKbForQuery("pipesong", { db: getDatabase(), nowIso: NOW });
    const kb = refs.find((r) => r.id === "projects/pipesong/README.md")!;
    expect(kb.excerpt).toContain("[oculto");
    expect(JSON.stringify(refs)).not.toContain(SEC);
  });

  it("retrieveRecentDayLogs excerpts", () => {
    const refs = retrieveRecentDayLogs("pipesong", { db: getDatabase(), nowIso: NOW });
    expect(refs).toHaveLength(1);
    expect(refs[0].excerpt).toContain("[oculto");
    expect(refs[0].excerpt).not.toContain(SEC);
  });
});
