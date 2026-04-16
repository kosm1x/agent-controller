/**
 * Tests for gdocs_read and gdocs_read_full.
 *
 * Mocks googleFetch to avoid real API calls. Covers:
 * - gdocs_read_full: happy path (title + full text), export error, document_id echo
 * - gdocs_read: truncation warning at 8000-char boundary, document_id echo
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  mockGoogleFetch: vi.fn(),
}));

vi.mock("../../google/client.js", () => ({
  googleFetch: mocks.mockGoogleFetch,
}));

import { gdocsReadTool, gdocsReadFullTool } from "./google-docs.js";

describe("gdocs_read_full", () => {
  beforeEach(() => {
    mocks.mockGoogleFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns full document text with title, document_id, and char count", async () => {
    const docId = "1AbCdEfGhIjKlMnOpQr";
    const fullText = "x".repeat(25_000);
    mocks.mockGoogleFetch
      .mockResolvedValueOnce({ title: "My Long Doc" })
      .mockResolvedValueOnce(fullText);

    const result = await gdocsReadFullTool.execute({ document_id: docId });
    const parsed = JSON.parse(result);

    expect(parsed.document_id).toBe(docId);
    expect(parsed.title).toBe("My Long Doc");
    expect(parsed.text).toBe(fullText);
    expect(parsed.chars).toBe(25_000);
    expect(parsed.error).toBeUndefined();
  });

  it("passes rawText:true and extended timeout to the Drive export call", async () => {
    mocks.mockGoogleFetch
      .mockResolvedValueOnce({ title: "Doc" })
      .mockResolvedValueOnce("text");

    await gdocsReadFullTool.execute({ document_id: "123" });

    const exportCallArgs = mocks.mockGoogleFetch.mock.calls[1];
    expect(exportCallArgs[0]).toContain("/drive/v3/files/123/export");
    expect(exportCallArgs[0]).toContain("mimeType=text%2Fplain");
    expect(exportCallArgs[1]).toEqual({ rawText: true, timeout: 30_000 });
  });

  it("returns error envelope when export fails", async () => {
    mocks.mockGoogleFetch
      .mockResolvedValueOnce({ title: "Doc" })
      .mockRejectedValueOnce(
        new Error("Google API 403: exportSizeLimitExceeded"),
      );

    const result = await gdocsReadFullTool.execute({ document_id: "123" });
    const parsed = JSON.parse(result);

    expect(parsed.error).toContain("Docs full read failed");
    expect(parsed.error).toContain("exportSizeLimitExceeded");
    expect(parsed.text).toBeUndefined();
  });

  it("surfaces Docs API meta-fetch errors", async () => {
    mocks.mockGoogleFetch.mockRejectedValueOnce(
      new Error("Google API 404: document not found"),
    );

    const result = await gdocsReadFullTool.execute({ document_id: "bad-id" });
    const parsed = JSON.parse(result);

    expect(parsed.error).toContain("Docs full read failed");
    expect(parsed.error).toContain("404");
  });
});

describe("gdocs_read truncation", () => {
  beforeEach(() => {
    mocks.mockGoogleFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Build a fake Docs API response whose rendered text has `chars` characters. */
  const buildDoc = (title: string, chars: number) => ({
    title,
    body: {
      content: [
        {
          paragraph: {
            elements: [{ textRun: { content: "a".repeat(chars) } }],
          },
        },
      ],
    },
  });

  it("returns untruncated text and no warning when under 8000 chars", async () => {
    mocks.mockGoogleFetch.mockResolvedValueOnce(buildDoc("Short Doc", 500));

    const result = await gdocsReadTool.execute({ document_id: "abc" });
    const parsed = JSON.parse(result);

    expect(parsed.document_id).toBe("abc");
    expect(parsed.title).toBe("Short Doc");
    expect(parsed.text.length).toBe(500);
    expect(parsed.warning).toBeUndefined();
  });

  it("truncates at 8000 chars and emits a warning pointing to gdocs_read_full", async () => {
    mocks.mockGoogleFetch.mockResolvedValueOnce(buildDoc("Long Doc", 12_000));

    const result = await gdocsReadTool.execute({ document_id: "abc" });
    const parsed = JSON.parse(result);

    expect(parsed.text.length).toBe(8000);
    expect(parsed.warning).toContain("8,000 chars");
    expect(parsed.warning).toContain("12000");
    expect(parsed.warning).toContain("gdocs_read_full");
  });
});
