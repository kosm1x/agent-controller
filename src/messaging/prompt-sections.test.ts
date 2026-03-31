/**
 * Tests for prompt-sections.ts — detectToolFlags and conditional sections.
 */

import { describe, it, expect } from "vitest";
import {
  detectToolFlags,
  identitySection,
  commitSection,
  capabilitiesSection,
  wordpressSection,
  codingSection,
  browserSection,
  researchSection,
  confirmationSection,
  toolFirstSection,
} from "./prompt-sections.js";

// ---------------------------------------------------------------------------
// detectToolFlags
// ---------------------------------------------------------------------------

describe("detectToolFlags", () => {
  it("detects browser tools by prefix", () => {
    const flags = detectToolFlags(["browser__goto", "browser__markdown"]);
    expect(flags.hasBrowser).toBe(true);
    expect(flags.hasWordpress).toBe(false);
  });

  it("detects wordpress tools by prefix", () => {
    const flags = detectToolFlags(["wp_list_posts", "wp_publish"]);
    expect(flags.hasWordpress).toBe(true);
    expect(flags.hasBrowser).toBe(false);
  });

  it("detects coding tools by name match", () => {
    const flags = detectToolFlags(["file_read", "grep"]);
    expect(flags.hasCoding).toBe(true);
  });

  it("detects google tools by name match", () => {
    const flags = detectToolFlags(["gmail_send", "calendar_list"]);
    expect(flags.hasGoogle).toBe(true);
  });

  it("detects commit tools by prefix", () => {
    const flags = detectToolFlags(["commit__list_tasks"]);
    expect(flags.hasCommit).toBe(true);
  });

  it("detects research tools by name match", () => {
    const flags = detectToolFlags(["gemini_upload", "gemini_research"]);
    expect(flags.hasResearch).toBe(true);
  });

  it("returns all false for empty tool list", () => {
    const flags = detectToolFlags([]);
    expect(flags.hasBrowser).toBe(false);
    expect(flags.hasWordpress).toBe(false);
    expect(flags.hasCoding).toBe(false);
    expect(flags.hasGoogle).toBe(false);
    expect(flags.hasCommit).toBe(false);
    expect(flags.hasResearch).toBe(false);
  });

  it("returns all false for unrecognized tools", () => {
    const flags = detectToolFlags(["web_search", "user_fact_set"]);
    expect(flags.hasCoding).toBe(false);
    expect(flags.hasGoogle).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Conditional sections — verify they include/exclude content based on flags
// ---------------------------------------------------------------------------

describe("conditional prompt sections", () => {
  it("identitySection includes date and time", () => {
    const s = identitySection("2026-03-31", "14:30");
    expect(s).toContain("2026-03-31");
    expect(s).toContain("14:30");
    expect(s).toContain("Jarvis");
  });

  it("commitSection mentions COMMIT and journal rules", () => {
    const s = commitSection();
    expect(s).toContain("COMMIT");
    expect(s).toContain("diario");
    expect(s).toContain("commit__create_suggestion");
  });

  it("capabilitiesSection includes Google when flag set", () => {
    const flags = detectToolFlags(["gmail_send", "calendar_list"]);
    const s = capabilitiesSection(flags);
    expect(s).toContain("Google Workspace");
    expect(s).toContain("gmail_read");
  });

  it("capabilitiesSection excludes Google when flag not set", () => {
    const flags = detectToolFlags(["web_search"]);
    const s = capabilitiesSection(flags);
    expect(s).not.toContain("Google Workspace");
  });

  it("capabilitiesSection includes coding when flag set", () => {
    const flags = detectToolFlags(["file_read", "shell_exec"]);
    const s = capabilitiesSection(flags);
    expect(s).toContain("Código");
  });

  it("confirmationSection includes gmail_send when google active", () => {
    const flags = detectToolFlags(["gmail_send"]);
    const s = confirmationSection(flags);
    expect(s).toContain("gmail_send");
  });

  it("toolFirstSection includes WP rules when wordpress active", () => {
    const flags = detectToolFlags(["wp_publish"]);
    const s = toolFirstSection(flags);
    expect(s).toContain("wp_publish");
    expect(s).toContain("wp_list_posts");
  });

  it("toolFirstSection excludes WP rules when wordpress inactive", () => {
    const flags = detectToolFlags(["web_search"]);
    const s = toolFirstSection(flags);
    expect(s).not.toContain("wp_publish");
  });

  it("wordpressSection mentions all WP protocols", () => {
    const s = wordpressSection();
    expect(s).toContain("wp_read_post");
    expect(s).toContain("content_file");
    expect(s).toContain("wp_plugins");
  });

  it("codingSection mentions file_edit workflow", () => {
    const s = codingSection();
    expect(s).toContain("file_edit");
    expect(s).toContain("grep");
  });

  it("browserSection mentions browser__click", () => {
    const s = browserSection();
    expect(s).toContain("browser__click");
  });

  it("researchSection mentions gemini_upload workflow", () => {
    const s = researchSection();
    expect(s).toContain("gemini_upload");
    expect(s).toContain("gemini_research");
    expect(s).toContain("48h");
  });
});
