import { describe, it, expect } from "vitest";
import {
  createBank,
  addLesson,
  retrieveTop,
  bankSize,
  formatLessonsBlock,
  serializeBank,
  deserializeBank,
  tokenize,
  ReflectionRegistry,
  type ReflectionEntry,
} from "./reflection-memory.js";

const entry = (
  situation: string,
  lesson: string,
  pnl: number,
  ts: number = 0,
): ReflectionEntry => ({ situation, lesson, pnl, ts });

describe("tokenize", () => {
  it("lowercases, splits on non-word chars, drops single-char tokens", () => {
    expect(tokenize("Inflation up; Fed pivots — risk-on!")).toEqual([
      "inflation",
      "up",
      "fed",
      "pivots",
      "risk",
      "on",
    ]);
  });

  it("returns empty for empty / whitespace-only input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
  });

  it("handles unicode word characters", () => {
    expect(tokenize("BTC ↑ está bullish")).toEqual(["btc", "está", "bullish"]);
  });
});

describe("createBank / addLesson / bankSize", () => {
  it("starts empty", () => {
    const b = createBank("macro");
    expect(bankSize(b)).toBe(0);
    expect(b.idf.size).toBe(0);
    expect(b.avgDocLen).toBe(0);
  });

  it("rebuilds the index on each add", () => {
    const b = createBank("macro");
    addLesson(b, entry("Fed pivots dovish, risk-on", "trim defensive", 1500));
    addLesson(b, entry("Fed pivots hawkish, risk-off", "add defensive", -800));
    expect(b.entries).toHaveLength(2);
    // Tokens cached parallel to entries.
    expect(b.tokens[0]).toContain("dovish");
    expect(b.tokens[1]).toContain("hawkish");
    // IDF map populated; "fed" appears in both → IDF is small/zero, "dovish" only in one → IDF is positive.
    const dovishIdf = b.idf.get("dovish") ?? 0;
    const fedIdf = b.idf.get("fed") ?? 0;
    expect(dovishIdf).toBeGreaterThan(fedIdf);
    // avgDocLen reflects both docs.
    expect(b.avgDocLen).toBeGreaterThan(0);
  });
});

describe("retrieveTop", () => {
  const setup = (): ReturnType<typeof createBank> => {
    const b = createBank("macro");
    addLesson(b, entry("CPI hot, Fed hawkish, risk-off", "raise cash", -1200));
    addLesson(b, entry("CPI cool, Fed dovish, risk-on", "trim defensive", 900));
    addLesson(
      b,
      entry("oil shock, energy outperforms", "rotate to energy", 1500),
    );
    addLesson(
      b,
      entry(
        "regional bank stress, financials sell off",
        "underweight financials",
        -700,
      ),
    );
    return b;
  };

  it("returns top-K most relevant lessons by BM25 score", () => {
    const b = setup();
    const top = retrieveTop(b, "Fed dovish CPI cool", 2);
    expect(top).toHaveLength(2);
    // Best match should be the CPI cool / Fed dovish entry.
    expect(top[0]!.lesson).toBe("trim defensive");
  });

  it("returns ≤ K when fewer docs match the query terms", () => {
    const b = setup();
    const top = retrieveTop(b, "energy oil shock", 5);
    // Only 1 doc shares vocab with "energy"/"oil"/"shock"; others may
    // match weakly via "off" / etc. but the top entry is unambiguous.
    expect(top.length).toBeGreaterThan(0);
    expect(top[0]!.lesson).toBe("rotate to energy");
  });

  it("returns empty array for empty query / empty bank / k=0", () => {
    const b = createBank("x");
    expect(retrieveTop(b, "anything", 5)).toEqual([]);

    const populated = setup();
    expect(retrieveTop(populated, "", 5)).toEqual([]);
    expect(retrieveTop(populated, "    ", 5)).toEqual([]);
    expect(retrieveTop(populated, "valid query", 0)).toEqual([]);
    expect(retrieveTop(populated, "valid query", -1)).toEqual([]);
  });

  it("filters out zero-score docs (no shared vocab)", () => {
    const b = createBank("macro");
    addLesson(b, entry("apple banana cherry", "lesson 1", 100));
    addLesson(b, entry("date elderberry fig", "lesson 2", 200));
    const top = retrieveTop(b, "apple", 5);
    expect(top).toHaveLength(1);
    expect(top[0]!.lesson).toBe("lesson 1");
  });

  it("preferWinners: tie-break uses P&L when scores are otherwise equal", () => {
    const b = createBank("macro");
    addLesson(b, entry("identical situation here", "loser advice", -1000));
    addLesson(b, entry("identical situation here", "winner advice", 5000));
    const top = retrieveTop(b, "identical situation here", 1, {
      preferWinners: true,
    });
    expect(top[0]!.lesson).toBe("winner advice");

    // Without preferWinners the order is the insertion order on ties.
    const tiedTop = retrieveTop(b, "identical situation here", 1);
    expect(tiedTop[0]!.lesson).toBe("loser advice");
  });
});

describe("formatLessonsBlock", () => {
  it("formats a non-empty list as bulleted lines under a header", () => {
    const block = formatLessonsBlock("macro", [
      entry("s1", "lesson one", 100),
      entry("s2", "lesson two", -50),
    ]);
    expect(block).toBe("Past lessons for macro:\n- lesson one\n- lesson two");
  });

  it("returns empty string for an empty list (no header on its own)", () => {
    expect(formatLessonsBlock("macro", [])).toBe("");
  });
});

describe("serializeBank / deserializeBank", () => {
  it("roundtrips entries and rebuilds the BM25 index", () => {
    const a = createBank("trader");
    addLesson(a, entry("vol spike, defensive rotates in", "raise cash", -300));
    addLesson(a, entry("growth scare, tech sells", "trim long beta", -800));

    const json = serializeBank(a);
    const b = deserializeBank(json);

    expect(b.agent).toBe("trader");
    expect(b.entries).toEqual(a.entries);
    // Index was rebuilt from scratch — IDF/avgDocLen match.
    expect(b.idf.size).toBe(a.idf.size);
    expect(b.avgDocLen).toBeCloseTo(a.avgDocLen, 12);

    // Round-tripped retrieval still works.
    const top = retrieveTop(b, "vol spike defensive", 1);
    expect(top[0]!.lesson).toBe("raise cash");
  });

  it("rejects malformed input", () => {
    expect(() => deserializeBank("not json")).toThrow();
    expect(() => deserializeBank("{}")).toThrow(/agent or entries/);
    expect(() =>
      deserializeBank(JSON.stringify({ agent: "x", entries: [{ x: 1 }] })),
    ).toThrow(/malformed entry/);
  });
});

describe("ReflectionRegistry — per-agent banks", () => {
  it("lazy-creates banks on first access and isolates them", () => {
    const reg = new ReflectionRegistry();
    const macro = reg.bank("macro");
    addLesson(macro, entry("CPI hot", "raise cash", -100));
    const sentiment = reg.bank("sentiment");
    addLesson(sentiment, entry("retail FOMO peak", "fade momentum", 200));

    expect(reg.agents()).toEqual(["macro", "sentiment"]);
    expect(reg.totalEntries()).toBe(2);

    // Banks are independent — searching macro should not surface sentiment lessons.
    const top = retrieveTop(macro, "CPI hot", 5);
    expect(top.map((e) => e.lesson)).toEqual(["raise cash"]);
  });

  it("returns the SAME bank instance on repeated bank() calls", () => {
    const reg = new ReflectionRegistry();
    const a = reg.bank("trader");
    const b = reg.bank("trader");
    expect(a).toBe(b);
    addLesson(a, entry("x", "y", 0));
    expect(b.entries).toHaveLength(1);
  });
});
