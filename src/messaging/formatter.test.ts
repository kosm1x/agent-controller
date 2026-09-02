/**
 * Formatter unit tests.
 * Tests markdown conversion for WhatsApp and Telegram, plus message splitting.
 */

import { describe, it, expect } from "vitest";
import {
  formatForWhatsApp,
  formatForTelegram,
  formatForEmail,
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
  it("should convert **bold** to <b>bold</b>", () => {
    const result = formatForTelegram("This is **bold** text");
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("<b>bold</b>");
  });

  it("should convert ## Header to <b>Header</b>", () => {
    const result = formatForTelegram("## My Header");
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("<b>My Header</b>");
  });

  it("should not escape dots and exclamation marks", () => {
    const result = formatForTelegram("Price is $10.00!");
    expect(result[0]).not.toContain("\\.");
    expect(result[0]).not.toContain("\\!");
    expect(result[0]).toContain("10.00!");
  });

  it("should not escape parentheses", () => {
    const result = formatForTelegram("Hello (world)");
    expect(result[0]).not.toContain("\\(");
    expect(result[0]).toContain("(world)");
  });

  it("should escape HTML entities", () => {
    const result = formatForTelegram("A < B & C > D");
    expect(result[0]).toContain("&lt;");
    expect(result[0]).toContain("&amp;");
    expect(result[0]).toContain("&gt;");
  });

  it("should strip LLM backslash artifacts", () => {
    const result = formatForTelegram("Hello \\*world\\* and \\(test\\)");
    expect(result[0]).not.toContain("\\*");
    expect(result[0]).not.toContain("\\(");
  });

  it("should handle header with nested bold", () => {
    const result = formatForTelegram("### 📧 **REPORTES ACTIVOS**");
    expect(result[0]).toContain("<b>");
    expect(result[0]).not.toContain("**");
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
    const paragraph = "A".repeat(2000);
    const longText = `**Bold header**\n\n${paragraph}\n\n${paragraph}\n\n${paragraph}`;
    const result = formatForTelegram(longText);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
  });

  // Task 8964 (2026-09-01): a ```bash block with "# 1. …" comment lines reached
  // Telegram as ``<code>bash … <b>1. …</b> … </code>`` — the fence paired with
  // the closing fence as ONE inline span and the header rule ran inside it.
  describe("code spans are literal", () => {
    it("renders a fenced block as <pre> with the fence and language tag dropped", () => {
      const [out] = formatForTelegram("Run:\n```bash\nls -la\n```\ndone");
      expect(out).toBe("Run:\n<pre>ls -la</pre>\ndone");
    });

    it("runs no markdown rule inside a fenced block", () => {
      const [out] = formatForTelegram(
        "```bash\n# 1. Instalar el service:\ncp a b && systemctl enable --now x\n**not bold** *.ts ~~keep~~\n```",
      );
      expect(out).toBe(
        "<pre># 1. Instalar el service:\ncp a b &amp;&amp; systemctl enable --now x\n**not bold** *.ts ~~keep~~</pre>",
      );
      expect(out).not.toContain("`");
      expect(out).not.toContain("<b>");
    });

    it("escapes HTML inside a fenced block exactly once", () => {
      const [out] = formatForTelegram("```\na < b && c > d\n```");
      expect(out).toBe("<pre>a &lt; b &amp;&amp; c &gt; d</pre>");
    });

    it("keeps a Caddy block with braces and a systemd [Unit] header intact", () => {
      const [out] = formatForTelegram(
        "```\n[Unit]\nDescription=Trustr API\n```\n```\napi.example.com {\n    reverse_proxy localhost:3010\n}\n```",
      );
      expect(out).toBe(
        "<pre>[Unit]\nDescription=Trustr API</pre>\n<pre>api.example.com {\n    reverse_proxy localhost:3010\n}</pre>",
      );
    });

    it("does not italicize or bold inside inline code", () => {
      const [out] = formatForTelegram("Edit `src/*.ts` and `**/*.js` now");
      expect(out).toBe(
        "Edit <code>src/*.ts</code> and <code>**/*.js</code> now",
      );
    });

    it("still converts markdown around the code spans", () => {
      const [out] = formatForTelegram(
        "## Deploy\n\n**Step** `npm run build`\n```\nx\n```\n*done*",
      );
      expect(out).toBe(
        "<b>Deploy</b>\n\n<b>Step</b> <code>npm run build</code>\n<pre>x</pre>\n<i>done</i>",
      );
    });

    it("closes and reopens <pre> when a fenced block straddles the 4096 split", () => {
      const line = "x".repeat(80) + "\n";
      const chunks = formatForTelegram("```\n" + line.repeat(70) + "```");
      expect(chunks.length).toBeGreaterThan(1);
      for (const c of chunks) {
        expect(c.length).toBeLessThanOrEqual(4096);
        expect((c.match(/<pre>/g) ?? []).length).toBe(
          (c.match(/<\/pre>/g) ?? []).length,
        );
      }
      expect(chunks[0].endsWith("</pre>")).toBe(true);
      expect(chunks[1].startsWith("<pre>")).toBe(true);
    });

    it("leaves an unclosed fence alone instead of pairing it across lines", () => {
      const [out] = formatForTelegram("```bash\nls\nno closing fence");
      expect(out).toBe("```bash\nls\nno closing fence");
    });
  });
});

describe("formatForEmail", () => {
  it("should strip **bold** markers", () => {
    expect(formatForEmail("This is **bold** text")).toBe("This is bold text");
  });

  it("should strip ## header markers", () => {
    expect(formatForEmail("## My Header")).toBe("My Header");
  });

  it("should strip single-asterisk italics", () => {
    expect(formatForEmail("an *italic* word")).toBe("an italic word");
  });

  it("should strip inline code backticks", () => {
    expect(formatForEmail("run `npm test` now")).toBe("run npm test now");
  });

  it("should keep code fence contents and drop the fences", () => {
    expect(formatForEmail("```js\nconst x = 1;\n```")).toBe("const x = 1;");
  });

  it("should convert links to text (url)", () => {
    expect(formatForEmail("see [docs](https://x.com)")).toBe(
      "see docs (https://x.com)",
    );
  });

  it("should leave bullet lists readable", () => {
    expect(formatForEmail("- one\n- two")).toBe("- one\n- two");
  });

  it("should return empty string for empty input", () => {
    expect(formatForEmail("")).toBe("");
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
