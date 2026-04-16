# Integration Checklist

**MANDATORY for every code change.** A feature is not "done" until every applicable touch point is updated in the same commit. Missing integration points are the #1 source of bugs in this codebase — see `feedback_incomplete_migration.md`.

The pre-commit audit (below) is non-negotiable, even when the code will be reviewed.

---

## Pre-commit audit (every commit)

Before calling `git_commit`, run this self-check:

1. **Grep sweep**: `grep -rn "NewSymbolName" src/` — does the new name appear in every expected integration point for its change type?
2. **Typecheck**: `npx tsc --noEmit` — zero errors
3. **Affected tests**: `npx vitest run <affected-files>` — all green
4. **If any integration point is missing**: fix it in THIS commit. Do not defer.
5. **Grep-sweep for anti-patterns**: if this is a bug fix, search the codebase for the same pattern elsewhere (timezone bugs, hardcoded counts, scope misconfigs always exist in multiple files)

> This audit applies to ALL code you write, even code that will be reviewed by Fede before merge. Catching issues yourself is 10x faster than finding them in review.

---

## Change type: new or modified TOOL

| #   | File                                   | What to add                                                                                       |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | `src/tools/builtin/{name}.ts`          | Tool handler with description, params, execute                                                    |
| 2   | `src/tools/sources/{category}.ts`      | Import + **both** `allTools` and `tools` arrays in `registerTools()`                              |
| 3   | `src/messaging/scope.ts`               | Add to correct scope group (`GOOGLE_TOOLS`, `CODING_TOOLS`, `WORDPRESS_TOOLS`, `CRM_TOOLS`, etc.) |
| 4   | `src/inference/guards.ts`              | If read-only → `READ_ONLY_TOOLS` set (line ~15)                                                   |
| 5   | `src/memory/auto-persist.ts`           | If tool returns content needed for follow-up turns → Rule 2b (line ~140)                          |
| 6   | `src/runners/write-tools-sync.test.ts` | If read-only and in a scope group with writes → add to that group's READ_ONLY set                 |
| 7   | `src/tools/builtin/{name}.test.ts`     | Mock `googleFetch` / `fetch` / external APIs — cover happy path + error paths + edge cases        |

**Reference example**: `gdocs_read_full` in commit `646bde0` — touches all 7 points.

---

## Change type: new RUNNER

| #   | File                                | What to add                                                 |
| --- | ----------------------------------- | ----------------------------------------------------------- |
| 1   | `src/runners/{name}-runner.ts`      | Implement `Runner` interface                                |
| 2   | `src/dispatch/dispatcher.ts`        | Register the runner                                         |
| 3   | `src/dispatch/classifier.ts`        | Classification case (what user messages route here)         |
| 4   | `src/config/constants.ts`           | Max rounds, token budget, timeouts — with env var overrides |
| 5   | `src/runners/{name}-runner.test.ts` | Mock inference + tools                                      |

---

## Change type: new DB TABLE

| #   | File                | What to add                                                                         |
| --- | ------------------- | ----------------------------------------------------------------------------------- |
| 1   | `src/db/schema.sql` | `CREATE TABLE IF NOT EXISTS` + indexes                                              |
| 2   | Apply live          | `sqlite3 ./data/mc.db < src/db/schema.sql` (additive changes only — never reset DB) |
| 3   | Access code         | All queries through `getDatabase()` singleton, never raw `sqlite3` CLI in tools     |

**Never reset `data/mc.db`** — it contains irreplaceable Jarvis memories, conversations, embeddings. Additive schema changes (`IF NOT EXISTS`) apply live with no reset needed.

---

## Change type: new SCOPE GROUP

| #   | File                          | What to add                                                             |
| --- | ----------------------------- | ----------------------------------------------------------------------- |
| 1   | `src/messaging/scope.ts`      | New `{NAME}_TOOLS` array + activation regex in `DEFAULT_SCOPE_PATTERNS` |
| 2   | `src/messaging/router.ts`     | If group needs special timeout/budget → add to scope-aware logic        |
| 3   | `src/messaging/scope.test.ts` | Regex activation tests                                                  |

---

## Change type: new ENV VAR

| #   | File                                         | What to add                                                   |
| --- | -------------------------------------------- | ------------------------------------------------------------- |
| 1   | `src/config.ts` or `src/config/constants.ts` | Read with `int()` / `float()` / `optional()` + fallback value |
| 2   | `.env.example` (if exists)                   | Document the var with default                                 |
| 3   | `CLAUDE.md`                                  | If it changes infra invariants (dep count, service behavior)  |

---

## Change type: new DEPENDENCY

| #   | File           | What to add                                                                                         |
| --- | -------------- | --------------------------------------------------------------------------------------------------- |
| 1   | `package.json` | `npm install <pkg>`                                                                                 |
| 2   | `CLAUDE.md`    | Update the **core + messaging deps** line — currently "13 core + 2 messaging"                       |
| 3   | Usage code     | Import with `import type { X } from "pkg"` when types-only, prefer dynamic import for optional deps |

Never add a dep without discussion — each transitive dep is a supply-chain risk.

---

## Change type: modified TOOL SIGNATURE

1. `grep -rn "functionName\|toolName" src/` → update ALL callers
2. Update type definitions (interfaces, return types)
3. Update tests on both sides of the contract
4. If the tool is in a scope group, verify behavior in that group's tests

---

## What "applicable" means

Not every change touches every point. The checklist is exhaustive; your change might only hit 2-3 rows. Examples:

- **Writing a new read-only tool**: rows 1-7 of TOOL table apply (6 skipped for non-persisted content)
- **Adding a new config value**: only ENV VAR table applies
- **Renaming a function with 5 callers**: TOOL SIGNATURE table + affected test files

**When in doubt, run the grep sweep.** If your new symbol appears in fewer files than expected, you probably missed an integration point.
