/**
 * Keyword extraction tests.
 */

import { describe, it, expect } from "vitest";
import { extractKeywords } from "./keywords.js";

describe("extractKeywords", () => {
  it("should extract meaningful words from title and description", () => {
    const keywords = extractKeywords(
      "Fix database migration",
      "The migration script fails on production with timeout errors",
    );
    expect(keywords).toContain("fix");
    expect(keywords).toContain("database");
    expect(keywords).toContain("migration");
    expect(keywords).toContain("script");
    expect(keywords).toContain("production");
    expect(keywords).toContain("timeout");
    expect(keywords).toContain("errors");
  });

  it("should remove stopwords", () => {
    const keywords = extractKeywords(
      "Get the user from the database",
      "We need to get all users and their data",
    );
    expect(keywords).not.toContain("the");
    expect(keywords).not.toContain("from");
    expect(keywords).not.toContain("and");
    expect(keywords).not.toContain("need");
    expect(keywords).toContain("user");
    expect(keywords).toContain("database");
    expect(keywords).toContain("data");
  });

  it("should filter words shorter than 3 chars", () => {
    const keywords = extractKeywords("Do it", "Go to db");
    expect(keywords).not.toContain("do");
    expect(keywords).not.toContain("it");
    expect(keywords).not.toContain("go");
    expect(keywords).not.toContain("to");
    expect(keywords).not.toContain("db");
  });

  it("should return at most 8 keywords", () => {
    const keywords = extractKeywords(
      "one two three four five six seven eight nine ten",
      "eleven twelve thirteen fourteen fifteen",
    );
    expect(keywords.length).toBeLessThanOrEqual(8);
  });

  it("should deduplicate keywords", () => {
    const keywords = extractKeywords(
      "database migration",
      "database migration error in database",
    );
    const dbCount = keywords.filter((k) => k === "database").length;
    expect(dbCount).toBe(1);
  });

  it("should return empty array for empty input", () => {
    expect(extractKeywords("", "")).toEqual([]);
  });

  it("should return empty array for all-stopword input", () => {
    expect(extractKeywords("the and or", "is it to")).toEqual([]);
  });

  it("should lowercase all keywords", () => {
    const keywords = extractKeywords("FIX Database", "Production ERROR");
    for (const k of keywords) {
      expect(k).toBe(k.toLowerCase());
    }
  });
});
