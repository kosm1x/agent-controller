# Usability Phase 4 R3 audit — R2 folds verified (2026-08-23)

Scope: uncommitted diff, 22 files. tsc clean (src AND scripts), 461/461 scoped green,
3/3 mutation probes run, working tree byte-restored (md5, 22/22). Verdict **FIX-FIRST**
(2 Critical). R2's folds all HOLD as written — the criticals are a NEW class member and
a metric that can never be non-zero.

## R2 folds that HOLD (probed, not assumed)

- **C1 (`&` separator)** — real fold. `stripped.split(/[\n;&]|\|\||\|/)`
  (flailing-guard.ts:363). Probe: `journalctl -u caddy & curl -X POST …` → ENFORCED;
  `&&` still exempt (empty middle segment skipped); `2>&1` pre-stripped and survives.
  **Mutation probe: `[\n;&]`→`[\n;]` ⇒ 3 tests RED.** Genuinely pinned.
- **C2 (SDK resume continuity)** — `Herramientas YA ejecutadas … ${sdkResult.toolCalls}`
  at fast-runner.ts:1359, interpolated BEFORE `mergeSdkLegs` (so it's leg-1's list —
  correct). Leg-1 body preserved when leg-2 body <200 and leg-1 ≥200.
  **Mutation probe: delete the line ⇒ `expect(resumeArgs.prompt).toContain("shell_exec")`
  RED.** Pinned.
- **W3/W4/W6** — all probed true: the 5 `DIAG_MUTATING_FLAGS` rows + `uniq IN OUT` all
  ENFORCED in their canonical spelling; `[timeout` gone from `sdkCapped`;
  `contRow("User: Contin%")` is now a single term (live DB: `LIKE` 136 = `LIKE` 136,
  INTERSECT 136 — the 2× was real and is gone).
- **Original incident commands still EXEMPT** (the feature works): `journalctl -u caddy |
  grep -i ant-colony`, `systemctl status caddy`, `grep -i ant-colony /etc/caddy/…`,
  `journalctl -u caddy --since '1 hour ago' | tail -50`.
- **Greedy `[Grupo:` strip is SAFE** — producer is `whatsapp.ts:343`
  `` `[Grupo: …, De: …]\n${text}` ``: body is ALWAYS on a new line and `.` never crosses
  `\n`, so `.*\]` cannot reach into user content. Over-strip is structurally impossible.
- **`interceptTaskCancel` position** — router.ts:2426, BEFORE `interceptPendingConfirmation`
  / `interceptBriefingVerdict` / `interceptPureFeedback` / `interceptConversationalFastPath`
  / `submitInboundTask`. The 4 intercepts ahead of it are all narrow (`interceptAgentCancel`
  needs `^cancela\s+agente`) — none swallows a stop verb.
- **≤2 legs**: auth retry is gated on `!sdkAutoResumed`. `input.title` is `title: string`
  (required) on `RunnerInput` — no undefined risk in the double-cap `writeCheckpoint`.

## C1 — enumeration has now failed THREE rounds; GNU option bundling defeats its own fix

Same class as R1-C2 / R2-C1, third recurrence. Two independent proofs, both
EXEMPT + shell-ALLOWED, both empirically executed:

- **Option bundling defeats `DIAG_MUTATING_FLAGS`.** `(^|\s)-o\b` never matches a
  bundled flag: `sort -uo VICTIM in.txt` **overwrote a real file in /tmp** and is
  EXEMPT (canonical `sort -o` is correctly enforced). Same for `dmesg -Cw`, `dmesg -cw`,
  `ss -Kn`. The `\b` after a single letter cannot fire inside `-Cw`.
- **4 binaries on DIAG_SIMPLE have write/exec modes with no row at all**, all proven live:
  `xxd IN OUT` (overwrote a victim file; `xxd -r hex out` writes arbitrary BINARY — same
  two-positional contract `uniq` got a rule for), `hostname NAME` / `-F file` (sets the
  system hostname; mc runs as root — `hostname --help`: "set host name (from file)"),
  `rg --pre CMD` **and** `rg --hostname-bin CMD` (both executed my script;
  `rg --pre /bin/rm doomed target` **deleted every file in the directory**),
  `file -C -m X` (wrote X.mgc).

The docstring's "the failure mode is 'blocked like today', never 'mutation slips the
guard'" (flailing-guard.ts:~334) is false. R1 found `\n`; R2 found `&` + 5 flag rows;
R3 finds bundling + 4 binaries. **Per the 3-strike rule this is architectural, not
regex-shaped** — recommend inverting to a positive shape allow-list (refuse any segment
with ≥2 non-flag positional args across ALL of DIAG_SIMPLE; drop `xxd`/`hostname`/`rg`/
`file`/`sort`/`uniq` — every binary that has a write or exec mode at all) instead of a
6th subtraction round.

## C2 — `stops_honoured` is a metric that can never be non-zero

`interceptTaskCancel` (router.ts:1788-1789) does `sendToChannel` + `pushToThread` and
**no `.retain()`**. `pushToThread` (router.ts:881-915) is in-memory only. The 5 retain
sites in router.ts are 1945 / 2000 / 2892 / 3309 / 3374 — none inside 1745-1796.
So `usability-metrics.ts:260` `contRow("%Jarvis: Detenido:%")` returns 0 forever.

**Decisive historical proof** (independent of the new code): the PREVIOUS ack used the
identical pushToThread-only path for months —
`LIKE '%Jarvis: Tarea cancelada.%'` = **0 rows**, while `LIKE '%[Task cancelled by%'`
(router.ts:3372, the one cancel path that DOES retain) = **1 row**. The 12 live rows
containing "Detenido" are all the adverb *detenidamente* in user prompts.
Fix: add a retain beside 1789 (mirror 1998-2007), or delete the metric.

**Doctrine:** when a metric counts a STRING the code emits, grep for the PERSIST call on
that exact emit path — `sendToChannel`+`pushToThread` is delivery, not persistence.
Prove it with the metric's PREDECESSOR string over live history: 0 rows for a
months-old string is the tell.

## Warnings

- **R2-W5's fold is UNPINNED.** thread-pins.test.ts:195-206 asserts
  `getPins(stale)).toHaveLength(0)` — but `getPins` calls `prune()`, which empties a
  stale list on READ whether or not the sweep exists. **Mutation probe: deleted the whole
  global sweep loop from `addPin` ⇒ 31/31 STILL GREEN.** The code is correct
  (`.every()` is vacuously true on `[]`, so empty keys are deleted); only the test cannot
  fail. Assert map SIZE, not per-key length.
- **≤2 legs has a 3-leg hole.** `sdkAutoResumed = true` is set AFTER the resume await
  (fast-runner.ts:~1392). If the resume THROWS, the flag stays false, `sdkResult` is
  still leg-1, and leg-1's cap text `[error_max_turns` satisfies `sdkAuthFailed`'s second
  clause — so a leg-1 partial merely CONTAINING `401` (`AUTH_ERROR_RE` = `\b401\b`, line
  147) fires a third full-`maxRounds` leg. The comment "Never both legs (≤1 extra call
  per run)" is then false. Hoist a `recoveryLegUsed` flag set BEFORE the await.
- **Checkpoint consumer is thread-blind, and Phase 4 adds two producers.**
  `findRecentCheckpoint()` (checkpoint.ts:100) is global newest-wins and the `Checkpoint`
  interface carries no channel/threadKey; the only consumer (router.ts:2230) injects it
  into ANY thread whose message matches `CONTINUATION_RE`. Pre-existing, but Phase 4 adds
  the boot-orphan writer (index.ts:172-201) and the SDK double-cap writer. TTL is 30 min
  and there are currently 0 orphaned chat tasks, so exposure is small today. Add
  `threadKey` to the checkpoint and filter.
- **`no_agotes_msgs` / `sigo_asks` double-count auto-persist twins.** Each exchange can
  write two `conversations` rows (`source='router'` + `source='auto-persist'`). Live 45d:
  `%no agotes%` reported 10, distinct `created_at` = 7 (~43% inflation, variable factor).
  `continua_msgs` is immune (anchored `User: Contin%`; auto-persist rows start
  `[AUTO-PERSIST`). Add `AND source <> 'auto-persist'`.

## Info / residuals confirmed acceptable

- `written_text: text.slice(0, 800)` (google-docs.ts:646) — contradiction past 800 chars
  invisible; fail-OPEN but documented.
- `CANCEL_LEADING_RE` fires on any `Detente, …` opener — deliberate per plan.
- `continua_msgs` counts any message STARTING with "Contin", not the stated
  bare-continúa-after-failure criterion (136 all-time: 49 ≤20 chars, 33 >60 chars).
  Trend proxy, not the criterion.

## Method notes

- md5 baseline of all 22 files BEFORE the first mutation; `md5sum -c` after each restore.
  3 destructive probes, tree byte-identical at the end.
- The highest-yield probe this round was running the REAL binary against a real victim
  file in /tmp (`sort -uo`, `xxd IN OUT`, `rg --pre /bin/rm`) rather than reasoning about
  the flag regex. Two of the four escapes (bundling, `rg --hostname-bin`) I would not
  have believed from the manpage alone.
- Grepping the metric's PREDECESSOR string across live history is what turned
  "stops_honoured looks unwired" into a proof.
