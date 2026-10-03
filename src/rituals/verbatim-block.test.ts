/**
 * verbatim-block edges (2026-10-03 audit fold): credential redaction of the
 * loaded text, the trailing-newline cut, and surrogate-safe cuts.
 * Secret-shaped fixtures are assembled at runtime (public repo).
 */

import { describe, it, expect, vi } from "vitest";

const getFile = vi.hoisted(() => vi.fn());
vi.mock("../db/jarvis-fs.js", () => ({ getFile }));

import { loadKbText, renderVerbatimBlock } from "./verbatim-block.js";

const BOT = ["7654321098", "Q".repeat(33) + "-x"].join(":");
const SK = ["sk", "proj", "Zz".repeat(12)].join("-");

function bodyOf(block: string): string {
  return block.slice(block.indexOf("\n") + 1, block.lastIndexOf("\n"));
}

describe("loadKbText redacts credentials before embedding", () => {
  it("a bot token in a file URL and an API key in the log never reach the block", () => {
    getFile.mockReturnValueOnce({
      content: `- [10:00:00] **USER**: URL Source: https://api.telegram.org/file/bot${BOT}/documents/a.html y la clave ${SK} quedó en el log\n`,
    });
    const text = loadKbText("logs/day-logs/2026-10-01.md")!;
    expect(text).not.toContain(BOT);
    expect(text).not.toContain(SK);
    expect(text).toContain("quedó en el log");
    const block = renderVerbatimBlock("DAY-LOG", "p", text);
    expect(block).not.toContain(BOT);
  });
});

describe("renderVerbatimBlock cut edges", () => {
  it("one long line ending in a newline: keeps the end, never an empty body", () => {
    const content = "a".repeat(50) + "FIN\n";
    const body = bodyOf(renderVerbatimBlock("L", "p", content, 20));
    expect(body.length).toBe(20);
    expect(body.endsWith("FIN")).toBe(true);
  });

  it("several lines ending in a newline: keeps whole trailing lines", () => {
    const content = "uno uno uno\ndos dos dos\ntres tres\n";
    const block = renderVerbatimBlock("L", "p", content, 15);
    expect(bodyOf(block)).toBe("tres tres");
    expect(block).toMatch(/TRUNCATED — the first 24 of 33 chars/);
  });

  it("a plain cut never starts on a lone low surrogate", () => {
    // "😀" is 2 UTF-16 units; a 5-unit cut over 4 emoji lands mid-pair.
    const content = "😀😀😀😀";
    const body = bodyOf(renderVerbatimBlock("L", "p", content, 5));
    expect(body).toBe("😀😀");
    expect(body).not.toMatch(/^[\uDC00-\uDFFF]/);
  });

  it("under the cap: complete, trailing newline trimmed", () => {
    const block = renderVerbatimBlock("L", "p", "hola\n\n", 100);
    expect(block).toBe("⟦BEGIN L — p — 4 chars, complete⟧\nhola\n⟦END L⟧");
  });
});
