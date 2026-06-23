/**
 * Pure display formatters for `mc-ctl judgments`. Focus: the defensive
 * JSON-parsing degradation paths (null / non-array / malformed / missing
 * fields) that the live 15-judgment run could not exercise (all had valid JSON).
 */

import { describe, expect, it } from "vitest";
import {
  confShort,
  relAge,
  pad,
  truncate,
  criticVerdict,
  confidenceBasis,
  renderOptions,
} from "./judgment-format.js";

describe("confShort", () => {
  it("maps the three colors and passes through unknowns / null", () => {
    expect(confShort("green")).toBe("grn");
    expect(confShort("yellow")).toBe("yel");
    expect(confShort("red")).toBe("red");
    expect(confShort(null)).toBe("—");
    expect(confShort("teal")).toBe("teal");
  });
});

describe("relAge", () => {
  const now = Date.parse("2026-06-23T12:00:00.000Z");
  it("coarse-grains seconds / minutes / hours / days", () => {
    expect(relAge("2026-06-23T11:59:30.000Z", now)).toBe("30s");
    expect(relAge("2026-06-23T11:30:00.000Z", now)).toBe("30m");
    expect(relAge("2026-06-23T08:00:00.000Z", now)).toBe("4h");
    expect(relAge("2026-06-20T12:00:00.000Z", now)).toBe("3d");
  });
  it("clamps a future timestamp to 0s and returns ? for garbage", () => {
    expect(relAge("2026-06-23T12:01:00.000Z", now)).toBe("0s");
    expect(relAge("not-a-date", now)).toBe("?");
  });
});

describe("pad / truncate", () => {
  it("pad right-fills but never truncates", () => {
    expect(pad("ab", 5)).toBe("ab   ");
    expect(pad("abcde", 3)).toBe("abcde");
  });
  it("truncate collapses whitespace and elides with …", () => {
    expect(truncate("a   b\n c", 80)).toBe("a b c");
    expect(truncate("abcdef", 4)).toBe("abc…");
  });
});

describe("criticVerdict", () => {
  it("reads a string verdict from the trail", () => {
    expect(criticVerdict('{"verdict":"approved","iterations":1}')).toBe(
      "approved",
    );
    expect(criticVerdict('{"verdict":"unfixable"}')).toBe("unfixable");
  });
  it("degrades to — on null / no-verdict / non-string / malformed", () => {
    expect(criticVerdict(null)).toBe("—");
    expect(criticVerdict("{}")).toBe("—");
    expect(criticVerdict('{"verdict":3}')).toBe("—");
    expect(criticVerdict("{not json")).toBe("—");
  });
});

describe("confidenceBasis", () => {
  it("formats the three basis terms", () => {
    expect(
      confidenceBasis(
        '{"distinct_sources":4,"contradiction_count":0,"stale_count":1}',
      ),
    ).toBe("sources=4 contradictions=0 stale=1");
  });
  it("uses ? for missing fields and degrades on null / malformed", () => {
    expect(confidenceBasis('{"distinct_sources":2}')).toBe(
      "sources=2 contradictions=? stale=?",
    );
    expect(confidenceBasis(null)).toBe("(no basis recorded)");
    expect(confidenceBasis("{oops")).toBe("(unparseable basis)");
  });
});

describe("renderOptions", () => {
  it("renders label as tag + summary as body", () => {
    const json = JSON.stringify([
      { label: "A", summary: "do the thing" },
      { label: "B", summary: "do another" },
    ]);
    expect(renderOptions(json)).toEqual(["A. do the thing", "B. do another"]);
  });
  it("falls back to A/B/C tags when label is missing or too long", () => {
    const json = JSON.stringify([
      { summary: "first" },
      { label: "a-very-long-label", title: "second" },
    ]);
    expect(renderOptions(json)).toEqual(["A. first", "B. second"]);
  });
  it("handles primitive items and objects with only a label", () => {
    expect(renderOptions(JSON.stringify(["x", "y"]))).toEqual(["A. x", "B. y"]);
    expect(renderOptions(JSON.stringify([{ label: "Q" }]))).toEqual(["Q. Q"]);
  });
  it("degrades to [] on null / non-array / malformed", () => {
    expect(renderOptions(null)).toEqual([]);
    expect(renderOptions('{"not":"an array"}')).toEqual([]);
    expect(renderOptions("[bad json")).toEqual([]);
  });
});
