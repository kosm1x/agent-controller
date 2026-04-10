---
name: CCP1-CCP4 audit findings
description: Claude Code Prompt patterns batch 1 audit — FAIL, 3 critical (browser tool names, WRITE_VERIFICATION markers, no CCP2 tests)
type: project
---

## CCP1-CCP4 Audit (2026-04-08) — FAIL

3 critical issues found:

1. **C1**: `UNTRUSTED_TOOLS` in guards.ts uses `browser_navigate` etc. (single underscore) but actual tool names are `browser__goto` etc. (double underscore). Injection defense completely non-functional for browser tools.

2. **C2**: `WRITE_VERIFICATION` map has wrong markers for 4/11 tools:
   - `gsheets_write` checks `"updatedCells"` but tool returns `"cells"`
   - `gdocs_write` checks `"documentId"` but tool returns `"document_id"`
   - `wp_publish` checks `"id"` but tool returns `"post_id"`
   - `gcal_create`/`gcal_update`/`wp_update` are dead entries (tools don't exist under those names)

3. **S3**: Zero tests for CCP2 (WRITE_VERIFICATION). Tests would have caught C2 immediately.

**Why:** Marker strings were guessed from API docs rather than verified against actual tool return values. Browser tool naming inconsistency (`_` vs `__`) is a recurring trap in this codebase.

**How to apply:** When adding verification against tool outputs, always grep the actual `JSON.stringify` return in the tool's `execute()` method. Never assume key names from API documentation or memory.
