# Rulings 1–5 — work-in-progress handover (2026-10-03)

Branch `wip/rulings-1-5` carries the UNSHIPPED build of operator rulings 1–5 (ruled
2026-10-01, see `next-sessions-queue.md` §rulings). Nothing here is deployed; `main` and
the live service (`b402df9`) do not contain it. Delete this file when the work merges.

## State per ruling

| Ruling | What | State |
| --- | --- | --- |
| 1 | Expiry notice at the 5-minute confirmation TTL | Built, fix round done, NOT re-audited |
| 2 | Confirm at schedule creation when a high-risk tool is included | Built, fix round done, NOT re-audited |
| 3 / 3a / 3b / 3c | Credential-style facts and project credentials hidden from the model, used by name (`$SECRET_<NAME>` in `shell_exec`, `{{SECRET_<NAME>}}` in `http_fetch` / browser tools); the old "refuse to store" code removed | Audit round 2 = FAIL; fix round coded and tested (below); hand mutants NOT run; NOT re-audited |
| 4 | Changed-files-only tests in `jarvis_test_run` / `vps_deploy` / `jarvis_dev action=pr` | Built, fix round done, awaits the combined audit |
| 5 | Docker in the shell gate: reads + `docker exec supabase-db psql` only | Built, fix round done after an audit FAIL, NOT re-audited; its test, mutant and 110,000-command differential results must be re-run (they came from a window in which the host was damaged) |
| 6 | Shell mount namespace | PARKED by the operator. Not in this branch. See `postmortem-2026-10-01-host-mount-leak.md`. Do not rebuild it here. |

## Ruling 3 fix round (answers audit round 2)

All coded with tests; typecheck 0; 13 scoped test files green (965 passed, 5 todo).

- Scrub also catches JSON-escaped forms (once and twice) of a value — `src/lib/secret-refs.ts`.
- Scrub runs BEFORE output truncation — `src/tools/builtin/shell.ts`, `src/tools/builtin/http.ts`.
- Error path: `scrubThrown` in `src/tools/registry.ts` (string throws; read-only `message`; untouched errors rethrown as the same object).
- Every entry under a project's `credentials` field is a secret regardless of key name (`isProjectSecret`).
- `shell_exec` with an unknown `$SECRET_<NAME>` is refused.
- Scrub at the writers: `pushToThread` (router), both memory backends' `retain`, JME `writeEpisodic`.
- Placeholder is JSON-safe (no quotes).
- Fixtures on this workstream's lines are synthetic and runtime-assembled.
- To review: `buildIndex` returns an empty index when the store tables do not exist ("no such table"); other errors still throw.

Still owed for ruling 3:

1. One hand mutant per fix (revert the fix, run the ONE covering test file, expect RED, restore exactly). 18 were planned: placeholder, JSON-escape scrub, scrub-before-cut (shell stdout, shell error path, http), error path ×2, credentials-field mask ×2, string-throw scrub, longest-first sort, `deleteProject` cache invalidation, bridge log scrub, unknown-reference refusal, the four writers.
2. A separate audit (not the implementer) — production path, persistence of resolved values, every reader of facts/projects, scrub escapes and truncation, error path, credentials field, unknown references, pasted credential in conversation/memory stores, public-repo fixtures.

## Order to finish

1. Ruling 3 mutants → re-audit ruling 3.
2. Re-audit ruling 5 (re-run its tests and the differential against `main`).
3. Re-audit rulings 1–2.
4. Combined audit of rulings 1–5.
5. ONE paid `npm run eval:gate -- --run` on the final text; do not ship on FAIL. Model-visible strings changed by this work: the hidden-value placeholder, the unknown-reference refusal, `project_get` first description line, the ruling 5 shell description lines, the ruling 4 coding-section wording.
6. Docs (`PROJECT-STATUS.md`, `README.md` baselines, queue), merge to `main`, operator deploy.

## Rules that apply to this work

- Scoped vitest only (literal test-file paths); the pre-commit hook is the one full run.
- No real credential, project slug, key name or e-mail in fixtures — this repo is public.
- Tests that need a database use a temp db with synthetic rows; the live `mc.db` is never written and no stored value is ever printed.
- No new dependencies, no schema change without `SCHEMA_MIGRATIONS`.
- Deploy is operator-only.

## Known residuals of ruling 3c (to state at ship time)

By-name use is not bound to a destination host; shell transforms of a value (base64, rev,
cut) are not scrubbed; values under 8 characters are not scrubbed; screenshots cannot be
scrubbed; the day-log line written when a message arrives precedes any save; cuts made
inside external MCP servers happen before the scrub; container runners cannot use by-name
references; project `credentials` entries are masked whole, usernames included.

## Open notes

- `http_fetch` description still says the tool sends no secrets, which no longer matches `{{SECRET_<NAME>}}` substitution (description change → eval gate).
- Ruling 5: start/stop-type docker commands are unchanged from `main` (allowed); commands that redirect the daemon (`-H`, `--context`, `--config`, `DOCKER_HOST=`) are refused. Both await operator confirmation.
- Rulings 1–2: the "no confirmation channel" error suggests `interactive:false`, which is now refused for risky `schedule_task`; background `batch_decompose` declaring high-risk tools is not refused.
