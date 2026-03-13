/**
 * Formatter unit tests.
 * Tests markdown conversion for WhatsApp and Telegram, plus message splitting.
 */

import { describe, it, expect } from "vitest";
import {
  formatForWhatsApp,
  formatForTelegram,
  splitMessage,
} from "./formatter.js";

describe("formatForWhatsApp", () => {
  it("should convert **bold** to *bold*", () => {
    expect(formatForWhatsApp("This is **bold** text")).toBe(
      "This is *bold* text",
    );
  });

  it("should convert ## Header to *Header*", () => {
    expect(formatForWhatsApp("## My Header")).toBe("*My Header*");
  });

  it("should convert ### Header to *Header*", () => {
    expect(formatForWhatsApp("### Sub Header")).toBe("*Sub Header*");
  });

  it("should handle multiple bold segments", () => {
    expect(formatForWhatsApp("**one** and **two**")).toBe("*one* and *two*");
  });

  it("should keep bullets as-is", () => {
    expect(formatForWhatsApp("- Item 1\n- Item 2")).toBe("- Item 1\n- Item 2");
  });

  it("should return empty string for empty input", () => {
    expect(formatForWhatsApp("")).toBe("");
  });

  it("should pass through text with no markdown", () => {
    const text = "Hello, this is plain text.";
    expect(formatForWhatsApp(text)).toBe(text);
  });

  it("should convert __italic__ to _italic_", () => {
    expect(formatForWhatsApp("This is __italic__ text")).toBe(
      "This is _italic_ text",
    );
  });
});

describe("formatForTelegram", () => {
  it("should convert **bold** to *bold*", () => {
    const result = formatForTelegram("This is **bold** text");
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("*bold*");
  });

  it("should convert ## Header to *Header*", () => {
    const result = formatForTelegram("## My Header");
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("*");
    expect(result[0]).toContain("My Header");
  });

  it("should escape special chars outside format markers", () => {
    const result = formatForTelegram("Price is $10.00!");
    expect(result[0]).toContain("\\.");
    expect(result[0]).toContain("\\!");
  });

  it("should escape parentheses", () => {
    const result = formatForTelegram("Hello (world)");
    expect(result[0]).toContain("\\(");
    expect(result[0]).toContain("\\)");
  });

  it("should return array with single element for short text", () => {
    expect(formatForTelegram("Hello")).toHaveLength(1);
  });

  it("should return empty-ish result for empty input", () => {
    const result = formatForTelegram("");
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("");
  });

  it("should split text over 4096 chars", () => {
    // Build a text with multiple paragraphs totaling >4096 chars
    const paragraph = "A".repeat(2000);
    const longText = `**Bold header**\n\n${paragraph}\n\n${paragraph}\n\n${paragraph}`;
    const result = formatForTelegram(longText);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
  });
});

describe("splitMessage", () => {
  it("should return single element for short text", () => {
    expect(splitMessage("Hello", 100)).toEqual(["Hello"]);
  });

  it("should split at paragraph boundaries", () => {
    const text = "Paragraph 1\n\nParagraph 2\n\nParagraph 3";
    const result = splitMessage(text, 25);
    expect(result.length).toBeGreaterThan(1);
    expect(result[0]).toContain("Paragraph 1");
  });

  it("should split at sentence boundaries when paragraph exceeds limit", () => {
    const text = "First sentence. Second sentence. Third sentence.";
    const result = splitMessage(text, 30);
    expect(result.length).toBeGreaterThan(1);
  });

  it("should hard-split single long word exceeding limit", () => {
    const text = "A".repeat(200);
    const result = splitMessage(text, 50);
    expect(result.length).toBe(4);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(50);
    }
  });

  it("should handle text exactly at limit", () => {
    const text = "A".repeat(100);
    expect(splitMessage(text, 100)).toEqual([text]);
  });
});
