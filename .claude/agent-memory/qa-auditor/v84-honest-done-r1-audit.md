# V8.4 "Honest Done" — completion ledger (R1, 2026-08-16)

Scope: uncommitted tree — new `src/lib/v8-4/` (schema/gates/gate-check/landing/numbers/consumer/stop-hook + tests, ~3k LOC), `scripts/gates-validate.ts`, `mc-ctl cmd_gates`, wiring into dispatcher / claude-sdk / prometheus / rituals / runners / registry / rule-of-two.

**Verdict: PASS-with-warnings for shipping DORMANT (`TASK_GATES_MODE` unset). FAIL to arm shadow/enforce without fixing C1+C2.**
tsc clean; 62/62 v8-4 tests green.

## Doctrine earned

1. **A second exec path around a guarded tool is a capability-envelope widening, even when the agent "already has shell".**
   `shell_exec` (`src/tools/builtin/shell.ts`) enforces DENY_COMMANDS (`rm`/`systemctl`/`sqlite3`/`kill`/`chown`/`crontab`…), blocks `$()`/backticks/process-substitution, blocks reads of `.env`/credentials/`.ssh`, guards mutating git on the primary checkout, blocks unscoped `vitest run`, and redacts secrets in logged output. V8.4's `runShellCheck` (`gate-check.ts:71-84`) spawns `/bin/sh -c` with NONE of them. "Jarvis already has host shell" was the design's justification — it was **false at the guard layer**. Always diff the NEW exec path against the EXISTING tool's guard list, not against the capability's name.

2. **An LLM-authored regex on an LLM-sized haystack is a whole-process wedge.**
   `expectMatches` (`gate-check.ts:43-53`) runs `new RegExp(planner_string).test(output)` over up to 256 KB, on the main thread, in the task-completion path AND inside the Stop hook. Node has no regex timeout. Catastrophic backtracking = mission-control (API + scheduler + everything) hangs until restart. `try{}catch{}` around `new RegExp` catches *compile* errors only, never *match* time.

3. **A check without a `cwd` measures the harness's tree, not the work's tree.**
   All three `evaluateLedger` call sites (`consumer.ts:167`, `consumer.ts:221`, `stop-hook.ts:78`) omit `cwd` ⇒ `process.cwd()` = mission-control. nanoclaw mounts mission-control **`:ro`** and its edits live in the container / on a pushed branch. So a host-run plan gate reads the PRE-work tree: `npx tsc --noEmit` passes for reasons unrelated to the child ⇒ silent success; `grep -q newFn src/x.ts` fails though the branch landed ⇒ false demote. The landing gate exists precisely for this; plan gates did not inherit the lesson.

4. **A progress-hash loop bound is only a bound if the hash is monotone.**
   `stop-hook.ts:86-93` keys `MAX_HOOK_BLOCKS` on the SORTED SET of failing gate ids; a *different* set resets `blocks` to 1. Two flaky checks that alternate ⇒ unbounded blocking, capped only by `maxTurns`/`error_max_turns`. Bound the total blocks per task too, not just the same-set streak.

5. **"Dormant" must be measured at the FIRST statement, not at the mode check.**
   `applyCompletionLedger` runs the numbers audit at `consumer.ts:112-154`, *before* `const mode = gatesMode()` at `:157`. With the mode unset every task with tool evidence still gains `tasks.output.numbers_audit` + a `numbers.audited` trace row. Intentional and tested (`consumer.test.ts:166` says "beyond the numbers audit"), harmless downstream (`extractDeliverableText` ignores unknown keys, `hasDeliverableField` blocks raw-JSON delivery) — but it is a live-path change on ungated traffic and the phrase "ships dormant" hid it.

6. **`x !== undefined` is not "the field was attested".** `parsed.success ?? true` + `selfAttested = parsed.success !== undefined` (`nanoclaw-runner.ts:182-184`, `heavy-runner.ts:241-243`): `"success": null` is selfAttested AND `null ?? true` ⇒ clean `completed`, no concerns. The `as {success?: boolean}` cast validates nothing. Use `typeof x === "boolean"`.

7. **A ledger evaluation awaited before the slot release is a slot lease extension.** `dispatcher.ts:895` awaits N gates × 60 s serial; `takeToolEvidence` at `:1055` then `releaseContainerSlot()` at `:1059`. No total-time cap on the evaluation.

## Verified-clean (do not re-flag)

- **ALS / concurrency**: `RunToolContext.taskId` is set fresh per `enterRunToolContext` (`rule-of-two.ts:439-445`) while `toolsSoFar` still inherits — nested swarm children get their own id; `drainContainerQueue` still wraps in `outsideRunToolContext` (`dispatcher.ts:254`); `takeToolEvidence` (`:1055`) runs in `finally` BEFORE the drain fires, on every exit path incl. the two `requiredTools` early returns. No cross-contamination.
- **mc-ctl SQL**: `set-ritual` validates `schedule_id` against `^[a-zA-Z0-9_.-]{1,64}$` and doubles single quotes in the payload (`${normalized//\'/\'\'}`); payload is pre-validated by `scripts/gates-validate.ts` (exit 2 on reject). No injection.
- **Migrations**: `ensureV84Tables` is CREATE IF NOT EXISTS; the `scheduled_tasks.gates` ALTER is guarded by a `pragma_table_info` probe. Idempotent. CHECK constraints match the TS union types.
- **Dormant SDK shape**: `stopHookEnabled` short-circuits before any DB hit, factory returns null, the `hooks` key is spread-omitted (`claude-sdk.ts:741-743`).
- **Landing tests inject `exec`** — no network in the suite.
- **`met` requires evidence** is enforced at the writer (`gates.recordGateResult:284`) AND re-counted as pending by `ledgerVerdict:339`. Abandoned is final both directions. ABANDON regex cannot self-match the instruction text (`<gate id>` has no `<` in the id charset) nor `ABANDONED:` in the enforce footer.
