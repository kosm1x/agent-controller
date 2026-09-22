import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import type { JmeFactCategory } from "../memory/jme.js";
import { logRecall } from "../memory/recall-utility.js";
import { classifyScopeGroupsWithJev } from "../messaging/scope-classifier-jev.js";
import {
  CLASSIFIER_SYSTEM_PROMPT,
  VALID_GROUPS,
} from "../messaging/scope-classifier.js";
import { mustNotLeave } from "./client.js";
import { KB_SHADOW_ROWS, shadowKbRows } from "./shadow-kb.js";
import {
  deferShadow,
  recordJevShadow,
  shadowArmed,
  shadowFeedback,
  shadowMemoryRecall,
} from "./shadow.js";

/** A recalled JME fact as the runner holds it. */
const fact = (
  id: number,
  factText: string,
  category: JmeFactCategory = "preference",
) => ({
  id,
  factText,
  category,
});

// Assembled at runtime: a literal would trip the repo's secret guard.
const SECRET = "Xy" + "7" + "kQ9" + "zz";

// Two rows that carry a registered evidence predicate.
const SOP = "knowledge/procedures/code-generation-sop.md";
const DATA_DOC = "directives/data-doc-authoring.md";

const mockFetch = vi.fn();

/** Answers every question asked with the same noul. */
const answerAll = (noul: number) =>
  mockFetch.mockImplementation(async (_url: string, init: { body: string }) => {
    const answers: Record<string, { noul: number }> = {};
    for (const id of Object.keys(JSON.parse(init.body).questions))
      answers[id] = { noul };
    return { ok: true, status: 200, json: async () => ({ answers }) };
  });

interface Row {
  consumer: string;
  ref: string | null;
  item: string;
  noul: number | null;
  latency_ms: number | null;
  incumbent: string | null;
}
const rows = (): Row[] =>
  getDatabase()
    .prepare(
      "SELECT consumer, ref, item, noul, latency_ms, incumbent FROM jev_shadow ORDER BY id",
    )
    .all() as Row[];

/** Lets the deferred call and its awaits run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

const sentBody = () => JSON.parse(mockFetch.mock.calls[0][1].body);

beforeEach(() => {
  initDatabase(":memory:");
  vi.stubGlobal("fetch", mockFetch);
  vi.stubEnv("TYPESAFE_API_KEY", "test-key");
  // Whitespace and case are normalised: the list is operator-typed.
  vi.stubEnv("JEV_SHADOW_CONSUMERS", " Kb ,feedback, memory");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  mockFetch.mockReset();
  closeDatabase();
});

describe("migration v6 — jev_shadow", () => {
  it("exists at the schema head and refuses an unknown consumer", () => {
    const db = getDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(6);
    expect(() =>
      db
        .prepare("INSERT INTO jev_shadow (consumer, item) VALUES ('x', 'y')")
        .run(),
    ).toThrow(/CHECK/);
  });
});

describe("arming", () => {
  it("is dormant by default: no request, no row", async () => {
    vi.stubEnv("JEV_SHADOW_CONSUMERS", "");
    expect(shadowArmed("kb")).toBe(false);
    shadowFeedback("t1", "no, eso no era", "dame el reporte", "neutral");
    shadowKbRows("t1", "hola", []);
    shadowMemoryRecall("t1", "hola", [fact(1, "un recuerdo")]);
    await settle();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });

  it("arms only the consumers listed", async () => {
    vi.stubEnv("JEV_SHADOW_CONSUMERS", "kb");
    expect(shadowArmed("kb")).toBe(true);
    expect(shadowArmed("feedback")).toBe(false);
    expect(shadowArmed("memory")).toBe(false);
    shadowFeedback("t1", "otra vez", "dame el reporte", "neutral");
    shadowMemoryRecall("t1", "hola", [fact(1, "un recuerdo")]);
    await settle();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("is dormant when the variable is absent, not only when it is empty", () => {
    vi.stubEnv("JEV_SHADOW_CONSUMERS", undefined);
    expect(process.env.JEV_SHADOW_CONSUMERS).toBeUndefined();
    expect(shadowArmed("kb")).toBe(false);
    expect(shadowArmed("feedback")).toBe(false);
    expect(shadowArmed("memory")).toBe(false);
  });

  it("stays off without a key", () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    expect(shadowArmed("kb")).toBe(false);
  });
});

describe("shadow calls", () => {
  it("never run on the caller's tick", async () => {
    answerAll(0.5);
    shadowFeedback("t1", "otra vez", "dame el reporte", "neutral");
    expect(mockFetch).not.toHaveBeenCalled();
    await settle();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("feedback: two questions, none about approval, logged beside the regex label", async () => {
    answerAll(0.8);
    shadowFeedback("t1", "no, eso no era", "dame el reporte", "negative");
    await settle();
    const sent = sentBody();
    expect(sent.state).toEqual({
      follow_up: "no, eso no era",
      previous_message: "dame el reporte",
    });
    expect(Object.keys(sent.questions)).toHaveLength(2);
    // No question may score approval: "excelente" is the only eval word.
    // Checked on every string of the question, not only the positive side.
    for (const q of Object.values(sent.questions))
      expect(JSON.stringify(q)).not.toMatch(
        /thank|prais|approv|satisf|happy|delight|excelente/i,
      );
    expect(rows().map((r) => [r.ref, r.item, r.noul, r.incumbent])).toEqual([
      ["t1", "correction", 0.8, "negative"],
      ["t1", "restatement", 0.8, "negative"],
    ]);
    expect(rows()[0].latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("withholds the whole request when the user's text is sensitive", async () => {
    shadowFeedback("t1", `Pswd: ${SECRET}`, "entra a la liga", "neutral");
    await settle();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(rows().map((r) => [r.item, r.noul])).toEqual([["_withheld", null]]);
  });

  it("records a failed request and never throws", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    shadowFeedback("t1", "otra vez", "dame el reporte", "neutral");
    await settle();
    expect(rows().map((r) => r.item)).toEqual(["_failed"]);
  });

  it("kb: scores every applicable row with what priority order did to it", async () => {
    answerAll(0.6);
    const insert = getDatabase().prepare(
      `INSERT INTO jarvis_files (id, path, title, content, qualifier, condition, priority)
       VALUES (?, ?, ?, ?, 'conditional', ?, ?)`,
    );
    insert.run("a", SOP, "A", "regla uno ".repeat(500), null, 10);
    insert.run("b", DATA_DOC, "B", "regla dos ".repeat(500), null, 20);
    insert.run("c", "directives/x-posting-card.md", "C", "c", "social", 30);
    shadowKbRows("t9", "publica el demo", ["file_read"]);
    await settle();
    expect(sentBody().state).toEqual({ message: "publica el demo" });
    expect(rows().map((r) => [r.ref, r.item, r.incumbent, r.noul])).toEqual([
      ["t9", SOP, "budget", 0.6],
      ["t9", DATA_DOC, "pointer", 0.6],
    ]);
  });

  it("kb: a row with no registered entry is left out; the rest are scored", async () => {
    answerAll(0.6);
    const insert = getDatabase().prepare(
      `INSERT INTO jarvis_files (id, path, title, content, qualifier, condition, priority)
       VALUES (?, ?, ?, 'Vive en el valle.', 'conditional', NULL, ?)`,
    );
    insert.run("p", "knowledge/people/fede-reference.md", "Ref", 10);
    insert.run("s", SOP, "SOP", 20);
    shadowKbRows("t9", "donde vivo", ["file_read"]);
    await settle();
    expect(Object.keys(sentBody().questions)).toHaveLength(1);
    expect(rows().map((r) => r.item)).toEqual([SOP]);
  });

  it("sends at most 500 chars of the user's text", async () => {
    answerAll(0.5);
    shadowFeedback(
      "t1",
      "otra vez ".repeat(100),
      "dame ".repeat(200),
      "neutral",
    );
    await settle();
    expect(sentBody().state.follow_up).toHaveLength(500);
    expect(sentBody().state.previous_message).toHaveLength(500);
  });

  it("kb: a row whose path names an Object member does not cost the turn its scores", async () => {
    answerAll(0.6);
    const insert = getDatabase().prepare(
      `INSERT INTO jarvis_files (id, path, title, content, qualifier, condition, priority)
       VALUES (?, ?, 'T', 'regla', 'conditional', NULL, ?)`,
    );
    insert.run("p", "constructor", 10);
    insert.run("s", SOP, 20);
    shadowKbRows("t9", "abre el panel", ["file_read"]);
    await settle();
    expect(rows().map((r) => [r.item, r.noul])).toEqual([[SOP, 0.6]]);
  });

  it("kb: an empty message is no message", async () => {
    answerAll(0.6);
    getDatabase()
      .prepare(
        `INSERT INTO jarvis_files (id, path, title, content, qualifier, condition, priority)
         VALUES ('a', ?, 'A', 'regla', 'conditional', NULL, 10)`,
      )
      .run(SOP);
    shadowKbRows("t9", "", ["file_read"]);
    await settle();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });

  it("kb: no message, no work", async () => {
    shadowKbRows("t9", undefined, ["file_read"]);
    await settle();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("memory: one question per recalled fact, the fact text as the criterion", async () => {
    answerAll(0.7);
    shadowMemoryRecall("t5", "que sabes de denue", [
      fact(11, "DENUE vive en supabase", "project"),
      fact(12, "prefiere respuestas cortas"),
    ]);
    await settle();
    const body = sentBody();
    expect(body.state).toEqual({ message: "que sabes de denue" });
    expect(Object.keys(body.questions)).toEqual(["q0", "q1"]);
    // The registered question (plan §Design), pinned: bar 2 thresholds a
    // relevance number, so the vendor must be asked about relevance.
    expect(body.questions.q0.instructions).toBe(
      "Is the memory quoted in the criteria relevant to answering the user's `message`?",
    );
    expect(body.questions.q0.criteria).toEqual({
      true: "DENUE vive en supabase",
      false: "The memory has nothing to do with the message.",
    });
    expect(
      rows().map((r) => [r.consumer, r.ref, r.item, r.noul, r.incumbent]),
    ).toEqual([
      ["memory", "t5", "11", 0.7, "project"],
      ["memory", "t5", "12", 0.7, "preference"],
    ]);
  });

  it("memory: drops a sensitive fact alone and scores the rest", async () => {
    answerAll(0.6);
    shadowMemoryRecall("t6", "entra a la liga", [
      fact(21, `Login: pedro\nPswd: ${SECRET}`),
      fact(22, "la liga se juega los martes"),
    ]);
    await settle();
    expect(JSON.stringify(sentBody())).not.toContain(SECRET);
    expect(Object.keys(sentBody().questions)).toEqual(["q0"]);
    expect(rows().map((r) => [r.item, r.noul])).toEqual([
      ["21", null],
      ["22", 0.6],
    ]);
  });

  it("memory: never more than 8 facts leave, whatever the recall returned", async () => {
    answerAll(0.5);
    shadowMemoryRecall(
      "t7",
      "hola",
      Array.from({ length: 9 }, (_, i) => fact(i + 1, `dato ${i + 1}`)),
    );
    await settle();
    expect(Object.keys(sentBody().questions)).toHaveLength(8);
    expect(JSON.stringify(sentBody())).not.toContain("dato 9");
  });

  it("memory: a clean fact leaves cut to 400 chars, the message to 500", async () => {
    answerAll(0.5);
    const factText = "regla uno ".repeat(60).trim();
    const message = "dame la regla ".repeat(50).trim();
    expect(mustNotLeave(factText)).toBe(false);
    // Longer than the cuts, or the slices below compare the whole string.
    expect(factText.length).toBeGreaterThan(400);
    expect(message.length).toBeGreaterThan(500);
    shadowMemoryRecall("t9", message, [fact(1, factText)]);
    await settle();
    expect(sentBody().questions.q0.criteria.true).toBe(factText.slice(0, 400));
    expect(sentBody().state.message).toBe(message.slice(0, 500));
  });

  it("memory: no facts, no request", async () => {
    answerAll(0.5);
    shadowMemoryRecall("t8", "hola", []);
    await settle();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });

  it("drops a sensitive item alone, with a null-noul row, and scores the rest", async () => {
    // No shipping consumer builds an item from run-time text; the branch is
    // held for consumer 2's return and pinned here through `deferShadow`.
    answerAll(0.8);
    const item = (name: string, positive: string) => ({
      item: name,
      incumbent: null,
      instructions: "i",
      positive,
      negative: "n",
    });
    deferShadow("kb", "t7", { message: "hola" }, () => [
      item("secret", `Pswd: ${SECRET}`),
      item("blank", "   "),
      item("clean", "una descripcion limpia"),
    ]);
    await settle();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(sentBody())).not.toContain(SECRET);
    expect(Object.keys(sentBody().questions)).toEqual(["q0"]);
    expect(sentBody().questions.q0.criteria.true).toBe(
      "una descripcion limpia",
    );
    expect(rows().map((r) => [r.item, r.noul])).toEqual([
      ["secret", null],
      ["blank", null],
      ["clean", 0.8],
    ]);
  });

  it("a builder that throws, or a closed database, reaches no caller", async () => {
    answerAll(0.5);
    closeDatabase();
    shadowKbRows("t9", "hola", ["file_read"]);
    await settle();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("[jev-shadow] kb failed"),
    );
    expect(() =>
      recordJevShadow([
        {
          consumer: "kb",
          ref: null,
          item: "x",
          noul: null,
          latencyMs: null,
          incumbent: null,
        },
      ]),
    ).not.toThrow();
    initDatabase(":memory:");
  });
});

// qa R3: a cut is a rewrite. The keyword that makes the filter object sits
// past the cut, the value before it.
describe("the filter reads the text before it is cut", () => {
  const late = (chars: number) =>
    `apunta ${SECRET} en el cuaderno. ` +
    "seguimos con la nota de ayer ".repeat(Math.ceil(chars / 29)) +
    "esa es mi contraseña del wifi";

  it("the fixture only trips the filter past the cut", () => {
    expect(mustNotLeave(late(500))).toBe(true);
    expect(mustNotLeave(late(500).slice(0, 500))).toBe(false);
    expect(mustNotLeave(late(400).slice(0, 400))).toBe(false);
  });

  it("feedback: either message withholds the request", async () => {
    shadowFeedback("t1", late(500), "dame el reporte", "neutral");
    shadowFeedback("t2", "otra vez", late(500), "neutral");
    await settle();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(rows().map((r) => [r.ref, r.item])).toEqual([
      ["t1", "_withheld"],
      ["t2", "_withheld"],
    ]);
  });

  it("memory: the round-4 reproduction — a keyword past char 2,000 still withholds", async () => {
    answerAll(0.5);
    const message = late(2_100);
    expect(message.length).toBeGreaterThan(2_000);
    expect(mustNotLeave(message.slice(0, 2_000))).toBe(false);
    shadowMemoryRecall("t3", message, [fact(1, "un recuerdo limpio")]);
    await settle();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(rows().map((r) => [r.consumer, r.item])).toEqual([
      ["memory", "_withheld"],
    ]);
  });

  it("memory: a fact whose keyword sits past the 400-char cut is dropped, not sent", async () => {
    answerAll(0.5);
    shadowMemoryRecall("t4", "hola", [fact(1, late(500))]);
    await settle();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(rows().map((r) => [r.item, r.noul])).toEqual([["1", null]]);
  });

  it("kb: the message withholds the request", async () => {
    getDatabase()
      .prepare(
        `INSERT INTO jarvis_files (id, path, title, content, qualifier, condition, priority)
         VALUES ('a', ?, 'A', 'regla', 'conditional', NULL, 10)`,
      )
      .run(SOP);
    shadowKbRows("t9", late(500), ["file_read"]);
    await settle();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(rows().map((r) => r.item)).toEqual(["_withheld"]);
  });
});

describe("kb: no KB text leaves", () => {
  it("sends the committed description, never the row's content", async () => {
    answerAll(0.6);
    getDatabase()
      .prepare(
        `INSERT INTO jarvis_files (id, path, title, content, qualifier, condition, priority)
         VALUES ('a', ?, 'Titulo privado', 'Login: rumibot\nPassword: watermelon', 'conditional', NULL, 10)`,
      )
      .run(SOP);
    shadowKbRows("t9", "abre el panel", ["file_read"]);
    await settle();
    const sent = JSON.stringify(sentBody());
    expect(sent).not.toMatch(/rumibot|watermelon|Titulo privado/);
    expect(sentBody().questions.q0.criteria).toEqual({
      true: KB_SHADOW_ROWS[SOP].describes,
      false: "The message can be handled correctly without this directive.",
    });
    expect(rows().map((r) => [r.item, r.noul])).toEqual([[SOP, 0.6]]);
  });

  it("every registered description passes the vendor filter", () => {
    for (const [path, row] of Object.entries(KB_SHADOW_ROWS)) {
      expect(mustNotLeave(row.describes), path).toBe(false);
      expect(row.evidence.length, path).toBeGreaterThan(0);
    }
  });
});

describe("wiring", () => {
  it("logRecall reaches no vendor: consumer 2 reads the runner, never the recall log", async () => {
    vi.stubEnv("JEV_SHADOW_CONSUMERS", "kb,memory,feedback");
    answerAll(0.9);
    logRecall({
      bank: "jme",
      query: "que sabes de denue",
      source: "jme",
      results: [{ content: "DENUE vive en supabase" }],
      latencyMs: 5,
    });
    await settle();
    // The recall was logged, so a hook inside it would have run.
    expect(
      (
        getDatabase()
          .prepare("SELECT COUNT(*) AS c FROM recall_audit")
          .get() as { c: number }
      ).c,
    ).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });

  it("the live scope call leaves one telemetry row and no text", async () => {
    mockFetch.mockImplementation(async () => {
      const answers: Record<string, { noul: number }> = {};
      for (const g of VALID_GROUPS)
        answers[`g_${g}`] = { noul: g === "coding" ? 0.9 : 0.1 };
      return { ok: true, status: 200, json: async () => ({ answers }) };
    });
    await classifyScopeGroupsWithJev(
      "revisa el deploy",
      undefined,
      CLASSIFIER_SYSTEM_PROMPT,
      VALID_GROUPS,
    );
    // Deferred: the write must not sit on the turn's path.
    expect(rows()).toEqual([]);
    await settle();
    const [row] = rows();
    expect([row.consumer, row.ref, row.item, row.incumbent]).toEqual([
      "scope",
      null,
      "answered",
      "coding",
    ]);
    expect(JSON.stringify(rows())).not.toContain("deploy");
  });

  it("the live scope call refuses a noul outside [0, 1]", async () => {
    mockFetch.mockImplementation(async () => {
      const answers: Record<string, { noul: number }> = {};
      for (const g of VALID_GROUPS)
        answers[`g_${g}`] = { noul: g === "coding" ? 1.4 : 0.1 };
      return { ok: true, status: 200, json: async () => ({ answers }) };
    });
    expect(
      await classifyScopeGroupsWithJev(
        "revisa el deploy",
        undefined,
        CLASSIFIER_SYSTEM_PROMPT,
        VALID_GROUPS,
      ),
    ).toBeNull();
    await settle();
  });

  it("the live scope call records a withheld and a failed turn", async () => {
    const classify = (message: string) =>
      classifyScopeGroupsWithJev(
        message,
        undefined,
        CLASSIFIER_SYSTEM_PROMPT,
        VALID_GROUPS,
      );
    expect(await classify(`Pswd: ${SECRET}`)).toBeNull();
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    });
    expect(await classify("revisa el deploy")).toBeNull();
    await settle();
    expect(rows().map((r) => [r.consumer, r.item])).toEqual([
      ["scope", "_withheld"],
      ["scope", "_failed"],
    ]);
    expect(rows()[1].latency_ms).toBeGreaterThanOrEqual(0);
  });
});
