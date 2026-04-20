---
name: gdocs_read_full audit (jarvis/feat/gdocs-read-full branch)
description: Audit of Jarvis autonomous tool addition for full-document Google Docs reading via Drive Export API
type: project
---

Audit date: 2026-04-16
Branch: jarvis/feat/gdocs-read-full (uncommitted)

## Verdict: FAIL — Registration gaps prevent tool from ever loading

## Critical

1. **`gdocs_read_full` missing from `GOOGLE_TOOLS` in src/messaging/scope.ts:35-61.** The tool source registers it, but the scope system never exposes it to the LLM prompt because it's not in the scope group. When scope activates `google`, the new tool is NOT included. Combined with `deferred: true`, this means the tool is effectively invisible. Fix: add `"gdocs_read_full"` to the `GOOGLE_TOOLS` array between `gdocs_read` and `gdocs_write`.

2. **`gdocs_read_full` missing from `READ_ONLY_TOOLS` in src/inference/guards.ts:32-38.** Read-only classification drives `isReadOnlyTool()` and `allToolCallsReadOnly()` used by hallucination guards and write-verification logic. Consequence: the new read tool may be treated as non-read-only by downstream guards. Fix: add `"gdocs_read_full"` in the Google read-only section.

## Major

3. **10s timeout unchanged for long documents.** `googleFetch` uses `DEFAULT_TIMEOUT_MS = 10_000` (client.ts:13). The entire point of this tool is reading _long_ docs, yet it calls googleFetch twice sequentially (meta + export) with 10s each. A 100k-char doc export can easily exceed that. Fix: pass `{ rawText: true, timeout: 30_000 }` on the export call.

4. **No test file for google-docs.** `src/tools/builtin/google-docs.test.ts` does not exist. Zero coverage for: the new tool, the truncation-warning branch, rawText path in googleFetch, Drive API error handling. Jarvis shipped a new untested tool. Fix: add at least unit tests that mock `googleFetch` for success, truncation, and export-failure paths.

5. **`gdocs_read_full` missing from auto-persist trigger (src/memory/auto-persist.ts:140-145).** Rule 2b persists document reads so follow-up turns can recall the content. Currently checks only `gsheets_read | gdocs_read | file_read`. The whole point of `gdocs_read_full` is long content that is MORE important to persist. Fix: add `"gdocs_read_full"` to the OR list.

## Minor

6. **Output omits `document_id`** (google-docs.ts:426-430). Same bug already documented in google-workspace-audit.md (2026-04-10) for `gdocs_read`. After context compaction, a follow-up `gdocs_write` loses the ID. Fix: include `document_id: docId` in the response.

7. **Two sequential round-trips when one suffices.** Step 1 fetches title from Docs API, step 2 exports via Drive API. Drive API can return name + export in a single metadata fetch (`drive/v3/files/{id}?fields=name`) or use export's own response headers. A single call would halve latency and failure surface. Fix: replace Docs-title call with `drive/v3/files/{id}?fields=name`.

8. **JSON output inconsistent with pre-format convention.** Prior audit flagged `gdocs_read` as already inconsistent (returns JSON while `gsheets_read`/`gslides_read` return markdown). `gdocs_read_full` continues this anti-pattern. Per feedback_preformat_over_prompt: tools that return JSON get narrativized by the LLM. Fix: consider returning `"# {title}\n\n{text}"` like `gsheets_read`.

9. **No `triggerPhrases` on the new tool.** `gslides_read` has them ("lee esta presentación" etc.). Deferred tools benefit from trigger phrases because they accelerate scope activation for content-intent messages. Fix: add trigger phrases like "lee el documento completo", "read full doc", "documento completo".

10. **No handling for Drive Export 10MB limit.** Docs Export API returns HTTP 403 with "exportSizeLimitExceeded" for docs >10MB exported. Current error wrapping shows a generic message; LLM cannot recover. Fix: detect this specific status and suggest splitting or using the Docs API streaming.

11. **Description doesn't document the failure mode "for docs too large to export".** The "HOW IT WORKS" claims "returns ALL text" unconditionally. Set realistic expectation: "up to ~10MB exported text".

## Info

- Typecheck passes.
- Both registration hunks in `google.ts` (destructured import + tools array) are correct — the diff reading two separate hunks was accurate.
- `rawText` option is correctly isolated from `rawBody`/`contentType`/`body` — no conflict paths.
- Cast `(await response.text()) as unknown as T` is the idiomatic double-cast for "caller asserts T=string". Fine.
- 8000-char truncation boundary: `text.length > 8000` with `slice(0, 8000)` is correct — no off-by-one.
- `deferred: true` consistent with sibling `gdocsReadTool`.
- Drive API scope authorization likely OK since `gdrive_list`, `gdrive_create`, `gdrive_upload` already work — they require the same `drive` scope family.
