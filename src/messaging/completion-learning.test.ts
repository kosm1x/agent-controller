/**
 * The learning steps the router starts after it has begun sending the reply to
 * an owner's chat request: which steps start, with which inputs, which of them
 * start before the function returns, and that a failure of one step is
 * contained. Each module the function imports is replaced for the whole file
 * by a factory (reading an export it does not list throws);
 * the note above the setup says how the crystallization step is reached.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  get: vi.fn(),
  prepare: vi.fn(),
  getDatabase: vi.fn(),
  extractPattern: vi.fn(),
  autoPersistConversation: vi.fn(),
  markRecallUtility: vi.fn(),
  shouldExtract: vi.fn(),
  runBackgroundExtraction: vi.fn(),
  shouldCrystallize: vi.fn(),
  runCrystallization: vi.fn(),
}));
vi.mock("../db/index.js", () => ({ getDatabase: m.getDatabase }));
vi.mock("../intelligence/execution-patterns.js", () => ({
  extractPattern: m.extractPattern,
}));
vi.mock("../memory/auto-persist.js", () => ({
  autoPersistConversation: m.autoPersistConversation,
}));
vi.mock("../memory/recall-utility.js", () => ({
  markRecallUtility: m.markRecallUtility,
}));
vi.mock("../memory/background-extractor.js", () => ({
  shouldExtract: m.shouldExtract,
  runBackgroundExtraction: m.runBackgroundExtraction,
  shouldCrystallize: m.shouldCrystallize,
  runCrystallization: m.runCrystallization,
}));
vi.mock("../lib/err-msg.js", () => ({
  errMsg: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

// In this runner the crystallization step's import of the extractor overlaps
// the fact step's import of it and so receives the actual module, not the
// factory above; the four functions the two steps call are replaced on that
// module.
beforeAll(async () => {
  const actual = await vi.importActual<
    typeof import("../memory/background-extractor.js")
  >("../memory/background-extractor.js");
  vi.spyOn(actual, "shouldExtract").mockImplementation((o) =>
    m.shouldExtract(o),
  );
  vi.spyOn(actual, "runBackgroundExtraction").mockImplementation((...a) =>
    m.runBackgroundExtraction(...a),
  );
  vi.spyOn(actual, "shouldCrystallize").mockImplementation((o) =>
    m.shouldCrystallize(o),
  );
  vi.spyOn(actual, "runCrystallization").mockImplementation((...a) =>
    m.runCrystallization(...a),
  );
});

import {
  startCompletionLearning,
  type CompletionLearningInput,
} from "./completion-learning.js";

const SQL = "SELECT title, spawn_type, status FROM tasks WHERE task_id = ?";
const TOOLS = ["web_search", "file_read"];

function input(over: Partial<CompletionLearningInput> = {}): CompletionLearningInput {
  return {
    taskId: "t-1",
    pending: {
      channel: "whatsapp",
      originalText: "pregunta sintética sobre https://site.example",
      scopeGroups: ["research"],
    },
    resultText: "respuesta sintética",
    taskToolCalls: [...TOOLS],
    isBackground: false,
    data: { duration_ms: 42 },
    ...over,
  };
}

/** Lets the dynamic imports and their continuations run. */
async function drain(): Promise<void> {
  await vi.dynamicImportSettled();
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  m.get.mockReset().mockReturnValue({
    title: "Chat: sintética",
    spawn_type: "chat",
    status: "completed",
  });
  m.prepare.mockReset().mockImplementation(() => ({ get: m.get }));
  m.getDatabase.mockReset().mockImplementation(() => ({ prepare: m.prepare }));
  m.extractPattern.mockReset().mockResolvedValue(undefined);
  m.autoPersistConversation.mockReset().mockResolvedValue(undefined);
  m.markRecallUtility.mockReset().mockReturnValue(undefined);
  m.shouldExtract.mockReset().mockReturnValue(false);
  m.runBackgroundExtraction.mockReset().mockResolvedValue(undefined);
  m.shouldCrystallize.mockReset().mockReturnValue(false);
  m.runCrystallization.mockReset().mockResolvedValue(undefined);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

describe("execution pattern step", () => {
  it("reads the task row by its id and starts the pattern extraction with the reply's inputs", () => {
    startCompletionLearning(input({ resultText: "x".repeat(600) }));
    expect(m.prepare).toHaveBeenCalledWith(SQL);
    expect(m.get).toHaveBeenCalledWith("t-1");
    expect(m.extractPattern).toHaveBeenCalledTimes(1);
    expect(m.extractPattern).toHaveBeenCalledWith({
      taskId: "t-1",
      title: "Chat: sintética",
      status: "completed",
      toolsCalled: TOOLS,
      scopeGroups: ["research"],
      userMessage: "pregunta sintética sobre https://site.example",
      result: "x".repeat(500),
    });
  });

  it("passes an empty scope list when the pending reply has none", () => {
    const i = input();
    delete i.pending.scopeGroups;
    startCompletionLearning(i);
    expect(m.extractPattern.mock.calls[0][0].scopeGroups).toEqual([]);
  });

  it.each([
    ["no task row", { row: undefined, over: {} }],
    ["a status other than completed", { row: { title: "t", spawn_type: "chat", status: "completed_with_concerns" }, over: {} }],
    ["a background task", { row: "default", over: { isBackground: true } }],
    ["one tool call", { row: "default", over: { taskToolCalls: ["web_search"] } }],
  ] as const)("does not start the pattern extraction for %s", (_name, c) => {
    if (c.row !== "default") m.get.mockReturnValue(c.row);
    startCompletionLearning(input(c.over as Partial<CompletionLearningInput>));
    expect(m.extractPattern).not.toHaveBeenCalled();
  });

  it("a rejected pattern extraction leaves no warning", async () => {
    m.extractPattern.mockRejectedValue(new Error("synthetic"));
    startCompletionLearning(input());
    await drain();
    expect(warn).not.toHaveBeenCalled();
  });

  it("a throw of the database read does not stop sections two to five", async () => {
    m.getDatabase.mockImplementation(() => {
      throw new Error("synthetic db");
    });
    m.shouldExtract.mockReturnValue(true);
    m.shouldCrystallize.mockReturnValue(true);
    expect(() => startCompletionLearning(input())).not.toThrow();
    expect(m.extractPattern).not.toHaveBeenCalled();
    expect(m.autoPersistConversation).toHaveBeenCalledTimes(1);
    await drain();
    expect(m.markRecallUtility).toHaveBeenCalledTimes(1);
    expect(m.runBackgroundExtraction).toHaveBeenCalledTimes(1);
    expect(m.runCrystallization).toHaveBeenCalledTimes(1);
  });
});

describe("auto-persist step", () => {
  it("starts the auto-persist with the exchange", () => {
    startCompletionLearning(input());
    expect(m.autoPersistConversation).toHaveBeenCalledTimes(1);
    expect(m.autoPersistConversation).toHaveBeenCalledWith({
      userText: "pregunta sintética sobre https://site.example",
      responseText: "respuesta sintética",
      toolCalls: TOOLS,
      channel: "whatsapp",
      taskId: "t-1",
    });
  });

  it("a rejection is one warning with its message", async () => {
    m.autoPersistConversation.mockRejectedValue(new Error("synthetic persist"));
    startCompletionLearning(input());
    await drain();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[router] Auto-persist failed:",
      "synthetic persist",
    );
  });

  it("a synchronous throw is contained and the later steps still start", async () => {
    m.autoPersistConversation.mockImplementation(() => {
      throw new Error("synthetic sync");
    });
    m.shouldExtract.mockReturnValue(true);
    m.shouldCrystallize.mockReturnValue(true);
    expect(() => startCompletionLearning(input())).not.toThrow();
    await drain();
    expect(m.markRecallUtility).toHaveBeenCalledTimes(1);
    expect(m.runBackgroundExtraction).toHaveBeenCalledTimes(1);
    expect(m.runCrystallization).toHaveBeenCalledTimes(1);
  });
});

describe("recall-utility step", () => {
  it("marks the recall utility after the function returns, with the task id and the reply", async () => {
    startCompletionLearning(input());
    expect(m.markRecallUtility).not.toHaveBeenCalled();
    await drain();
    expect(m.markRecallUtility).toHaveBeenCalledTimes(1);
    expect(m.markRecallUtility).toHaveBeenCalledWith({
      taskId: "t-1",
      responseText: "respuesta sintética",
    });
  });

  it("a throw of the mark is one warning with its message", async () => {
    m.markRecallUtility.mockImplementation(() => {
      throw new Error("synthetic mark");
    });
    startCompletionLearning(input());
    await drain();
    expect(warn).toHaveBeenCalledWith(
      "[router] recall-utility match failed:",
      "synthetic mark",
    );
  });
});

describe("fact extraction step", () => {
  it.each([
    [false, undefined],
    [true, "user-background"],
  ] as const)("asks the predicate with the reply's facts (background %s)", async (isBackground, spawnType) => {
    startCompletionLearning(input({ isBackground }));
    await drain();
    expect(m.shouldExtract).toHaveBeenCalledTimes(1);
    expect(m.shouldExtract).toHaveBeenCalledWith({
      toolCalls: TOOLS,
      responseLength: "respuesta sintética".length,
      spawnType,
      isRitual: false,
      isProactive: false,
    });
  });

  it("starts the extraction with its inputs when the predicate says yes, and not when it says no", async () => {
    startCompletionLearning(input());
    await drain();
    expect(m.runBackgroundExtraction).not.toHaveBeenCalled();
    m.shouldExtract.mockReturnValue(true);
    startCompletionLearning(input());
    await drain();
    expect(m.runBackgroundExtraction).toHaveBeenCalledTimes(1);
    expect(m.runBackgroundExtraction).toHaveBeenCalledWith(
      "pregunta sintética sobre https://site.example",
      "respuesta sintética",
      TOOLS,
      "t-1",
    );
  });

  it("a rejected extraction is one warning with its message", async () => {
    m.shouldExtract.mockReturnValue(true);
    m.runBackgroundExtraction.mockRejectedValue(new Error("synthetic extract"));
    startCompletionLearning(input());
    await drain();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[router] Background extraction failed:",
      "synthetic extract",
    );
  });

  it("a throw of the predicate leaves no warning and the crystallization still starts", async () => {
    m.shouldExtract.mockImplementation(() => {
      throw new Error("synthetic predicate");
    });
    m.shouldCrystallize.mockReturnValue(true);
    startCompletionLearning(input());
    await drain();
    expect(warn).not.toHaveBeenCalled();
    expect(m.runBackgroundExtraction).not.toHaveBeenCalled();
    expect(m.runCrystallization).toHaveBeenCalledTimes(1);
  });
});

describe("crystallization step", () => {
  it.each([
    [false, undefined],
    [true, "user-background"],
  ] as const)("asks the predicate with the run's facts (background %s)", async (isBackground, spawnType) => {
    startCompletionLearning(input({ isBackground }));
    await drain();
    expect(m.shouldCrystallize).toHaveBeenCalledTimes(1);
    expect(m.shouldCrystallize).toHaveBeenCalledWith({
      toolCalls: TOOLS,
      durationMs: 42,
      spawnType,
      isRitual: false,
      isProactive: false,
    });
  });

  it("starts the crystallization with its exact arguments when the predicate says yes, and not when it says no", async () => {
    startCompletionLearning(input());
    await drain();
    expect(m.runCrystallization).not.toHaveBeenCalled();
    m.shouldCrystallize.mockReturnValue(true);
    startCompletionLearning(input());
    await drain();
    expect(m.runCrystallization).toHaveBeenCalledTimes(1);
    expect(m.runCrystallization).toHaveBeenCalledWith(
      "pregunta sintética sobre https://site.example",
      "respuesta sintética",
      TOOLS,
      42,
      "t-1",
    );
  });

  it("a rejected crystallization is one warning with its message", async () => {
    m.shouldCrystallize.mockReturnValue(true);
    m.runCrystallization.mockRejectedValue(new Error("synthetic crystal"));
    startCompletionLearning(input());
    await drain();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[router] Crystallization failed:",
      "synthetic crystal",
    );
  });
});

describe("timing", () => {
  it("returns undefined at once, with the pattern and auto-persist steps started and the three imported steps not yet", () => {
    m.shouldExtract.mockReturnValue(true);
    m.shouldCrystallize.mockReturnValue(true);
    const out = startCompletionLearning(input());
    expect(out).toBeUndefined();
    expect(m.extractPattern).toHaveBeenCalledTimes(1);
    expect(m.autoPersistConversation).toHaveBeenCalledTimes(1);
    expect(m.extractPattern.mock.invocationCallOrder[0]).toBeLessThan(
      m.autoPersistConversation.mock.invocationCallOrder[0],
    );
    expect(m.markRecallUtility).not.toHaveBeenCalled();
    expect(m.shouldExtract).not.toHaveBeenCalled();
    expect(m.shouldCrystallize).not.toHaveBeenCalled();
  });

  it("pattern and auto-persist promises that never settle do not hold the imported steps back", async () => {
    m.extractPattern.mockReturnValue(new Promise(() => {}));
    m.autoPersistConversation.mockReturnValue(new Promise(() => {}));
    m.shouldExtract.mockReturnValue(true);
    m.shouldCrystallize.mockReturnValue(true);
    startCompletionLearning(input());
    await drain();
    expect(m.markRecallUtility).toHaveBeenCalledTimes(1);
    expect(m.runBackgroundExtraction).toHaveBeenCalledTimes(1);
    expect(m.runCrystallization).toHaveBeenCalledTimes(1);
  });

  it("the fact and crystallization steps read the pending reply's text when they run", async () => {
    m.shouldExtract.mockReturnValue(true);
    m.shouldCrystallize.mockReturnValue(true);
    const i = input();
    startCompletionLearning(i);
    i.pending.originalText = "texto cambiado después";
    await drain();
    expect(m.runBackgroundExtraction.mock.calls[0][0]).toBe("texto cambiado después");
    expect(m.runCrystallization.mock.calls[0][0]).toBe("texto cambiado después");
  });
});
