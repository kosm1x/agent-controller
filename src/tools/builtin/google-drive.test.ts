/**
 * Tests for gdrive_download.
 *
 * Mocks googleFetch + node:fs to avoid real API calls and disk writes.
 * Covers: schema, native-vs-binary path branching, path whitelist,
 * size cap (metadata + post-download), default output path, export_format alias.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  mockGoogleFetch: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  // Default: ENOENT so safe-resolve falls through happily for fresh paths.
  // Tests that exercise the symlink escape override this.
  mockRealpathSync: vi.fn<(p: string) => string>(() => {
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  }),
}));

vi.mock("../../google/client.js", () => ({
  googleFetch: mocks.mockGoogleFetch,
}));

vi.mock("node:fs", () => ({
  mkdirSync: mocks.mockMkdirSync,
  writeFileSync: mocks.mockWriteFileSync,
  realpathSync: mocks.mockRealpathSync,
}));

import { gdriveDownloadTool } from "./google-drive.js";

describe("gdrive_download — schema", () => {
  it("declares file_id as required and exposes safe enums for export_format", () => {
    const fn = gdriveDownloadTool.definition.function;
    expect(fn.name).toBe("gdrive_download");
    expect(fn.parameters?.required).toEqual(["file_id"]);

    const props = fn.parameters?.properties as Record<
      string,
      { type: string; enum?: string[] }
    >;
    expect(props.file_id.type).toBe("string");
    expect(props.output_path.type).toBe("string");
    expect(props.export_format.enum).toEqual([
      "pdf",
      "docx",
      "pptx",
      "xlsx",
      "txt",
      "html",
      "csv",
      "png",
    ]);
  });

  it("is deferred to preserve prompt budget", () => {
    expect(gdriveDownloadTool.deferred).toBe(true);
  });

  it("teaches LLM the URL → file_id extraction", () => {
    expect(gdriveDownloadTool.definition.function.description).toContain(
      "drive.google.com/file/d/",
    );
  });
});

describe("gdrive_download — execution", () => {
  beforeEach(() => {
    mocks.mockGoogleFetch.mockReset();
    mocks.mockMkdirSync.mockReset();
    mocks.mockWriteFileSync.mockReset();
    // Reset realpathSync to default ENOENT behavior between tests
    mocks.mockRealpathSync.mockImplementation(() => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects missing file_id", async () => {
    const result = await gdriveDownloadTool.execute({});
    expect(JSON.parse(result).error).toBe("file_id is required");
    expect(mocks.mockGoogleFetch).not.toHaveBeenCalled();
  });

  it("downloads a binary PDF via alt=media (no export)", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
    mocks.mockGoogleFetch
      .mockResolvedValueOnce({
        id: "abc123",
        name: "Tienditas Telcel.pdf",
        mimeType: "application/pdf",
        size: "4",
      })
      .mockResolvedValueOnce(bytes);

    const result = await gdriveDownloadTool.execute({ file_id: "abc123" });
    const parsed = JSON.parse(result);

    expect(parsed.path).toBe("/tmp/jarvis-downloads/abc123.pdf");
    expect(parsed.name).toBe("Tienditas Telcel.pdf");
    expect(parsed.mimeType).toBe("application/pdf");
    expect(parsed.sizeBytes).toBe(4);

    // Second fetch must use alt=media + rawBytes:true + extended timeout
    const downloadCall = mocks.mockGoogleFetch.mock.calls[1];
    expect(downloadCall[0]).toContain("/files/abc123?alt=media");
    expect(downloadCall[1]).toMatchObject({ rawBytes: true });
    expect(downloadCall[1].timeout).toBeGreaterThan(10_000);

    expect(mocks.mockWriteFileSync).toHaveBeenCalledWith(
      "/tmp/jarvis-downloads/abc123.pdf",
      bytes,
    );
    expect(mocks.mockMkdirSync).toHaveBeenCalledWith("/tmp/jarvis-downloads", {
      recursive: true,
    });
  });

  it("exports a native Google Slides as PDF by default", async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50]);
    mocks.mockGoogleFetch
      .mockResolvedValueOnce({
        id: "slidesId",
        name: "Q4 Strategy",
        mimeType: "application/vnd.google-apps.presentation",
      })
      .mockResolvedValueOnce(pdfBytes);

    const result = await gdriveDownloadTool.execute({ file_id: "slidesId" });
    const parsed = JSON.parse(result);

    const exportCall = mocks.mockGoogleFetch.mock.calls[1];
    expect(exportCall[0]).toContain("/files/slidesId/export");
    expect(exportCall[0]).toContain("mimeType=application%2Fpdf");
    expect(parsed.path).toBe("/tmp/jarvis-downloads/slidesId.pdf");
    expect(parsed.mimeType).toBe("application/pdf");
  });

  it("honors export_format=docx for a Google Doc", async () => {
    const bytes = new Uint8Array([0x50, 0x4b]); // "PK" — docx is a zip
    mocks.mockGoogleFetch
      .mockResolvedValueOnce({
        id: "docId",
        name: "Notes",
        mimeType: "application/vnd.google-apps.document",
      })
      .mockResolvedValueOnce(bytes);

    const result = await gdriveDownloadTool.execute({
      file_id: "docId",
      export_format: "docx",
    });
    const parsed = JSON.parse(result);

    const exportCall = mocks.mockGoogleFetch.mock.calls[1];
    expect(decodeURIComponent(exportCall[0])).toContain(
      "mimeType=application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(parsed.path).toBe("/tmp/jarvis-downloads/docId.docx");
  });

  it("rejects output_path outside the whitelist", async () => {
    mocks.mockGoogleFetch.mockResolvedValueOnce({
      id: "x",
      name: "x.pdf",
      mimeType: "application/pdf",
      size: "10",
    });

    const result = await gdriveDownloadTool.execute({
      file_id: "x",
      output_path: "/etc/jarvis-stolen.pdf",
    });
    const parsed = JSON.parse(result);

    expect(parsed.error).toContain("output_path");
    expect(mocks.mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("accepts output_path under /root/claude/inbox/", async () => {
    const bytes = new Uint8Array([0x25]);
    mocks.mockGoogleFetch
      .mockResolvedValueOnce({
        id: "x",
        name: "x.pdf",
        mimeType: "application/pdf",
        size: "1",
      })
      .mockResolvedValueOnce(bytes);

    const result = await gdriveDownloadTool.execute({
      file_id: "x",
      output_path: "/root/claude/inbox/file.pdf",
    });
    const parsed = JSON.parse(result);

    expect(parsed.path).toBe("/root/claude/inbox/file.pdf");
    expect(parsed.error).toBeUndefined();
  });

  it("rejects output_path under /root/claude/ but outside /root/claude/inbox/", async () => {
    // Whitelist narrowed (S1): the source tree is no longer writable.
    mocks.mockGoogleFetch.mockResolvedValueOnce({
      id: "x",
      name: "x.pdf",
      mimeType: "application/pdf",
      size: "1",
    });

    const result = await gdriveDownloadTool.execute({
      file_id: "x",
      output_path: "/root/claude/mission-control/src/index.ts",
    });
    const parsed = JSON.parse(result);

    expect(parsed.error).toContain("output_path");
    expect(mocks.mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("blocks path traversal via .. (C1 regression)", async () => {
    // Resolves to /etc/passwd which is outside the whitelist.
    mocks.mockGoogleFetch.mockResolvedValueOnce({
      id: "x",
      name: "x.pdf",
      mimeType: "application/pdf",
      size: "1",
    });

    const result = await gdriveDownloadTool.execute({
      file_id: "x",
      output_path: "/tmp/jarvis-downloads/../../etc/jarvis-stolen.pdf",
    });
    const parsed = JSON.parse(result);

    expect(parsed.error).toMatch(/output_path must resolve to a path under/);
    expect(parsed.error).toContain("/etc/jarvis-stolen.pdf");
    expect(mocks.mockGoogleFetch).toHaveBeenCalledTimes(1); // only metadata
    expect(mocks.mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("blocks symlink escape on parent directory (C2 regression)", async () => {
    // Simulate /tmf/jarvis-downloads being a symlink to /etc.
    mocks.mockRealpathSync.mockReturnValueOnce("/etc");
    mocks.mockGoogleFetch.mockResolvedValueOnce({
      id: "x",
      name: "x.pdf",
      mimeType: "application/pdf",
      size: "1",
    });

    const result = await gdriveDownloadTool.execute({
      file_id: "x",
      output_path: "/tmp/jarvis-downloads/file.pdf",
    });
    const parsed = JSON.parse(result);

    expect(parsed.error).toContain("symlinks outside the whitelist");
    expect(parsed.error).toContain("/etc");
    expect(mocks.mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("surfaces a 'note' when export_format is set on a binary file (W3)", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    mocks.mockGoogleFetch
      .mockResolvedValueOnce({
        id: "pdfId",
        name: "report.pdf",
        mimeType: "application/pdf",
        size: "4",
      })
      .mockResolvedValueOnce(bytes);

    const result = await gdriveDownloadTool.execute({
      file_id: "pdfId",
      export_format: "docx",
    });
    const parsed = JSON.parse(result);

    expect(parsed.path).toBe("/tmp/jarvis-downloads/pdfId.pdf");
    expect(parsed.note).toContain("export_format='docx' ignored");
    expect(parsed.note).toContain("application/pdf");
  });

  it("rejects files larger than 50 MB based on metadata size", async () => {
    mocks.mockGoogleFetch.mockResolvedValueOnce({
      id: "huge",
      name: "huge.pdf",
      mimeType: "application/pdf",
      size: String(60 * 1024 * 1024),
    });

    const result = await gdriveDownloadTool.execute({ file_id: "huge" });
    const parsed = JSON.parse(result);

    expect(parsed.error).toContain("too large");
    // Did not attempt the download
    expect(mocks.mockGoogleFetch).toHaveBeenCalledTimes(1);
    expect(mocks.mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("rejects post-download payloads larger than 50 MB", async () => {
    // Native exports don't surface size in metadata — must check after download.
    const tooBig = new Uint8Array(51 * 1024 * 1024);
    mocks.mockGoogleFetch
      .mockResolvedValueOnce({
        id: "doc",
        name: "Big Doc",
        mimeType: "application/vnd.google-apps.document",
      })
      .mockResolvedValueOnce(tooBig);

    const result = await gdriveDownloadTool.execute({ file_id: "doc" });
    const parsed = JSON.parse(result);

    expect(parsed.error).toContain("too large");
    expect(mocks.mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("returns Drive errors in error envelope rather than throwing", async () => {
    mocks.mockGoogleFetch.mockRejectedValueOnce(
      new Error("Google API 404: File not found"),
    );

    const result = await gdriveDownloadTool.execute({ file_id: "missing" });
    const parsed = JSON.parse(result);

    expect(parsed.error).toContain("Drive download failed");
    expect(parsed.error).toContain("File not found");
  });

  it("rejects unknown native MIME with a helpful message", async () => {
    mocks.mockGoogleFetch.mockResolvedValueOnce({
      id: "form",
      name: "Survey",
      mimeType: "application/vnd.google-apps.form",
    });

    const result = await gdriveDownloadTool.execute({ file_id: "form" });
    const parsed = JSON.parse(result);

    expect(parsed.error).toContain("Cannot export");
    expect(parsed.error).toContain("export_format");
  });
});
