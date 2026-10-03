## Before

<!-- What was wrong or missing, with evidence (failing test, log line, CI run). -->

## After

<!-- What is true once this merges. -->

## How

<!-- The change, file by file where it helps review. -->

## Checks

- [ ] `npm run typecheck`: zero errors
- [ ] `npx vitest run <changed test files>`: green (CI runs the full sharded suite)
- [ ] `npm run eval:gate -- --run` owed? Required before shipping any model-id, system-prompt or tool-description change (CLAUDE.md). State: not needed / run (PASS) / owed
- [ ] Deploy needed? (operator runs scripts/deploy.sh) State: no / yes (what to verify after)
- [ ] Session log row added to `docs/ROADMAP.md`
