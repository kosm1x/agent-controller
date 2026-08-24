# Usability Phase 4 R1 audit — continuity & recovery (2026-08-23)

Scope: uncommitted diff, 15 files + 2 new (`src/messaging/thread-pins.ts`). Verdict **FAIL** (4 Critical). tsc clean, 405/405 tests green, 5/5 mutation probes RED — the tests are real, they just guard a dead path in one case.

## C1 — the recovery feature ships on the provider the box does NOT run

`fast-runner.ts:1205` `if (getConfig().inferencePrimaryProvider === "claude-sdk") { … return at 1341 }`; Phase 4.3's auto-resume (1396) + auth retry (1476) sit AFTER `inferWithTools` at 1375. Live process env (`/proc/<MainPID>/environ`) = `INFERENCE_PRIMARY_PROVIDER=claude-sdk` → both blocks unreachable in production. The tests mock `getConfig` → `"openai"` (`fast-runner.integration.test.ts:29`), so they are green on the branch prod never takes. The plan itself named `src/inference/claude-sdk.ts` as the 4.3 file.

**Doctrine (recurrence #3):** when a runner has TWO provider branches, read `/proc/<MainPID>/environ` for the live flag BEFORE trusting a green test; a test that mocks the provider is a test of the OTHER branch. Cf. `v84-honest-done` ("feature lives in the else of the mode").

## C2 — enforcement exemption parsed by a weaker grammar than `/bin/sh`

`isReadOnlyDiagnostic` (flailing-guard.ts:340-378) splits segments on `;|&&|\|\||\|` only — **newline is not a separator**, and `env` (line 290) / `find` (280) / `ip` (245) / `date` (261) / `git branch|remote` (326-327) are on the read-only list. Empirically (both `validateShellCommand` ALLOWED and exemption EXEMPT): `journalctl -u caddy\ncurl -X POST …` (the original flailing class escapes with a diagnostic first line), `env curl …`, `find /x -delete`, `find . -exec rm {} +`, `git branch -D`, `ip link set eth0 down`, `date -s`. The docstring's claim "never mutation slips the guard" is false. `$()`/backticks also pass the parse but are blocked upstream by `validateShellCommand` — calibrate, don't overstate.
False negative the other way: `git -C /path log` → `sub` = the path (line 371) → enforced.

**Doctrine:** a shell-shape allow-list must mirror `/bin/sh` splitting (newline is a separator) and must exclude program-runner binaries (`env`, `xargs`, `timeout`, `nice`, `nohup`) and multi-mode binaries whose read-only subcommand also mutates (`find -delete/-exec/-fprint`, `git branch -D`, `ip`, `date -s`).

## C3 — hard stop is channel-scoped, not thread-scoped

`router.ts:1755` `if (pending.channel === msg.channel)` cancels ALL pending tasks on the ADAPTER, while `threadKey()` (router.ts:699) isolates per WA group+sender and per community-manager email sender. Live: `EMAIL_COMUNIDADES_MODE=community-manager` → any stranger emailing "Detente." cancels every other sender's running task on that mailbox. Old code had the same predicate but `break` after one; Phase 4.4 turned it into a fan-out. Fix: match `pending.tk === tk`.

## C4 — `^`-anchored stop regex + unstripped WA group prefix

`router.ts:1749` `const text = msg.text.trim()`; every sibling intercept strips `/^\[Grupo:.*?\]\n?/i` (router.ts:1502, fast-path.ts:58, confirmations.ts:124, feedback.ts:30) because `whatsapp.ts:343` prepends it. So "Para ya" from a WA group never matches CANCEL_*_RE and falls through to the fast path — the exact #11367 failure 4.4 exists to kill. (WA is currently logged out via `UnsetEnvironment=WHATSAPP_ENABLED`, so dormant, not observable.)

## Warnings worth carrying

- **Doc read-back FP**: `verifyDocWrite` reads the WHOLE document then runs `confirmedMismatch(data, text)` (readback-verifiers.ts:212). Probed: confirmed `34%` / label "Margen operativo Q3", doc has an untouched old line "El margen operativo de 2023 fue de 21%" → gate FAILS a correct, unrelated append. Sheets is safe — its reread is scoped to `updates.updatedRange`.
- **Test asserts only the empty branch**: the only hard-stop assertions are `Detenido: no había tareas activas` / `/^Detenido:/` — no N≥1 case. `/^Detenido:/` passes on the zero branch, so the plan's "3/3 stops honoured" is unverified.
- **Orphan checkpoint shadows a richer one**: `findRecentCheckpoint` (checkpoint.ts:103) is global + newest-wins; boot-written orphan rows (index.ts:180-190, `toolsCalled: []`) outrank a real `max_rounds` checkpoint from minutes earlier, and `userMessage` is the 60-char-truncated `Chat: <title>`.
- **Auto-resume vs the router's abandon timer**: `TASK_TIMEOUT_ABANDON_MS = 660_000` (router.ts:151) deletes the pendingReply and sends "Se agotó el tiempo"; a second leg can double wall time past it → false timeout + dropped result. Resume also reuses `onTextChunk` with no `streamController.reset()` (the scope-miss re-run path does reset).
- **Auth canned line is content-replacing and provider-blind**: `AUTH_ERROR_RE` (fast-runner.ts:147) matches a bare `401` anywhere in `result.content`; on the second failure it REPLACES the whole reply with "Credenciales de Anthropic…" (line 1507) — a task ABOUT a 401 that exits non-natural loses its real answer.
- **PIN_CAP=20 is shared** between URLs and confirmed figures, and `bindTaskConfirmedFigures` reads the same list → a chatty URL day silently evicts the figures the 2.3 gate depends on. `pinsByThread` also never drops a thread key (one entry per external email sender, forever).

## Method notes that worked

- `npx tsx` one-off probes importing the real predicate (`isReadOnlyDiagnostic`, `validateShellCommand`, `confirmedMismatch`) gave quotable EXEMPT/ALLOWED tables — far better than reasoning about the regex.
- Pairing the exemption table with the SECURITY policy table stopped 2 findings from being overstated (`$()`/backticks are blocked upstream).
