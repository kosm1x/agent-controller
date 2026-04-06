---
name: v6.0 S7 Audit - Semantic Code Search
description: Audit findings for code-index.ts + code-search tool. LIKE wildcard escape, INTEGER/boolean mismatch, stale index gap, thin tests
type: project
---

## v6.0 S7 Audit (2026-04-05)

Regex-based code indexer: extractSymbols, rebuildIndex, searchCode, symbolsInFile. ~879 symbols in SQLite code_index table.

### Key Findings

- **LIKE wildcard escape missing**: `searchCode` wraps user query in `%..%` without escaping `%` and `_`. Logic injection, not SQL injection (queries are parameterized)
- **exported field type mismatch**: Interface says `boolean`, SQLite returns INTEGER (0/1). `as CodeSymbol[]` cast hides this. Works due to JS truthiness but TypeScript type is wrong
- **Stale index: header lie**: Comment says "refresh on jarvis_dev branch switch" but jarvis-dev.ts has zero calls to rebuildIndex. Only boot-time indexing exists
- **extractSymbols crash on deleted file**: readFileSync throws ENOENT if file deleted between discovery and extraction. No try/catch in transaction loop
- **Tests cover only extractSymbols**: searchCode, symbolsInFile, codeSearchTool.execute() all untested. `typeof` guards in tests mask import failures as silent passes

### Patterns Confirmed

- Parameterized queries used correctly throughout (no SQL injection)
- `CREATE TABLE IF NOT EXISTS` is safe across restarts
- LIKE `%prefix` prevents index use but irrelevant at 4500 rows
- Sync FS APIs acceptable at boot-time only

**Why:** Code search is used by Jarvis during self-improvement workflow (jarvis_dev). Stale index means Jarvis searches pre-edit code.
**How to apply:** When reviewing future code-index changes, verify branch-switch re-indexing and LIKE escape handling.
