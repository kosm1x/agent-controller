---
name: v7.4 S2a storyboard + cinema-prompts audit
description: Targeted audit of uncommitted S2a surface — storyboard.ts, cinema-prompts.ts, video_storyboard/video_brand_apply tools
type: project
---

# v7.4 S2a Audit — 2026-04-21

## Verdict

PASS WITH WARNINGS. Ship after addressing W1-W3. No criticals.

## Scope

- `src/video/cinema-prompts.ts` (new) + its test
- `src/video/storyboard.ts` (new) + its test
- `src/tools/builtin/video.ts` (added videoStoryboardTool, videoBrandApplyTool)
- `src/tools/sources/builtin.ts`, `src/messaging/scope.ts` (registration)

## Findings

### W1 — Dead data in cinema-prompts catalogs

`storyboard.ts:116-125` only consumes `.id` via `.slice(0, 8).map(m => m.id)`. The `prompt_fragment`, `label`, `tagline`, and `best_for` fields (the actual cinematography vocabulary — 45 entries × 4 fields = 180 unused descriptors) are never read by any runtime consumer. The user's self-check in the prompt ("each catalog is hit") was wrong — only the id list reaches the LLM. This is the most valuable per-entry content being silently stripped. Fix: either consume `prompt_fragment` in `buildStoryboardPrompt` (recommended — gives the LLM real guidance), or strip the richer fields from the interface to reflect reality.

### W2 — URL sanitizer scheme coverage narrow

`storyboard.ts:29` URL_PATTERN is `/\bhttps?:\/\//gi` — leaks `ftp://`, `data:`, `javascript:`, `file://`, and bare domains. Additionally, even for http(s) it only replaces the scheme prefix (`https://evil.com/path` → `[url-redacted]evil.com/path`) — the domain+path still reach the LLM. Severity: low (brief is user-authored, LLM role is narration not instruction-following) but this is defense-in-depth claimed in the module docstring. Either broaden to `/\b(?:https?|ftp|file|data|javascript|mailto):[^\s]+/gi` and match through the full URL, or downgrade the docstring claim.

### W3 — Neither `video_storyboard` nor `video_brand_apply` tool handler is tested

The `execute()` wrappers are untested:

- `video_storyboard` error-serialization path (throws → `JSON.stringify({error})`) uncovered
- `video_brand_apply` covers the _entire_ DB-read + JSON.parse-fallback + summary-shape logic — zero tests. Non-fatal JSON.parse catch silently emits empty `summary` object, operator has no signal. Add at least one positive and one `brand_id not found` test.

### W4 — `extractJsonBlock` naive scan (user pre-acknowledged)

User correctly identified: if LLM emits `{...} chatty text {...}` the scan returns the whole span and JSON.parse throws. Sad UX, not DoS. Acceptable as-is.

### W5 — `video_brand_apply` silent parse failure

`video.ts:1465` `try { JSON.parse(row.profile) } catch { /* non-fatal */ }` emits `summary: { tagline: undefined, voice: undefined, ... }` with no error signal. If a bad row landed, operator sees an empty summary and cannot distinguish "no brand data" from "profile JSON corrupt." Log and/or include a `profile_parse_error: true` field.

## Verified clean

- **SQL safety**: `video_brand_apply` uses `.prepare(...).get(?)` with `Number.isInteger + >= 1` guard on brandId. No injection.
- **imagePath attack**: blocked by `validateManifest` allowlist; test at `storyboard.test.ts:179` confirms `/etc/passwd` rejection.
- **Brand DNA lexicon laundering**: single-pass string concat (no `.replace()` chain, no `{{...}}` substitution on brand fields). Matches `feedback_llm_content_laundering_pattern` requirement. Clean.
- **INJECTION_STOPWORDS not needed**: user's reasoning holds — the LLM is asked to author narration from the brief, not to execute instructions in it. Same pattern as P4a's `ads_creative_gen`.
- **Scope regex**: `/storyboard|guion\s+de\s+v[ií]deo/` in S1 covers both new tools. No regex change required.
- **VIDEO_TOOLS count**: 15 total (13 video\_\* + screenshot_element), matches expected 13+2. No S1 regression.
- **Defensive re-indexing**: tested.
- **Typecheck + all 3568 tests green** (119 video/\*, 11 storyboard).

## Ship recommendation

Ship S2a after W1 fix (consume prompt_fragment — the catalog's whole point) and W3 (at minimum a smoke test for video_brand_apply). W2, W4, W5 can land as follow-ups. No critical blockers.
