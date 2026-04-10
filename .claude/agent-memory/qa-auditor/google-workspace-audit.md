---
name: Google Workspace tools audit
description: Comprehensive audit of Google Workspace tool chains, scope injection, browser anti-patterns, and missing capabilities
type: project
---

Audit date: 2026-04-10

## Key Files

- Google Gmail tools: `src/tools/builtin/google-gmail.ts`
- Google Drive tools: `src/tools/builtin/google-drive.ts`
- Google Calendar tools: `src/tools/builtin/google-calendar.ts`
- Google Docs/Sheets/Slides/Tasks: `src/tools/builtin/google-docs.ts`
- Scope system: `src/messaging/scope.ts`
- Scope classifier: `src/messaging/scope-classifier.ts`

## Critical Findings

1. URL scope injection (scope.ts:358-363) only covers `docs.google.com/{document|spreadsheets|presentation}` — misses `drive.google.com`, `mail.google.com`, `calendar.google.com`. When semantic classifier is active (normal path), these URLs activate `browser` instead of `google` scope.
2. Browser anti-pattern warning ("DO NOT USE browser\_\_goto") exists ONLY on `gslides_read` — missing from `gdocs_read`, `gsheets_read`, `gmail_read`, `gdrive_list`.

## Chain Gaps

- `gdocs_read` returns `{title, text}` without `document_id` — breaks follow-up `gdocs_write` after context compaction
- `gsheets_read` pre-formatted output omits `spreadsheet_id` — same issue for `gsheets_write`
- `gdocs_read` description is a one-liner vs `gslides_read` which has full ACI description

## Patterns

- 20 Google tools in `GOOGLE_TOOLS` array in scope.ts
- Pre-format convention: `gmail_search`, `gslides_read`, `gsheets_read` return markdown; `gdocs_read` returns JSON (inconsistent)
- `triggerPhrases` present on `gslides_read` but not on other Google read tools

**Why:** Two production bugs (gmail_search missing IDs, gslides_read nonexistent) were fixed, but the root cause (scope activation failure on Google URLs) partially persists.

**How to apply:** When auditing scope or tool chains, check both the semantic classifier path AND the regex fallback path. The URL injection regex must cover all domains the tools serve.
