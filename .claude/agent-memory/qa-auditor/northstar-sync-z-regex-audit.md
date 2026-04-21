---
name: northstar-sync description section regex audit
description: Audit of Jarvis-authored fix for extractDescriptionSection \z bug; found MAJOR sub-heading truncation in new regex
type: project
---

# NorthStar Sync `\z` Fix Audit (2026-04-21)

## Context

Jarvis tried to fix a field-extraction bug where `\z` (Ruby anchor) was being treated as literal `z` in JS. Top-level Claude then corrected Jarvis's fix, replacing `\z` with `(?:^|\n)##...(?=\n##|$)` without `m` flag. Also raised `jarvis-dev` timeout from 120s→300s, added GIT_TIMEOUT_MS=60s, and improved ETIMEDOUT/SIGTERM detection in catch branch.

## Verified Behaviors (PASS)

- Node `execFileSync` on timeout: sets BOTH `code === 'ETIMEDOUT'` AND `signal === 'SIGTERM'` (confirmed empirically)
- Non-timeout failures: `code === undefined`, `signal === null`, `status` has exit code
- External SIGKILL (OOM): `signal === 'SIGKILL'` — NOT caught by current detection; falls through to "FAIL"
- vitest v3.2.4 fail-summary format: `Tests  N failed | M passed | K skipped` — regex correctly parses this
- `/\/rest\/v1\/(visions|goals|objectives|tasks)\b/` correctly excludes `kb_entries` and doesn't false-match `goals_archive` (because `_` is a word char, so `\b` breaks)
- `extractField("Target")` does NOT falsely match `Target_id:` or `target_date:` (colon boundary enforces exact field name match)
- `extractField` with case-insensitive matches `TARGET:` and `target:` equally — redundant aliases like `extractFieldWithAlias("Status", "status")` are dead code but harmless

## BUG FOUND (MAJOR)

`extractDescriptionSection` regex stop-lookahead `(?=\n##|$)` truncates at any `###` sub-heading because `##` is a prefix of `###`. If a local file has:

```
## Descripción
Intro paragraph.

### Subsection
Sub content.

## Otra
```

Result: only "Intro paragraph." is extracted. Sub-content is dropped.

Fix: use `(?=\n##[^#]|$)` or `(?=\n## |$)` (require space or non-hash after the two hashes).

## Blast-Radius Check

- `extractField`/`extractDescriptionSection`/`extractFieldWithAlias` are ONLY called inside `northstar-sync.ts` (grep confirmed)
- `run()` default timeout change 10s→60s affects: `checkout`, `checkout -b`, `status`, `diff`, `add`, `commit`, `branch --show-current`. All benefit from more headroom. No shrinking anywhere.
- `push` kept at explicit 30s (not using 60s default) — acceptable for networked fast-fail

## Test Coverage Gap

New "## Descripción multi-line" test contains no `z` character — proves it would catch the `\z` bug. But does NOT test:

- Section with `###` sub-heading (would SILENTLY pass and hide the sub-heading truncation bug)
- Section that is NOT the last (mid-file with trailing `## Other`)
- Case-insensitive uppercase `## DESCRIPCIÓN`
- No-accent `Descripcion`
