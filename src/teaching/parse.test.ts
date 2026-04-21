import { describe, it, expect } from "vitest";
import {
  extractFirstJson,
  parseDecomposition,
  parseQuiz,
  parseSummary,
  parseGrading,
  normalizeConcept,
} from "./parse.js";

describe("extractFirstJson", () => {
  it("extracts bare array", () => {
    expect(extractFirstJson("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("extracts array from CoT prose prefix", () => {
    const raw = `Here is my analysis:\n\n[{"a":1},{"a":2}]\n\nDone.`;
    expect(extractFirstJson(raw)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("extracts object wrapped in prose", () => {
    const raw = `Reasoning: ... Output: {"concepts": [{"x": 1}]}`;
    expect(extractFirstJson(raw)).toEqual({ concepts: [{ x: 1 }] });
  });

  it("handles braces inside string literals", () => {
    const raw = `{"q": "what does { do?", "a": "opens a block"}`;
    expect(extractFirstJson(raw)).toEqual({
      q: "what does { do?",
      a: "opens a block",
    });
  });

  it("returns null on malformed JSON", () => {
    expect(extractFirstJson("{unclosed")).toBeNull();
    expect(extractFirstJson("no json here")).toBeNull();
  });
});

describe("parseDecomposition", () => {
  it("parses valid decomposition", () => {
    const raw = JSON.stringify([
      {
        title: "Basics",
        summary: "foundations",
        predicted_difficulties: ["syntax"],
        prerequisites: [],
      },
      {
        title: "Advanced",
        summary: "deeper",
        predicted_difficulties: [],
        prerequisites: [0],
      },
    ]);
    const out = parseDecomposition(raw, 5);
    expect(out.units).toHaveLength(2);
    expect(out.units[0].title).toBe("Basics");
    expect(out.units[1].prerequisites).toEqual([0]);
  });

  it("throws on empty array", () => {
    expect(() => parseDecomposition("[]", 5)).toThrow();
  });

  it("throws when not an array", () => {
    expect(() => parseDecomposition('{"units":[]}', 5)).toThrow();
  });

  it("throws on unit missing title or summary", () => {
    const raw = JSON.stringify([{ title: "ok", summary: "" }]);
    expect(() => parseDecomposition(raw, 5)).toThrow();
  });

  it("truncates to ceiling", () => {
    const units = Array.from({ length: 10 }, (_, i) => ({
      title: `u${i}`,
      summary: "s",
      predicted_difficulties: [],
      prerequisites: [],
    }));
    const out = parseDecomposition(JSON.stringify(units), 3);
    expect(out.units).toHaveLength(3);
  });

  it("drops prerequisite indexes >= current index", () => {
    const raw = JSON.stringify([
      {
        title: "a",
        summary: "s",
        predicted_difficulties: [],
        prerequisites: [0, 1, 2],
      },
    ]);
    const out = parseDecomposition(raw, 5);
    expect(out.units[0].prerequisites).toEqual([]);
  });
});

describe("parseQuiz", () => {
  it("parses valid quiz", () => {
    const raw = JSON.stringify([
      {
        question: "q1",
        expected_answer: "a1",
        difficulty: "easy",
      },
      {
        question: "q2",
        expected_answer: "a2",
        difficulty: "hard",
      },
    ]);
    const out = parseQuiz(raw, 5);
    expect(out.questions).toHaveLength(2);
    expect(out.questions[0].difficulty).toBe("easy");
  });

  it("defaults invalid difficulty to medium", () => {
    const raw = JSON.stringify([
      { question: "q", expected_answer: "a", difficulty: "whatever" },
    ]);
    const out = parseQuiz(raw, 5);
    expect(out.questions[0].difficulty).toBe("medium");
  });

  it("throws on 0 questions", () => {
    expect(() => parseQuiz("[]", 5)).toThrow();
  });

  it("truncates to maxN", () => {
    const qs = Array.from({ length: 10 }, (_, i) => ({
      question: `q${i}`,
      expected_answer: "a",
      difficulty: "medium",
    }));
    const out = parseQuiz(JSON.stringify(qs), 3);
    expect(out.questions).toHaveLength(3);
  });
});

describe("parseSummary", () => {
  it("accepts {concepts: [...]} shape", () => {
    const raw = JSON.stringify({
      concepts: [
        {
          concept: "React Hooks",
          evidence_quote: "I use useState",
          mastery_estimate: 0.7,
        },
      ],
    });
    const out = parseSummary(raw);
    expect(out.concepts).toHaveLength(1);
    expect(out.concepts[0].concept).toBe("react hook");
    expect(out.concepts[0].mastery_estimate).toBe(0.7);
  });

  it("accepts bare array as shorthand", () => {
    const raw = JSON.stringify([
      {
        concept: "promise",
        evidence_quote: "q",
        mastery_estimate: 0.4,
      },
    ]);
    const out = parseSummary(raw);
    expect(out.concepts).toHaveLength(1);
  });

  it("clamps mastery_estimate to [0,1]", () => {
    const raw = JSON.stringify({
      concepts: [
        { concept: "x", evidence_quote: "q", mastery_estimate: 5 },
        { concept: "y", evidence_quote: "q", mastery_estimate: -1 },
      ],
    });
    const out = parseSummary(raw);
    expect(out.concepts[0].mastery_estimate).toBe(1);
    expect(out.concepts[1].mastery_estimate).toBe(0);
  });

  it("drops concepts missing a concept name", () => {
    const raw = JSON.stringify({
      concepts: [
        { concept: "", evidence_quote: "q", mastery_estimate: 0.5 },
        {
          concept: "valid",
          evidence_quote: "q",
          mastery_estimate: 0.5,
        },
      ],
    });
    const out = parseSummary(raw);
    expect(out.concepts).toHaveLength(1);
    expect(out.concepts[0].concept).toBe("valid");
  });
});

describe("parseGrading", () => {
  it("parses valid grading output", () => {
    const raw = JSON.stringify({
      quality: 4,
      feedback: "great",
      flagged_misconceptions: ["mc1"],
    });
    const out = parseGrading(raw);
    expect(out.quality).toBe(4);
    expect(out.flagged_misconceptions).toEqual(["mc1"]);
  });

  it("clamps quality to 0..5 and rounds", () => {
    expect(parseGrading('{"quality": 7}').quality).toBe(5);
    expect(parseGrading('{"quality": -3}').quality).toBe(0);
    expect(parseGrading('{"quality": 2.6}').quality).toBe(3);
  });

  it("defaults quality to 0 when missing", () => {
    expect(parseGrading('{"feedback": "hi"}').quality).toBe(0);
  });
});

describe("normalizeConcept", () => {
  it("lowercases, trims, collapses whitespace", () => {
    expect(normalizeConcept("  React   Hooks  ")).toBe("react hook");
  });

  it("strips trailing -s pluralization (length > 2)", () => {
    expect(normalizeConcept("Promises")).toBe("promise");
    expect(normalizeConcept("loops")).toBe("loop");
  });

  it("keeps trailing -ss", () => {
    expect(normalizeConcept("class")).toBe("class");
  });

  it("short strings stay as-is (<=2 chars)", () => {
    expect(normalizeConcept("is")).toBe("is");
  });

  it("NFC normalizes accented input", () => {
    // NFD: combining acute
    const nfd = "art\u0069\u0301culo";
    expect(normalizeConcept(nfd)).toBe("artículo".normalize("NFC"));
  });

  it("acronym guard: HTTPS / TCP / UDP stay atomic (don't collapse to http/tc/ud)", () => {
    expect(normalizeConcept("HTTPS")).toBe("https");
    expect(normalizeConcept("TCP")).toBe("tcp");
    expect(normalizeConcept("UDP")).toBe("udp");
    expect(normalizeConcept("CORS")).toBe("cors");
  });

  it("pluralized acronyms merge to their singular form (APIs → api, URLs → url)", () => {
    expect(normalizeConcept("API")).toBe("api");
    expect(normalizeConcept("APIs")).toBe("api");
    expect(normalizeConcept("URL")).toBe("url");
    expect(normalizeConcept("URLs")).toBe("url");
    expect(normalizeConcept("GPUs")).toBe("gpu");
  });

  it("protected scientific endings don't strip trailing s (analysis/status/bias/physics)", () => {
    // Covers -is, -us, -ics, -sis. `series` ends in -ies which we don't guard
    // because that would also protect storie-s/categorie-s which ARE plurals.
    expect(normalizeConcept("analysis")).toBe("analysis");
    expect(normalizeConcept("status")).toBe("status");
    expect(normalizeConcept("bias")).toBe("bias");
    expect(normalizeConcept("physics")).toBe("physics");
    expect(normalizeConcept("hypothesis")).toBe("hypothesis");
  });
});
