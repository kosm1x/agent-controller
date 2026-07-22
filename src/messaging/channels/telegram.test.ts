/**
 * Tests for the Telegram attachment persistence helper (2026-07-22 fix:
 * document bytes are saved to /tmp/jarvis-downloads so pdf_read/gemini_upload
 * have a real source path — previously discarded after text extraction).
 */

import { describe, it, expect } from "vitest";
import { sanitizeAttachmentName } from "./telegram.js";

describe("sanitizeAttachmentName", () => {
  it("keeps ordinary filenames intact", () => {
    expect(sanitizeAttachmentName("EurekaMS_Intelligence_Evolution.pdf")).toBe(
      "EurekaMS_Intelligence_Evolution.pdf",
    );
    expect(sanitizeAttachmentName("report-v2.1.pdf")).toBe("report-v2.1.pdf");
  });

  it("strips path components (no traversal via file_name)", () => {
    expect(sanitizeAttachmentName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeAttachmentName("/etc/cron.d/evil")).toBe("evil");
  });

  it("replaces shell-hostile characters", () => {
    expect(sanitizeAttachmentName("mi archivo (final) ¡ya!.pdf")).toBe(
      "mi_archivo__final___ya_.pdf",
    );
  });

  it("falls back to 'document' when name is missing or empty", () => {
    expect(sanitizeAttachmentName(undefined)).toBe("document");
    expect(sanitizeAttachmentName("")).toBe("document");
  });

  it("caps length at 120 chars", () => {
    expect(sanitizeAttachmentName("a".repeat(300) + ".pdf").length).toBe(120);
  });
});
