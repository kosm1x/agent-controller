/**
 * Compile-time sync test — ensures WRITE_TOOLS in fast-runner.ts stays
 * in sync with the write-capable tools defined in scope.ts.
 *
 * From v4.0.18 QA audit: 11 phantom Google tool names went undetected
 * because there was no automated cross-reference. This test prevents
 * that class of bug from recurring.
 */

import { describe, it, expect } from "vitest";
import { WRITE_TOOLS } from "./fast-runner.js";
import {
  GOOGLE_TOOLS,
  WORDPRESS_TOOLS,
  CODING_TOOLS,
} from "../messaging/scope.js";

/** Google tools that are read-only (not expected in WRITE_TOOLS). */
const GOOGLE_READ_ONLY = new Set([
  "gmail_search",
  "gmail_read",
  "gsheets_read",
  "gdocs_read",
  "gdrive_list",
  "calendar_list",
]);

/** WordPress tools that are read-only. */
const WP_READ_ONLY = new Set([
  "wp_list_posts",
  "wp_read_post",
  "wp_categories",
  "wp_pages",
]);

describe("WRITE_TOOLS sync", () => {
  it("includes all write-capable Google tools", () => {
    const googleWriteTools = GOOGLE_TOOLS.filter(
      (t) => !GOOGLE_READ_ONLY.has(t),
    );
    for (const tool of googleWriteTools) {
      expect(WRITE_TOOLS.has(tool), `Missing from WRITE_TOOLS: ${tool}`).toBe(
        true,
      );
    }
  });

  it("includes all write-capable WordPress tools", () => {
    const wpWriteTools = WORDPRESS_TOOLS.filter((t) => !WP_READ_ONLY.has(t));
    for (const tool of wpWriteTools) {
      expect(WRITE_TOOLS.has(tool), `Missing from WRITE_TOOLS: ${tool}`).toBe(
        true,
      );
    }
  });

  it("includes all write-capable coding tools", () => {
    const CODING_READ_ONLY = new Set([
      "shell_exec",
      "grep",
      "glob",
      "list_dir",
      "git_status",
      "git_diff",
      "code_search",
      "jarvis_diagnose",
      "jarvis_test_run",
      "vps_status",
      "vps_backup",
      "vps_logs",
    ]);
    const codingWriteTools = CODING_TOOLS.filter(
      (t) => !CODING_READ_ONLY.has(t),
    );
    for (const tool of codingWriteTools) {
      expect(WRITE_TOOLS.has(tool), `Missing from WRITE_TOOLS: ${tool}`).toBe(
        true,
      );
    }
  });

  it("every WRITE_TOOLS entry follows tool naming convention", () => {
    for (const tool of WRITE_TOOLS) {
      expect(tool).toMatch(/^[a-z][a-z0-9_]+$/);
    }
  });
});
