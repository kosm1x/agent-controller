## v4.0.1 Inference Robustness Fixes (2026-03-30)

### Issue 1: Truncated tool args cascade

- Model generated 15,350 chars of wp_publish content inline
- Output hit max_tokens, JSON truncated mid-string
- Malformed `function.arguments` in conversation history → all providers HTTP 400
- Fix: sanitize truncated args to valid JSON (`{_truncated: true}`) + catch-block guard

### Issue 2: Parameter name mismatch

- Model called file_write with `file_path` instead of `path`
- Zod schema rejected before execute() → content file never created → empty WP post
- Fix: `normalizeArgAliases()` — 12 common LLM parameter aliases mapped before validation

### Issue 3: wp_publish inline content too large

- Tool description encouraged inline `content` for new posts
- Fix: description now mandates file_write + content_file for anything >2 paragraphs

### Files changed

- `src/inference/adapter.ts` — args sanitization, normalizeArgAliases(), ARG_ALIASES map
- `src/tools/builtin/wordpress.ts` — file-first workflow in description
- `src/tools/builtin/file.ts` — path alias in execute()
- `src/tools/builtin/code-editing.ts` — path/old_string/new_string aliases in execute()
